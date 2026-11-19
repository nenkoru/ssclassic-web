// "Serious Survivors" page overlay (the game logic is Rust: rust/se1-mod/src/survivors.rs).
//   ?mode=survivors[&level=Levels/KarnakDemo.wld]
// The mod posts JSON messages through Module.se1ModUi (hud / start / dead, level-up offers inside
// hud); the player's choice goes back with Module._SE1Mod_UiSend(index).
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  if (q.get('mode') !== 'survivors') return;
  Module.se1Survivors = 1;
  if (q.get('svxp')) Module.se1SurvivorsXp = +q.get('svxp');   // debug/test: start with XP
  Module.se1SurvivorsLast = null;                                 // last HUD message (tests read it)
  if (!(Module['arguments'] || []).some(function (a) { return a === '+level'; }))
    Module['arguments'] = (Module['arguments'] || []).concat(['+level', q.get('level') || 'Levels/KarnakDemo.wld']);

  var css =
    '#svv{position:fixed;inset:0;pointer-events:none;font:600 14px/1.3 system-ui,sans-serif;color:#fff;z-index:20}' +
    '#svv .top{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:14px;align-items:center;' +
    'background:rgba(10,14,6,.72);border:1px solid #6b8f2a;border-radius:6px;padding:6px 12px;text-shadow:0 1px 2px #000}' +
    '#svv .bar{width:240px;height:10px;background:#222;border:1px solid #567;border-radius:5px;overflow:hidden}' +
    '#svv .bar i{display:block;height:100%;background:linear-gradient(90deg,#3f9fff,#a0e8ff)}' +
    '#svv .abil{position:absolute;left:10px;top:60px;background:rgba(10,14,6,.6);border-radius:6px;padding:6px 10px;min-width:160px}' +
    '#svv .abil div{white-space:nowrap}#svv .procs{position:absolute;right:12px;top:60px;text-align:right;color:#ffd75e;text-shadow:0 1px 2px #000}' +
    '#svv .modal{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);pointer-events:auto}' +
    '#svv .modal h2{position:absolute;top:18%;width:100%;text-align:center;margin:0;font-size:30px;color:#ffd75e;text-shadow:0 2px 6px #000}' +
    '#svv .cards{display:flex;gap:16px}#svv .card{width:200px;min-height:150px;padding:14px;border-radius:8px;cursor:pointer;' +
    'background:linear-gradient(#2b3a16,#14200a);border:2px solid #8fbf3a;box-shadow:0 4px 18px rgba(0,0,0,.6)}' +
    '#svv .card:hover{border-color:#ffd75e;transform:translateY(-3px)}#svv .card b{display:block;font-size:17px;color:#ffd75e;margin-bottom:6px}' +
    '#svv .card small{color:#c8d8a8;font-weight:500}#svv .card em{float:right;color:#8fbf3a;font-style:normal}';

  var root, elLevel, elBar, elTime, elKills, elAbil, elProcs, elModal, elCards, elTitle, offer = null;
  function el(tag, cls, parent, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; if (parent) parent.appendChild(e); return e; }
  function build() {
    if (root) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = el('div', null, document.body); root.id = 'svv';
    var top = el('div', 'top', root);
    elLevel = el('span', null, top, 'LV 1');
    var bar = el('div', 'bar', top); elBar = el('i', null, bar);
    elTime = el('span', null, top, '0:00'); elKills = el('span', null, top, '0 kills');
    elAbil = el('div', 'abil', root); elProcs = el('div', 'procs', root);
    elModal = el('div', 'modal', root); elTitle = el('h2', null, elModal, 'LEVEL UP'); elCards = el('div', 'cards', elModal);
  }
  function fmt(t) { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  function choose(i) {
    if (!offer) return;
    offer = null; elModal.style.display = 'none';
    if (Module._SE1Mod_UiSend) Module._SE1Mod_UiSend(i);
    Module.se1PointerHold = false;
    if (Module.se1GrabPointer) Module.se1GrabPointer();   // back into the game (this is a gesture)
  }
  window.addEventListener('keydown', function (e) {
    if (!offer) return;
    var i = ['1', '2', '3'].indexOf(e.key);
    if (i >= 0 && i < offer.length) { choose(i); e.preventDefault(); e.stopPropagation(); }
  }, true);

  Module.se1ModUi = function (json) {
    var m; try { m = JSON.parse(json); } catch (e) { return; }
    if (m.type === 'hud' || m.type === 'dead') Module.se1SurvivorsLast = m;
    build();
    if (m.type === 'hud') {
      elLevel.textContent = 'LV ' + m.level;
      elBar.style.width = Math.min(100, 100 * m.xp / Math.max(1, m.next)) + '%';
      elTime.textContent = fmt(m.time); elKills.textContent = m.kills + ' kills';
      elAbil.innerHTML = '';
      el('div', null, elAbil, 'Serious Survivors').style.color = '#ffd75e';
      m.ranks.forEach(function (r) { el('div', null, elAbil, r.name + '  ' + 'I II III IV V VI VII VIII IX'.split(' ')[r.rank - 1]); });
      elProcs.innerHTML = ''; m.procs.forEach(function (p) { el('div', null, elProcs, p); });
      if (m.offer && !offer) {
        offer = m.offer; elTitle.textContent = 'LEVEL ' + m.level + '!  choose (1-3)';
        elCards.innerHTML = '';
        m.offer.forEach(function (o, i) {
          var c = el('div', 'card', elCards);
          var b = el('b', null, c, (i + 1) + '. ' + o.name); el('em', null, b, o.rank > 1 ? 'rank ' + o.rank : 'new');
          el('small', null, c, o.desc);
          c.onclick = function () { choose(i); };
        });
        elModal.style.display = 'flex';
        Module.se1PointerHold = true;   // free the mouse for the cards (port/web/input.js)
        if (document.exitPointerLock) document.exitPointerLock();
      }
    } else if (m.type === 'dead') {
      elTitle.textContent = 'YOU DIED  —  level ' + m.level + ', ' + m.kills + ' kills, ' + fmt(m.time) + '   (reload to retry)';
      elCards.innerHTML = ''; elModal.style.display = 'flex';
      Module.se1PointerHold = true; if (document.exitPointerLock) document.exitPointerLock();
    }
  };
})();
