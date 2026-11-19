// Touch controls for phones (main thread). Works with port/web/shell.html.
//
// Enabled when the URL has touch=1, or on a coarse pointer with touch points (touch=0 disables).
// A full-window layer (#touch) shows a move stick (left half), look drag (right half), and
// Fire / Jump / Next-weapon / Menu buttons, only while the game wants the pointer (in play, not
// in a menu). Each touch is owned by what it started on, so several fingers work at once.
//
// Look goes through Module._SE1_TouchLook(dx, dy) (src/.../SDLInput.cpp): the page adds, the engine
// thread takes the deltas when it reads the mouse. Movement/jump/fire are synthetic DOM events on
// the canvas/window, so the engine's normal SDL input path sees them.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;   // pthread workers

  var q = new URLSearchParams(location.search);
  var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  // touch=1 forces on; touch=0 forces off; otherwise coarse-pointer devices with touch points get it
  var enabled = q.get('touch') === '1' || (q.get('touch') !== '0' && coarse && navigator.maxTouchPoints > 0);
  var sens = parseFloat(q.get('touchsens')) || 3;

  Module.se1Touch = { enabled: enabled, active: false };
  if (!enabled) return;
  // in touch mode the game never wants the pointer locked: Emscripten's own Browser code calls
  // canvas.requestPointerLock() on a canvas click (and our Fire button synthesises mousedown on
  // the canvas), which throws WrongDocumentError in headless Chrome. Replace it with a no-op that
  // resolves, so no pointer lock is ever requested.
  var noopLock = function () { return Promise.resolve(); };
  var installNoopLock = function () {
    var c = Module.canvas;
    if (c && c.requestPointerLock !== noopLock) c.requestPointerLock = noopLock;
  };

  // synthetic keys the engine sees (see port/web/input.js for why the page blocks browser defaults)
  var KEYS = { W: ['KeyW', 'w', 87], S: ['KeyS', 's', 83], A: ['KeyA', 'a', 65], D: ['KeyD', 'd', 68],
               Space: ['Space', ' ', 32], Escape: ['Escape', 'Escape', 27] };
  function key(code, down) {
    var k = KEYS[code];
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
      { key: k[1], code: k[0], keyCode: k[2], which: k[2], bubbles: true, cancelable: true }));
  }

  var root = null;
  function el(id) { return root && root.querySelector(id); }
  function want() {
    try { return Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : 0; } catch (e) { return 0; }
  }

  // the move stick keys currently held (a key can be held by stick and released by touch end)
  var held = {};
  var touches = {};   // touch identifier -> { kind, ... }: what each finger started on
  function setKey(code, on) {
    if (on && !held[code]) { held[code] = 1; key(code, true); }
    else if (!on && held[code]) { held[code] = 0; key(code, false); }
  }
  function releaseAll() {   // menu opened mid-touch: let go of everything the fingers held
    for (var c in held) setKey(c, false);
    for (var id in touches) {
      if (touches[id].kind === 'fire') mouseUp();
      else if (touches[id].kind === 'jump') key('Space', false);
    }
    touches = {};
    hideStick();
  }

  // ------------------------------------------------------------------ the layer
  // button ids the hit-test (hitBtn) recognises
  var BTN = { 't-fire': 1, 't-jump': 1, 't-weapon': 1, 't-menu': 1 };
  function build() {
    root = document.createElement('div');
    root.id = 'touch';
    root.style.cssText = 'position:fixed;inset:0;z-index:20;display:none;touch-action:none;' +
      'user-select:none;-webkit-user-select:none;pointer-events:auto;';
    // buttons: round, semi-transparent, bottom-right cluster + menu top-right
    function button(id, label, size) {
      var b = document.createElement('div');
      b.id = id;
      b.textContent = label;
      b.style.cssText = 'position:absolute;width:' + size + 'px;height:' +
        size + 'px;border-radius:50%;background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.4);' +
        'color:#fff;font:600 14px/1 sans-serif;display:flex;align-items:center;justify-content:center;' +
        'box-sizing:border-box;pointer-events:auto;';
      root.appendChild(b);
      return b;
    }
    var f = button('t-fire', 'FIRE', 72); f.style.left = '64px'; f.style.bottom = '64px';
    var j = button('t-jump', 'JUMP', 64); j.style.left = '152px'; j.style.bottom = '120px';
    var w = button('t-weapon', 'WPN', 64); w.style.left = '152px'; w.style.bottom = '32px';
    var m = button('t-menu', 'MENU', 56); m.style.right = '12px'; m.style.top = '12px';
    m.style.font = '600 12px/1 sans-serif';
    root.appendChild(m);
    // stick visuals (drawn only while a stick touch is held)
    var ring = document.createElement('div');
    ring.id = 't-stick-ring';
    ring.style.cssText = 'position:absolute;width:120px;height:120px;border-radius:50%;display:none;' +
      'border:2px solid rgba(255,255,255,.4);background:rgba(255,255,255,.08);box-sizing:border-box;pointer-events:none;';
    var knob = document.createElement('div');
    knob.id = 't-stick-knob';
    knob.style.cssText = 'position:absolute;width:48px;height:48px;border-radius:50%;display:none;' +
      'background:rgba(255,255,255,.35);box-sizing:border-box;pointer-events:none;';
    root.appendChild(ring);
    root.appendChild(knob);
    document.body.appendChild(root);
  }

  // ------------------------------------------------------------------ fire (mouse button)
  function mouseDown() {
    var c = Module.canvas;
    if (!c) return;
    c.dispatchEvent(new MouseEvent('mousedown',
      { bubbles: true, button: 0, buttons: 1, clientX: c.clientWidth / 2, clientY: c.clientHeight / 2 }));
  }
  function mouseUp() {
    var c = Module.canvas;
    if (!c) return;
    c.dispatchEvent(new MouseEvent('mouseup',
      { bubbles: true, button: 0, buttons: 0, clientX: c.clientWidth / 2, clientY: c.clientHeight / 2 }));
  }

  // ------------------------------------------------------------------ touch routing
  // a touch is owned by what it started on: a button, the stick (left half), or look (right half)

  // hit-test by coordinates: CDP's dispatchTouchEvent reports e.target as the root element, so
  // e.target.id never identifies a button; the button rects (CSS px, layer is fixed inset:0) are
  // the reliable source
  function hitBtn(x, y) {
    for (var id in BTN) {
      var b = document.getElementById(id);
      if (!b) continue;
      var r = b.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  }
  function onDown(e) {
    if (!want()) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var id = t.identifier;
      var btn = hitBtn(t.clientX, t.clientY);
      if (btn) {
        if (btn === 't-fire') { touches[id] = { kind: 'fire' }; mouseDown(); }
        else if (btn === 't-jump') { touches[id] = { kind: 'jump' }; key('Space', true); }
        else if (btn === 't-weapon') { touches[id] = { kind: 'weapon', x: t.clientX, y: t.clientY, moved: false }; }
        else if (btn === 't-menu') { touches[id] = { kind: 'menu', x: t.clientX, y: t.clientY, moved: false }; }
      } else if (t.clientX < window.innerWidth / 2) {
        touches[id] = { kind: 'stick', ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        showStick(t.clientX, t.clientY);
      } else {
        touches[id] = { kind: 'look', x: t.clientX, y: t.clientY, fx: 0, fy: 0 };
      }
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!want()) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var s = touches[t.identifier];
      if (!s) continue;
      if (s.kind === 'stick') {
        s.x = t.clientX; s.y = t.clientY;
        moveStick(s);
      } else if (s.kind === 'look' || s.kind === 'fire') {
        // a fire finger also looks, like the look area
        var dx = (t.clientX - s.x) * sens, dy = (t.clientY - s.y) * sens;
        s.x = t.clientX; s.y = t.clientY;
        var ix = Math.floor(dx + s.fx), iy = Math.floor(dy + s.fy);
        s.fx = dx + s.fx - ix; s.fy = dy + s.fy - iy;
        if (ix || iy) Module['_SE1_TouchLook'](ix, iy);
      } else if (s.kind === 'weapon' || s.kind === 'menu') {
        if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) s.moved = true;
      }
    }
    e.preventDefault();
  }

  function onUp(e) {
    var mine = false;   // only swallow the touches the controls own (menus need their taps)
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var s = touches[t.identifier];
      if (!s) continue;
      mine = true;
      delete touches[t.identifier];
      if (s.kind === 'fire') mouseUp();
      else if (s.kind === 'jump') key('Space', false);
      else if (s.kind === 'stick') { setKey('W', false); setKey('S', false); setKey('A', false); setKey('D', false); hideStick(); }
      else if (s.kind === 'weapon' && !s.moved) {
        var c = Module.canvas;
        if (c) c.dispatchEvent(new WheelEvent('wheel',
          { bubbles: true, deltaY: 100, deltaMode: 0, clientX: c.clientWidth / 2, clientY: c.clientHeight / 2 }));
      }
      else if (s.kind === 'menu' && !s.moved) {
        // hold Escape ~50 ms so the engine reads a frame with the key down (a keydown+keyup in the
        // same tick can land between the engine thread's key-state reads)
        key('Escape', true);
        setTimeout(function () { key('Escape', false); }, 50);
      }
    }
    if (mine) e.preventDefault();
  }

  function moveStick(s) {
    var dx = (s.x - s.ox) / 60, dy = (s.y - s.oy) / 60;
    var m = Math.sqrt(dx * dx + dy * dy);
    if (m > 1) { dx /= m; dy /= m; }
    setKey('W', dy < -0.3);
    setKey('S', dy > 0.3);
    setKey('A', dx < -0.3);
    setKey('D', dx > 0.3);
    // knob follows the finger (clamped to the ring)
    var knob = el('#t-stick-knob');
    if (knob) {
      var kx = s.ox + dx * 60 - 24, ky = s.oy + dy * 60 - 24;
      knob.style.left = kx + 'px';
      knob.style.top = ky + 'px';
    }
  }
  function showStick(x, y) {
    var ring = el('#t-stick-ring'), knob = el('#t-stick-knob');
    if (ring) { ring.style.display = 'block'; ring.style.left = (x - 60) + 'px'; ring.style.top = (y - 60) + 'px'; }
    if (knob) { knob.style.display = 'block'; knob.style.left = (x - 24) + 'px'; knob.style.top = (y - 24) + 'px'; }
  }
  function hideStick() {
    var ring = el('#t-stick-ring'), knob = el('#t-stick-knob');
    if (ring) ring.style.display = 'none';
    if (knob) knob.style.display = 'none';
  }

  // ------------------------------------------------------------------ lifecycle
  var prevActive = false;
  setInterval(function () {
    if (!root) { build(); installNoopLock(); }
    var w = want();
    var active = w === 1;
    root.style.display = active ? 'block' : 'none';
    Module.se1Touch.active = active;
    if (!active && prevActive) releaseAll();   // menu opened: nothing may stay held
    prevActive = active;
  }, 100);

  // the layer must swallow its touches (no scroll/zoom/emulated mouse) and route them
  document.addEventListener('touchstart', onDown, { passive: false, capture: true });
  document.addEventListener('touchmove', onMove, { passive: false, capture: true });
  document.addEventListener('touchend', onUp, { passive: false, capture: true });
  document.addEventListener('touchcancel', onUp, { passive: false, capture: true });
})();
