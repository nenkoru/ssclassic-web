// "Serious Survivors" page side (the game logic is Rust: rust/se1-mod/src/survivors/).
//   ?mode=survivors[&level=Levels/KarnakDemo.wld]   debug/test: &svauto=1 (skip the lobby), &svxp=N,
//   &svstress=N&svkind=K (monster stress test, tools/stress.mjs), &svseed=N, &svgive=<mask>&svrank=N,
//   &svtime=<s>, &svchest=N, &svgod=1 (see start_run in survivors/mod.rs)
// The mod posts JSON through Module.se1ModUi (lobby, start, hud, fx, offer, chest, banner, warn,
// achv, end); answers go back with Module._SE1Mod_UiSend(int):
//   lobby: 1000 + character*10 + difficulty   offer: 0-3 pick, 10 reroll, 11 skip
//   chest: 20 continue                          end: 30 continue in endless mode
// Meta progression (gold, shop, unlocks, best scores) is kept in localStorage and handed to the mod
// as Module.se1Sv* options at run start.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  if (q.get('mode') !== 'survivors') return;
  Module.se1Survivors = 1;
  if (q.get('svxp')) Module.se1SurvivorsXp = +q.get('svxp');
  if (q.get('svauto')) Module.se1SurvivorsAuto = 1;
  if (q.get('svseed')) Module.se1SurvivorsSeed = +q.get('svseed');
  if (q.get('svstress')) Module.se1SurvivorsStress = +q.get('svstress');
  if (q.get('svkind')) Module.se1SurvivorsStressKind = +q.get('svkind');
  if (q.get('svgive')) Module.se1SurvivorsGive = +q.get('svgive');     // bit mask of upgrades (data::ALL order)
  if (q.get('svrank')) Module.se1SurvivorsGiveRank = +q.get('svrank');
  if (q.get('svtime')) Module.se1SurvivorsTime = +q.get('svtime');     // start the run clock here
  if (q.get('svchest')) Module.se1SurvivorsChest = +q.get('svchest');  // open a chest with N items
  if (q.get('svgod')) Module.se1SurvivorsGod = 1;
  if (q.get('svautofire') === '0') Module.se1SurvivorsAutofire = 0; else Module.se1SurvivorsAutofire = 1;
  if (q.get('svbehind')) Module.se1SurvivorsBehind = +q.get('svbehind');   // spawn one enemy of kind N-1 behind the player
  if (q.get('svring')) Module.se1SurvivorsRing = +q.get('svring');       // keep N monsters in sight around the player (tests)
  if (q.get('svthreats') === '0') Module.se1SurvivorsThreats = 0;
  // monster cap: phones and small CPUs get fewer (notes/big-ideas.md, "How many enemies on screen")
  Module.se1SurvivorsCap = +q.get('svcap') || (/Android|iPhone|iPad/.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4 ? 60 : 110);
  Module.se1SurvivorsLast = null;    // last HUD message (tests read these)
  Module.se1SurvivorsOffer = null;   // current level-up offer
  Module.se1SurvivorsEnd = null;
  if (!(Module['arguments'] || []).some(function (a) { return a === '+level'; }))
    Module['arguments'] = (Module['arguments'] || []).concat(['+level', q.get('level') || 'Levels/KarnakDemo.wld']);

  // ------------------------------------------------------------ meta progression (localStorage)
  var SHOP = [
    ['might', 'Might', '+5% damage', 5, 200], ['armor', 'Armor', '+25 starting armor', 3, 300],
    ['maxHp', 'Max Health', 'Healing goes 10 higher', 3, 200], ['recovery', 'Recovery', '+0.2 health/s', 5, 200],
    ['cooldown', 'Cooldown', 'Abilities 3% faster', 2, 900], ['area', 'Area', 'Abilities 5% wider', 2, 300],
    ['magnet', 'Magnet', 'Pick up XP 20% farther', 2, 300], ['growth', 'Growth', '+5% XP', 5, 300],
    ['greed', 'Greed', '+10% gold', 5, 200], ['luck', 'Luck', '+5% luck', 3, 600],
    ['revival', 'Revival', 'Come back once per run', 1, 1000], ['reroll', 'Reroll', '+1 reroll per run', 3, 400],
    ['skip', 'Skip', '+1 skip per run', 3, 200]
  ];
  var CHARS = [
    { name: 'Serious Sam', desc: 'Revolver. +10% damage', need: null },
    { name: 'Red Rick', desc: 'Double Coach Gun and Kevlar Vest', need: ['survive10', 'Survive 10:00'] },
    { name: 'Mighty Marvin', desc: 'Overheal II, Regeneration. A bit slower', need: ['kills1000', 'Kill 1000 in one run'] },
    { name: 'Lucky Larry', desc: 'Tommy Gun, Lucky Pyramid II. A bit faster', need: ['evolve', 'Evolve a weapon'] },
    { name: 'Sirian Sam', desc: 'XL2 Laser and Chain Lightning', need: ['victory', 'Win a run'] }
  ];
  var DIFFS = [['Tourist', 'Enemies 40% weaker. Half the gold'], ['Normal', 'The intended run'],
               ['Serious', 'Tougher, denser. 1.6x gold'], ['Mental', 'Brutal. 2.5x gold']];
  var ACHV = { survive10: 'Red Rick unlocked', kills1000: 'Mighty Marvin unlocked', evolve: 'Lucky Larry unlocked', victory: 'Sirian Sam unlocked' };
  var save;
  function load() {
    try { save = JSON.parse(localStorage.getItem('se1sv') || 'null'); } catch (e) { save = null; }
    save = save || {};
    save.gold = save.gold || 0; save.meta = save.meta || {}; save.achv = save.achv || []; save.wins = save.wins || [];
    save.best = save.best || {}; save.char = save.char || 0; save.diff = save.diff == null ? 1 : save.diff;
  }
  function store() { try { localStorage.setItem('se1sv', JSON.stringify(save)); } catch (e) {} }
  load();
  function bought() { var n = 0; for (var k in save.meta) n += save.meta[k]; return n; }
  function price(it) { return Math.round(it[4] * (1 + (save.meta[it[0]] || 0)) * (1 + 0.1 * bought())); }
  function charOk(i) { var n = CHARS[i].need; return !n || save.achv.indexOf(n[0]) >= 0; }
  function diffOk(i) { return i <= 1 || save.wins.indexOf(i - 1) >= 0; }

  // ------------------------------------------------------------ DOM
  var css =
    '#svv{position:fixed;inset:0;pointer-events:none;font:600 14px/1.3 system-ui,sans-serif;color:#fff;z-index:20;user-select:none}' +
    '#svv .xp{position:absolute;top:0;left:0;right:0;height:8px;background:rgba(0,0,0,.6)}#svv .xp i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3f9fff,#a0e8ff);transition:width .15s}' +
    '#svv .top{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:baseline;text-shadow:0 1px 3px #000}' +
    '#svv .clock{font-size:26px;font-weight:800;letter-spacing:1px}#svv .lv{color:#a0e8ff}#svv .gold{color:#ffd75e}#svv .combo{color:#ff9f5e}' +
    '#svv .score{position:absolute;top:12px;right:14px;text-align:right;text-shadow:0 1px 3px #000}#svv .score b{font-size:20px;color:#ffd75e}' +
    '#svv .build{position:absolute;left:10px;top:120px;display:flex;flex-direction:column;gap:3px;text-shadow:0 1px 2px #000}' +
    '#svv .build .row{display:flex;gap:4px;flex-wrap:wrap;max-width:330px}#svv .slot{background:rgba(10,14,6,.7);border:1px solid #444;border-radius:4px;padding:2px 6px;font-size:12px;white-space:nowrap}' +
    '#svv .slot.gun{border-color:#c98a3a}#svv .slot.ability{border-color:#5aa0ff}#svv .slot.passive{border-color:#6fbf4a}#svv .slot.evo{border-color:#ffd75e;color:#ffd75e;box-shadow:0 0 6px #ffd75e}' +
    '#svv .pips{color:#ffd75e;margin-left:4px;letter-spacing:-1px}' +
    '#svv .boss{position:absolute;top:58px;left:50%;transform:translateX(-50%);width:420px;max-width:80%;text-align:center;text-shadow:0 1px 3px #000;display:none}' +
    '#svv .boss .bar{height:10px;background:#300;border:1px solid #a33;border-radius:5px;overflow:hidden;margin-top:2px}#svv .boss .bar i{display:block;height:100%;background:linear-gradient(90deg,#ff4040,#ffa040)}' +
    '#svv .powers{position:absolute;right:14px;top:70px;text-align:right;color:#7fffd4;text-shadow:0 1px 3px #000}' +
    '#svv .procs{position:absolute;right:14px;bottom:110px;text-align:right;color:#ffd75e;text-shadow:0 1px 2px #000;font-size:13px}' +
    '#svv .banner{position:absolute;top:22%;left:50%;transform:translateX(-50%);max-width:70%;padding:8px 16px;background:rgba(0,20,0,.75);border:1px solid #3c3;color:#7f7;' +
    'font:600 16px/1.35 ui-monospace,monospace;text-align:center;opacity:0;transition:opacity .3s}' +
    '#svv .arrow{position:absolute;font-size:12px;color:#ffd75e;text-shadow:0 1px 2px #000;transform:translate(-50%,-50%);text-align:center;white-space:nowrap}' +
    '#svv .arrow.boss{color:#ff6060}#svv .arrow.warn{color:#ff4040;font-size:18px;font-weight:800;animation:svblink .3s infinite alternate}' +
    '@keyframes svblink{from{opacity:1}to{opacity:.3}}' +
    '#svv .num{position:absolute;font-weight:800;text-shadow:0 1px 2px #000,0 0 3px #000;transform:translate(-50%,-50%);white-space:nowrap}' +
    '#svv .flash{position:absolute;inset:0;background:#fff;opacity:0}' +
    '#svv .modal{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.62);pointer-events:auto;gap:16px;overflow:auto}' +
    '#svv h1{margin:0;font-size:44px;color:#ffd75e;text-shadow:0 3px 10px #000;letter-spacing:2px}#svv h2{margin:0;font-size:30px;color:#ffd75e;text-shadow:0 2px 6px #000}' +
    '#svv h3{margin:0 0 8px;color:#ffd75e}' +
    '#svv .cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;max-width:95%}' +
    '#svv .card{width:210px;min-height:160px;padding:14px;border-radius:9px;cursor:pointer;background:linear-gradient(#26301a,#12180a);border:2px solid #6b8f2a;box-shadow:0 4px 18px rgba(0,0,0,.6);position:relative}' +
    '#svv .card:hover{border-color:#ffd75e;transform:translateY(-3px)}#svv .card .k{position:absolute;top:-12px;left:-12px;width:26px;height:26px;border-radius:13px;background:#ffd75e;color:#000;display:flex;align-items:center;justify-content:center;font-weight:800}' +
    '#svv .card .cat{font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.75}#svv .card.gun{border-color:#c98a3a}#svv .card.ability{border-color:#5aa0ff}#svv .card.passive{border-color:#6fbf4a}' +
    '#svv .card b{display:block;font-size:18px;color:#ffd75e;margin:4px 0 6px}#svv .card small{color:#d8e8c8;font-weight:500;display:block}#svv .card .evo{margin-top:8px;color:#ffb0ff;font-size:12px}' +
    '#svv .card .new{position:absolute;top:10px;right:10px;color:#7fff7f;font-size:12px}' +
    '#svv .hint{color:#ccc;font-size:13px;text-align:center;max-width:90%}#svv .btn{pointer-events:auto;cursor:pointer;padding:9px 20px;border-radius:6px;border:1px solid #8fbf3a;background:#2b3a16;color:#fff;font:700 15px system-ui}' +
    '#svv .btn:hover{border-color:#ffd75e}#svv .btn.go{background:#6b8f2a;font-size:20px;padding:12px 40px}' +
    '#svv .lobby{display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:980px;width:92%}#svv .panel{background:rgba(10,14,6,.85);border:1px solid #6b8f2a;border-radius:9px;padding:12px 14px}' +
    '#svv .opt{padding:6px 8px;border:1px solid #333;border-radius:6px;margin:4px 0;cursor:pointer}#svv .opt.on{border-color:#ffd75e;background:rgba(255,215,94,.08)}' +
    '#svv .opt.locked{opacity:.45;cursor:default}#svv .opt small{display:block;color:#bbb;font-weight:500}' +
    '#svv .shop{display:grid;grid-template-columns:1fr 1fr;gap:4px}#svv .shop .opt{margin:0;font-size:13px}#svv .shop .lvl{color:#ffd75e}' +
    '#svv table{border-collapse:collapse;font-size:14px}#svv td{padding:2px 10px}#svv td.bar{width:240px}#svv td.bar i{display:block;height:10px;background:linear-gradient(90deg,#ffd75e,#ff9f5e);border-radius:5px}' +
    '#svv .roll{font-size:22px;color:#ffd75e;min-height:30px}' +
    '#svv .threat{position:absolute;width:12px;height:12px;background:#f44;border-radius:50%;transform:translate(-50%,-50%);text-align:center}' +
    '#svv .threat.close{animation:svpulse .3s infinite alternate}' +
    '@keyframes svpulse{from{transform:translate(-50%,-50%) scale(1)}to{transform:translate(-50%,-50%) scale(1.6)}}' +
    '#svv .threat .cnt{position:absolute;top:14px;left:50%;transform:translateX(-50%);font-size:11px;color:#f88;text-shadow:0 1px 2px #000}' +
    '#svv .hurt{position:absolute;inset:0;pointer-events:none}' +
    '@media (max-width:760px){#svv .lobby{grid-template-columns:1fr}#svv .card{width:150px}#svv h1{font-size:30px}}';

  var root, E = {}, offer = null, chestOpen = false, endShown = false, nums = [];
  function el(tag, cls, parent, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; }
  function build() {
    if (root) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = el('div', null, document.body); root.id = 'svv';
    E.xp = el('i', null, el('div', 'xp', root));
    var top = el('div', 'top', root);
    E.lv = el('span', 'lv', top); E.clock = el('span', 'clock', top); E.kills = el('span', null, top); E.gold = el('span', 'gold', top); E.combo = el('span', 'combo', top);
    var sc = el('div', 'score', root); el('div', null, sc, 'SCORE'); E.score = el('b', null, sc, '0');
    E.build = el('div', 'build', root);
    E.boss = el('div', 'boss', root); E.bossName = el('div', null, E.boss); E.bossBar = el('i', null, el('div', 'bar', E.boss));
    E.powers = el('div', 'powers', root); E.procs = el('div', 'procs', root);
    E.banner = el('div', 'banner', root); E.arrows = el('div', null, root); E.nums = el('div', null, root);
    E.threats = el('div', null, root); E.hurt = el('div', 'hurt', root);
    E.flash = el('div', 'flash', root);
    E.modal = el('div', 'modal', root);
  }
  function fmt(t) { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  function pips(r) { return '★'.repeat(Math.min(5, r)) + '☆'.repeat(Math.max(0, 5 - r)); }
  function send(v) { if (Module._SE1Mod_UiSend) Module._SE1Mod_UiSend(v); }
  // Screens that need the mouse (lobby, results) free it; level-up and chest screens keep it captured
  // (keyboard: no "click the game to grab the mouse again" after every level).
  function showModal(on, mouse) {
    E.modal.style.display = on ? 'flex' : 'none';
    Module.se1PointerHold = !!(on && mouse);
    if (on && mouse && document.exitPointerLock) document.exitPointerLock();
  }
  function grab() { Module.se1PointerHold = false; if (Module.se1GrabPointer) Module.se1GrabPointer(); }

  // ------------------------------------------------------------ lobby
  var sel = { c: save.char, d: save.diff }, inLobby = false;
  if (!charOk(sel.c)) sel.c = 0;
  if (!diffOk(sel.d)) sel.d = 1;
  function lobby() {
    inLobby = true;
    var m = E.modal; m.innerHTML = '';
    el('h1', null, m, 'SERIOUS SURVIVORS');
    el('div', 'hint', m, 'Survive 20 minutes. Destroy the champion. Evolve Sam’s guns.   Best: ' +
      (save.best.score ? save.best.score + ' points, ' + fmt(save.best.time) : 'no runs yet'));
    var g = el('div', 'lobby', m);
    var p1 = el('div', 'panel', g); el('h3', null, p1, 'Character');
    CHARS.forEach(function (c, i) {
      var o = el('div', 'opt' + (i === sel.c ? ' on' : '') + (charOk(i) ? '' : ' locked'), p1, c.name);
      el('small', null, o, charOk(i) ? c.desc : '🔒 ' + c.need[1]);
      if (charOk(i)) o.onclick = function () { sel.c = i; lobby(); };
    });
    el('h3', null, p1, 'Difficulty').style.marginTop = '12px';
    DIFFS.forEach(function (d, i) {
      var o = el('div', 'opt' + (i === sel.d ? ' on' : '') + (diffOk(i) ? '' : ' locked'), p1, d[0]);
      el('small', null, o, diffOk(i) ? d[1] : '🔒 Win on ' + DIFFS[i - 1][0]);
      if (diffOk(i)) o.onclick = function () { sel.d = i; lobby(); };
    });
    var p2 = el('div', 'panel', g); el('h3', null, p2, 'Sirian Shop — ' + Math.floor(save.gold) + ' gold');
    var shop = el('div', 'shop', p2);
    SHOP.forEach(function (it) {
      var lv = save.meta[it[0]] || 0, max = lv >= it[3], pr = price(it);
      var o = el('div', 'opt' + (max || save.gold < pr ? ' locked' : ''), shop);
      el('span', null, o, it[1] + ' '); el('span', 'lvl', o, lv + '/' + it[3]);
      el('small', null, o, it[2] + (max ? '' : ' — ' + pr + 'g'));
      if (!max && save.gold >= pr) o.onclick = function () { save.gold -= pr; save.meta[it[0]] = lv + 1; store(); lobby(); };
    });
    el('div', 'hint', p2, 'Gold comes from kills, chests and victories. Upgrades are permanent.');
    el('button', 'btn go', m, 'START RUN  (Enter)').onclick = start;
    showModal(true, true);
  }
  function start() {
    if (!inLobby) return;
    inLobby = false;
    save.char = sel.c; save.diff = sel.d; store();
    SHOP.forEach(function (it) { Module['se1Sv' + it[0].charAt(0).toUpperCase() + it[0].slice(1)] = save.meta[it[0]] || 0; });
    showModal(false);
    send(1000 + sel.c * 10 + sel.d);
    grab();
  }

  // ------------------------------------------------------------ in-run UI
  function hud(m) {
    E.xp.style.width = Math.min(100, 100 * m.xp / Math.max(1, m.next)) + '%';
    E.lv.textContent = 'LV ' + m.level;
    E.clock.textContent = fmt(m.time) + (m.endless ? '  ENDLESS' : '');
    E.clock.style.color = !m.endless && m.time > m.run - 60 ? '#ff7070' : '#fff';
    E.kills.textContent = m.kills + ' kills'; E.gold.textContent = m.gold + 'g';
    E.combo.textContent = m.combo >= 10 ? 'x' + (1 + Math.min(7, Math.floor(m.combo / 10))) + ' combo' : '';
    E.score.textContent = m.score;
    E.build.innerHTML = '';
    [['gun', m.guns], ['ability', m.abilities], ['passive', m.passives]].forEach(function (g) {
      var row = el('div', 'row', E.build);
      g[1].forEach(function (u) {
        var s = el('span', 'slot ' + g[0] + (u.evo ? ' evo' : ''), row, u.evo || u.name);
        if (!u.evo) el('span', 'pips', s, pips(u.rank));
      });
    });
    if (m.boss) { E.boss.style.display = 'block'; E.bossName.textContent = m.boss.name; E.bossBar.style.width = Math.max(0, 100 * m.boss.hp / m.boss.max) + '%'; }
    else E.boss.style.display = 'none';
    E.powers.innerHTML = ''; m.powers.forEach(function (p) { el('div', null, E.powers, p.name + '  ' + p.left + 's'); });
    E.procs.innerHTML = ''; m.procs.forEach(function (p) { el('div', null, E.procs, p); });
    arrows(m.arrows);
    threats(m.threats, m.hurt);
  }
  var warns = [];
  // edge markers for things outside the view: chests, relics, bosses, incoming stampedes
  function arrows(list) {
    E.arrows.innerHTML = '';
    var now = performance.now();
    warns = warns.filter(function (w) { return now < w.until; });
    list.concat(warns).forEach(function (a) {
      if (Math.abs(a.a) < 30 && !a.warn) return;   // in front: you can see it
      var r = a.a * Math.PI / 180, cx = innerWidth / 2, cy = innerHeight / 2;
      var x = cx + Math.sin(r) * cx * 0.8, y = cy - Math.cos(r) * cy * 0.75;
      var cls = 'arrow ' + (a.warn ? 'warn' : a.label);
      var d = el('div', cls, E.arrows, '▲');
      d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.transform = 'translate(-50%,-50%) rotate(' + a.a + 'deg)';
      var t = el('div', cls, E.arrows, a.warn ? a.text : a.label + (a.d ? ' ' + a.d + 'm' : ''));
      t.style.left = x + 'px'; t.style.top = (y + 18) + 'px';
    });
  }
  // edge markers for enemies outside the view, grouped by sector; and a red glow where a hit came from
  function threats(list, hurt) {
    E.threats.innerHTML = '';
    var show = Module.se1SurvivorsThreats !== 0;
    if (!show) { E.hurt.style.opacity = 0; return; }
    var cx = innerWidth / 2, cy = innerHeight / 2;
    (list || []).forEach(function (t) {
      var r = t.a * Math.PI / 180;
      var x = cx + Math.sin(r) * cx * 0.88, y = cy - Math.cos(r) * cy * 0.85;
      var sz = 10 + 14 * t.lvl;
      var d = el('div', 'threat' + (t.d < 8 ? ' close' : ''), E.threats);
      d.style.left = x + 'px'; d.style.top = y + 'px';
      d.style.width = sz + 'px'; d.style.height = sz + 'px';
      d.style.opacity = 0.35 + 0.65 * t.lvl;
      d.style.transform = 'translate(-50%,-50%) rotate(' + t.a + 'deg)';
      if (t.n > 1) el('div', 'cnt', d, t.n);
    });
    if (hurt) {
      var hr = hurt.a * Math.PI / 180;
      var hx = cx + Math.sin(hr) * cx * 0.88, hy = cy - Math.cos(hr) * cy * 0.85;
      var w = innerWidth * 0.35;
      E.hurt.style.background = 'radial-gradient(circle at ' + hx + 'px ' + hy + 'px, rgba(255,40,40,.7) 0%, transparent ' + w + 'px)';
      E.hurt.style.opacity = Math.max(0, 1 - hurt.age / 1.5);
    } else {
      E.hurt.style.opacity = 0;
    }
  }
  var bannerTimer = 0;
  function banner(text) {
    E.banner.textContent = text; E.banner.style.opacity = 1;
    clearTimeout(bannerTimer); bannerTimer = setTimeout(function () { E.banner.style.opacity = 0; }, 4500);
  }
  // Damage numbers: project the hit with that frame's camera (eye, view direction; the game's
  // horizontal FOV is 90 degrees), then float up in screen space.
  function project(p, c) {
    var f = [c[3], c[4], c[5]], d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    var r = [-f[2], 0, f[0]];                          // f x up
    var rl = Math.hypot(r[0], r[2]) || 1; r = [r[0] / rl, 0, r[2] / rl];
    var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    var z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z < 0.5) return null;
    var cv = Module.canvas.getBoundingClientRect(), aspect = cv.width / cv.height;
    var x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z, y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z;
    var sx = 0.5 + x / 2, sy = 0.5 - y * aspect / 2;
    if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null;
    return [cv.left + sx * cv.width, cv.top + sy * cv.height];
  }
  function fx(m) {
    if (m.flash) {
      E.flash.style.transition = 'none'; E.flash.style.opacity = 0.9;
      setTimeout(function () { E.flash.style.transition = 'opacity .9s'; E.flash.style.opacity = 0; }, 30);
    }
    var now = performance.now();
    m.hits.forEach(function (h) {
      if (nums.length > 60 || h[3] < 1) return;
      var s = project(h, m.cam); if (!s) return;
      var d = el('div', 'num', E.nums, Math.round(h[3]));
      var crit = h[4] === 2, abil = h[4] === 1;
      d.style.color = crit ? '#ff5050' : abil ? '#9fd0ff' : '#fff';
      d.style.fontSize = (crit ? 22 : 13 + Math.min(9, Math.log10(1 + h[3]) * 3)) + 'px';
      nums.push({ e: d, x: s[0] + (Math.random() - 0.5) * 24, y: s[1], t: now });
    });
  }
  (function animate() {
    var now = performance.now();
    nums = nums.filter(function (n) {
      var a = (now - n.t) / 700;
      if (a >= 1) { n.e.remove(); return false; }
      n.e.style.left = n.x + 'px'; n.e.style.top = (n.y - a * 40) + 'px'; n.e.style.opacity = 1 - a * a;
      return true;
    });
    requestAnimationFrame(animate);
  })();

  function showOffer(m) {
    offer = m; Module.se1SurvivorsOffer = m;
    var md = E.modal; md.innerHTML = '';
    el('h2', null, md, 'LEVEL ' + m.level + '!');
    var cards = el('div', 'cards', md);
    m.cards.forEach(function (c, i) {
      var d = el('div', 'card ' + c.cat, cards);
      el('div', 'k', d, i + 1);
      el('div', 'cat', d, c.cat);
      if (c.rank === 1 && c.cat !== 'misc') el('div', 'new', d, 'NEW');
      var b = el('b', null, d, c.name); if (c.rank > 1) el('span', 'pips', b, pips(c.rank));
      el('small', null, d, c.desc);
      if (c.evo) el('div', 'evo', d, '✨ ' + c.evo);
      d.onclick = function () { choose(i); };
    });
    el('div', 'hint', md, '1–' + m.cards.length + ' choose   ·   R reroll (' + m.rerolls + ')   ·   S skip (' + m.skips + ')');
    showModal(true, false);
  }
  function choose(v) {
    if (!offer) return;
    if (v < 10 || (v === 11 && offer.skips > 0)) { offer = null; Module.se1SurvivorsOffer = null; showModal(false); }
    send(v);
    if (!offer) grab();
  }
  function showChest(m) {
    chestOpen = true;
    var md = E.modal; md.innerHTML = ''; md.dataset.ready = '';
    var evo = m.items.some(function (i) { return i.evo; });
    el('h2', null, md, evo ? '✨ EVOLUTION! ✨' : 'SIRIAN CHEST');
    var roll = el('div', 'roll', md, '...');
    var list = el('div', 'cards', md);
    var hint = el('div', 'hint', md, '');
    showModal(true, false);
    var names = ['Revolver', 'Shotgun', 'Tommy Gun', 'Minigun', 'Rocket Launcher', 'XL2 Laser', 'Consecration', 'Chain Lightning', 'Greed', 'Kevlar Vest'];
    var t0 = performance.now(), i = 0;
    (function spin() {
      if (!chestOpen) return;
      if (performance.now() - t0 < 1400) { roll.textContent = names[i++ % names.length]; setTimeout(spin, 70); return; }
      roll.textContent = m.gold ? '+' + m.gold + ' gold' : '';
      m.items.forEach(function (it) {
        var d = el('div', 'card' + (it.evo ? ' gun' : ''), list);
        el('b', null, d, it.name); el('small', null, d, it.desc);
        if (it.evo) d.style.boxShadow = '0 0 24px #ffd75e';
      });
      hint.textContent = 'Space / Enter to continue';
      md.dataset.ready = '1';
    })();
  }
  function closeChest() {
    if (!chestOpen || !E.modal.dataset.ready) return;
    chestOpen = false; E.modal.dataset.ready = ''; showModal(false); send(20); grab();
  }
  function showEnd(m) {
    endShown = true; Module.se1SurvivorsEnd = m;
    save.gold += m.gold;
    if (m.victory && save.wins.indexOf(m.difficulty) < 0) save.wins.push(m.difficulty);
    if (!save.best.score || m.score > save.best.score) save.best = { score: m.score, time: m.time };
    store();
    var md = E.modal; md.innerHTML = '';
    el('h1', null, md, m.victory ? 'VICTORY!' : 'YOU DIED');
    el('div', 'hint', md, m.character + ' · ' + DIFFS[m.difficulty][0] + ' · ' + fmt(m.time) + ' · level ' + m.level + ' · ' + m.kills + ' kills');
    var t = el('table', null, el('div', 'panel', md));
    [['Score', m.score], ['Time bonus', m.timeBonus], ['Gold earned', '+' + m.gold + '  (total ' + Math.floor(save.gold) + ')']].forEach(function (r) {
      var tr = el('tr', null, t); el('td', null, tr, r[0]); el('td', null, tr, r[1]);
    });
    if (m.dmg.length) {
      var p = el('div', 'panel', md); el('h3', null, p, 'Damage by source');
      var t2 = el('table', null, p), top = m.dmg[0][1] || 1;
      m.dmg.forEach(function (d) {
        var tr = el('tr', null, t2); el('td', null, tr, d[0]);
        el('i', null, el('td', 'bar', tr)).style.width = (100 * d[1] / top) + '%'; el('td', null, tr, d[1]);
      });
    }
    el('div', 'hint', md, m.build.join('  ·  '));
    var row = el('div', null, md); row.style.display = 'flex'; row.style.gap = '12px';
    el('button', 'btn go', row, 'PLAY AGAIN  (Enter)').onclick = function () { location.reload(); };
    if (m.victory) el('button', 'btn', row, 'KEEP GOING: ENDLESS  (E)').onclick = endless;
    showModal(true, true);
  }
  function endless() { if (!endShown) return; endShown = false; showModal(false); send(30); grab(); }

  window.addEventListener('keydown', function (e) {
    if (!E.modal || E.modal.style.display !== 'flex') return;
    var k = e.key.toLowerCase(), used = true;
    if (offer) {
      var i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0 && i < offer.cards.length) choose(i);
      else if (k === 'r') send(10);
      else if (k === 's') choose(11);
      else used = false;
    } else if (chestOpen) { if (k === ' ' || k === 'enter') closeChest(); else used = false; }
    else if (endShown) { if (k === 'enter') location.reload(); else if (k === 'e') endless(); else used = false; }
    else if (inLobby && k === 'enter') start();
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }   // the game doesn't see it (registered before SDL)
  }, true);

  Module.se1ModUi = function (json) {
    var m; try { m = JSON.parse(json); } catch (e) { return; }
    build();
    switch (m.type) {
      case 'lobby': lobby(); break;
      case 'start': inLobby = false; showModal(false); banner('NETRICSA: ' + m.character + ' deployed (' + m.difficulty + '). Survive 20:00.'); break;
      case 'hud': Module.se1SurvivorsLast = m; hud(m); break;
      case 'fx': Module.se1SurvivorsHits = (Module.se1SurvivorsHits || 0) + m.hits.length; fx(m); break;
      case 'offer': showOffer(m); break;
      case 'chest': Module.se1SurvivorsChestMsg = m; showChest(m); break;
      case 'banner': banner(m.text); break;
      case 'warn': warns.push({ a: m.angle, warn: true, text: m.text, until: performance.now() + 3500 }); break;
      case 'achv':
        if (save.achv.indexOf(m.id) < 0) { save.achv.push(m.id); store(); if (ACHV[m.id]) banner('UNLOCKED: ' + ACHV[m.id]); }
        break;
      case 'end': showEnd(m); break;
    }
  };
})();
