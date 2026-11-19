// Page-side input glue (main thread). Works with port/web/shell.html.
//
// Mouse capture: browsers grant pointer lock only inside a user gesture (a click or key press). In
// the threaded build SDL handles input events on the engine thread, after the gesture is over, so
// once the lock is lost (Escape, alt-tab, a level-up card) SDL's own re-grab is refused and the
// cursor wanders off the canvas. Here the page asks the engine whether it wants the mouse
// (SE1_WantPointer: in play, not in a menu) and grabs it in the click/key handler itself.
//
// Keys: the threaded build can't preventDefault from SDL's handlers (they're proxied), so the
// browser's own actions (Space/arrows scroll, Tab moves focus, F3 finds…) are blocked here.
//
// Also: the canvas is scaled to fit the window (keeping the game's aspect), and the Fullscreen
// button makes the whole page fullscreen (Emscripten's Browser.requestFullscreen sizes the canvas
// from values SDL2 never sets and leaves it 0x0, i.e. black).
//
// Mods that show page UI over the game hold the pointer free with Module.se1PointerHold = true and
// call Module.se1GrabPointer() from their click/key handler when done.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;   // pthread workers

  function cv() { return Module['canvas']; }
  function want() {
    try { return Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : 0; } catch (e) { return 0; }
  }
  function locked() { return !!cv() && document.pointerLockElement === cv(); }
  function grab() {
    var c = cv();
    if (!c || locked() || Module.se1PointerHold || !c.requestPointerLock) return;
    try { var p = c.requestPointerLock(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  Module.se1GrabPointer = function () { if (want()) grab(); };
  Module.se1WantPointer = want;

  // a click on the game grabs the mouse whenever the game wants it
  document.addEventListener('mousedown', function (e) {
    if (e.target === cv() && want()) grab();
  }, true);

  // browser default actions for keys the game uses
  var BLOCK = { Tab: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1,
                Home: 1, End: 1, Backspace: 1, F1: 1, F3: 1, F6: 1, F7: 1, Slash: 1, Quote: 1 };
  window.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (e.metaKey) return;                          // browser shortcuts (Cmd+R, Cmd+L, …)
    var w = want();
    if (w && e.key !== 'Escape') grab();            // a key press is a gesture too
    // Space only in play: in menus and the console it has to stay a typed character
    if (BLOCK[e.code] || (w && e.code === 'Space')) e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur &&
        document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  }, true);

  // fit the canvas into the window, keeping the game's aspect ratio
  function fit() {
    var c = cv(); if (!c) return;
    var lw = +c.dataset.logw || c.width, lh = +c.dataset.logh || c.height;
    if (!lw || !lh) return;
    var k = Math.min(window.innerWidth / lw, window.innerHeight / lh);
    var w = Math.max(1, Math.floor(lw * k)) + 'px', h = Math.max(1, Math.floor(lh * k)) + 'px';
    if (c.style.width !== w || c.style.height !== h) { c.style.width = w; c.style.height = h; }
  }
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);

  function fullscreen() {
    var d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else {
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { var p = req.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(function () {}); }
      if (want()) grab();                           // same gesture: capture the mouse too
    }
  }
  Module.se1Fullscreen = fullscreen;
  function hookButton() {
    var b = document.getElementById('fs');
    if (b && !b.se1) { b.se1 = 1; b.addEventListener('click', function () { b.blur(); fullscreen(); }); }
  }
  hookButton();
  document.addEventListener('DOMContentLoaded', hookButton);

  // state poll: grab on entering play right after a gesture, show the "click to play" hint
  var prev = 0;
  setInterval(function () {
    fit();
    var w = want(), l = locked();
    if (w && !prev && navigator.userActivation && navigator.userActivation.isActive) grab();
    if (!w && prev && l) document.exitPointerLock();
    prev = w;
    document.body && document.body.classList.toggle('locked', l);
    var hint = document.getElementById('hint');
    if (hint) hint.style.display = (w && !l && !Module.se1PointerHold) ? 'block' : 'none';
  }, 100);
})();
