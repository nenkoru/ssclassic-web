// Gamepad controls (main thread). Works with port/web/shell.html.
//
// Polls navigator.getGamepads at 16ms and translates a standard-mapping pad into synthetic
// DOM events (keys on window, mouse/wheel on the canvas) plus Module._SE1_PadLook(dx, dy)
// for the right stick, so the engine's normal SDL input path sees them.
//
// URL params: aimassist=0-3 (default 2), padsens (default 900 mouse counts/s at full deflection).
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;   // pthread workers

  var q = new URLSearchParams(location.search);
  var assistLevel = parseInt(q.get('aimassist'), 10);
  if (isNaN(assistLevel) || assistLevel < 0 || assistLevel > 3) assistLevel = 2;
  var padsens = parseFloat(q.get('padsens')) || 900;

  Module.se1Pad = { connected: false, id: '', assist: assistLevel, lastDevice: 'mouse' };

  var pad = null;
  var lastDevice = 'mouse';
  var held = {};
  var prevWant = 0;
  var lastTick = 0;

  var KEYS = {
    W: ['KeyW', 'w', 87], S: ['KeyS', 's', 83], A: ['KeyA', 'a', 65], D: ['KeyD', 'd', 68],
    Space: ['Space', ' ', 32], Escape: ['Escape', 'Escape', 27],
    KeyC: ['KeyC', 'c', 67],
    ShiftLeft: ['ShiftLeft', 'Shift', 16],
    CapsLock: ['CapsLock', 'CapsLock', 20],
    Home: ['Home', 'Home', 36],
    Enter: ['Enter', 'Enter', 13],
    ArrowUp: ['ArrowUp', 'ArrowUp', 38],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 'ArrowRight', 39]
  };

  function key(code, down) {
    var k = KEYS[code];
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
      { key: k[1], code: k[0], keyCode: k[2], which: k[2], bubbles: true, cancelable: true }));
  }

  function mouse(btn, buttons, down) {
    var c = Module.canvas;
    if (!c) return;
    c.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup',
      { bubbles: true, button: btn, buttons: down ? buttons : 0,
        clientX: c.clientWidth / 2, clientY: c.clientHeight / 2 }));
  }

  function wheel(deltaY) {
    var c = Module.canvas;
    if (!c) return;
    c.dispatchEvent(new WheelEvent('wheel',
      { bubbles: true, deltaY: deltaY, clientX: c.clientWidth / 2, clientY: c.clientHeight / 2 }));
  }

  function setKey(code, on) {
    if (on && !held[code]) { held[code] = 1; key(code, true); }
    else if (!on && held[code]) { held[code] = 0; key(code, false); }
  }

  var MOUSE_BUTTONS = { 0: 1, 1: 4, 2: 2 };
  // a press shorter than an engine frame can fall between two input reads and never fire:
  // every mouse press stays down at least MIN_PRESS_MS
  var MIN_PRESS_MS = 60, pressedAt = {}, releaseTimer = {};
  function setMouse(btn, on) {
    var k = 'm' + btn;
    if (on) {
      if (releaseTimer[k]) { clearTimeout(releaseTimer[k]); releaseTimer[k] = 0; }   // pressed again before the delayed release
      if (!held[k]) { held[k] = 1; pressedAt[k] = performance.now(); mouse(btn, MOUSE_BUTTONS[btn], true); }
    } else if (held[k] && !releaseTimer[k]) {
      var wait = MIN_PRESS_MS - (performance.now() - pressedAt[k]);
      var up = function () { releaseTimer[k] = 0; if (held[k]) { held[k] = 0; mouse(btn, 0, false); } };
      if (wait > 0) releaseTimer[k] = setTimeout(up, wait); else up();
    }
  }
  // analog triggers: read the value every frame (the browser's "pressed" flag flips at its own
  // low threshold, so an edge-only check missed pulls that crossed ours a frame later)
  function trigger(b) { return b ? (typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0)) : 0; }

  function releaseAll() {
    for (var c in held) {
      if (c.charAt(0) === 'm') setMouse(+c.slice(1), false);
      else setKey(c, false);
    }
  }

  // tap: keydown now, keyup ~50ms later (the engine must see a frame with the key down)
  function tap(code) {
    key(code, true);
    setTimeout(function () { key(code, false); }, 50);
  }

  // menu key repeat: first repeat after 400ms, then every 120ms
  var repeatTimers = {};
  function repeatStart(code) {
    repeatStop(code);
    repeatTimers[code] = setTimeout(function () {
      repeatTimers[code] = setInterval(function () { tap(code); }, 120);
    }, 400);
  }
  function repeatStop(code) {
    if (repeatTimers[code]) {
      clearTimeout(repeatTimers[code]);
      clearInterval(repeatTimers[code]);
      delete repeatTimers[code];
    }
  }

  var ASSIST_NAMES = ['off', 'low', 'medium', 'high'];

  function setAssist(level) {
    Module.se1Pad.assist = level;
    try { if (Module._SE1_SetAimAssist) Module._SE1_SetAimAssist(level); } catch (e) {}
    toast('Aim assist: ' + ASSIST_NAMES[level]);
  }

  function cycleAssist() {
    setAssist((Module.se1Pad.assist + 1) % 4);
  }

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.7);color:#fff;padding:6px 14px;border-radius:4px;' +
      'font:14px sans-serif;z-index:9999;pointer-events:none;';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1500);
  }

  function want() {
    try { return Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : 0; } catch (e) { return 0; }
  }

  // standard-mapping button index → action handler (in play)
  var PLAY_BTNS = {
    0: function (down) { if (down) tap('Space'); },                              // A: jump
    1: function (down) { setKey('KeyC', down); },                               // B: duck (held)
    2: function (down) { setMouse(2, down); },                                  // X: use
    3: function (down) { setMouse(1, down); },                                  // Y: flip weapon
    4: function (down) { if (down) wheel(-100); },                              // LB: prev weapon
    5: function (down) { if (down) wheel(100); },                               // RB: next weapon
    // 6 LT (walk) and 7 RT (fire) are analog: handled every frame in tick(), not here
    8: function (down) { if (down) cycleAssist(); },                            // Back/Select/Share
    9: function (down) { if (down) tap('Escape'); },                            // Start
    10: function (down) { if (down) tap('CapsLock'); },                         // left stick click: walk toggle
    11: function (down) { if (down) tap('Home'); },                             // right stick click: center view
    12: function (down) { setKey('ArrowUp', down); },                           // d-pad up
    13: function (down) { setKey('ArrowDown', down); },                         // d-pad down
    14: function (down) { setKey('ArrowLeft', down); },                         // d-pad left
    15: function (down) { setKey('ArrowRight', down); }                         // d-pad right
  };

  // menu buttons
  var MENU_BTNS = {
    0: function (down) { if (down) tap('Enter'); },                             // A: confirm
    1: function (down) { if (down) tap('Escape'); },                            // B: back
    9: function (down) { if (down) tap('Escape') }                              // Start
  };

  var prevBtns = [];
  var menuDir = null;   // the arrow the d-pad / stick holds in menus

  function tick() {
    var now = performance.now();
    var dt = lastTick ? (now - lastTick) / 1000 : 0.016;
    lastTick = now;

    var gps = navigator.getGamepads ? navigator.getGamepads() : [];
    var p = null;
    for (var i = 0; i < gps.length; i++) {
      if (gps[i] && gps[i].mapping === 'standard') { p = gps[i]; break; }
    }
    if (!p) {
      for (var j = 0; j < gps.length; j++) {
        if (gps[j]) { p = gps[j]; break; }
      }
    }

    if (p) {
      if (!pad || !Module.se1Pad.connected) {
        pad = p;
        Module.se1Pad.connected = true;
        Module.se1Pad.id = p.id;
        Module.se1Pad.lastDevice = 'pad';
        lastDevice = 'pad';
        try { if (Module._SE1_SetAimAssist) Module._SE1_SetAimAssist(Module.se1Pad.assist); } catch (e) {}
      }

      var w = want();
      if (w !== prevWant) { releaseAll(); for (var r in repeatTimers) repeatStop(r); menuDir = null; prevWant = w; }

      var axes = p.axes || [], buttons = p.buttons || [];

      if (w) {
        // left stick: movement (radial deadzone 0.25)
        var lx = axes[0] || 0, ly = axes[1] || 0;
        if (Math.sqrt(lx * lx + ly * ly) < 0.25) { lx = 0; ly = 0; }
        setKey('W', ly < -0.4);
        setKey('S', ly > 0.4);
        setKey('A', lx < -0.4);
        setKey('D', lx > 0.4);

        // right stick: look (radial deadzone 0.12, squared response)
        var rx = axes[2] || 0, ry = axes[3] || 0;
        if (Math.sqrt(rx * rx + ry * ry) < 0.12) { rx = 0; ry = 0; }
        rx = rx * Math.abs(rx);
        ry = ry * Math.abs(ry);
        var dx = Math.round(rx * padsens * dt);
        var dy = Math.round(ry * padsens * dt);
        if (dx || dy) {
          try { if (Module._SE1_PadLook) Module._SE1_PadLook(dx, dy); } catch (e) {}
        }

        // triggers, every frame: RT fires above 0.3, LT walks above 0.3
        setMouse(0, trigger(buttons[7]) > 0.3);
        setKey('ShiftLeft', trigger(buttons[6]) > 0.3);

        // buttons
        for (var b = 0; b < buttons.length && b < 16; b++) {
          var down = !!buttons[b].pressed;
          if (down !== !!prevBtns[b]) {
            var fn = PLAY_BTNS[b];
            if (fn) fn(down, buttons[b].value || 0);
          }
        }
      } else {
        // menus: d-pad / left stick with key repeat
        var mx = axes[0] || 0, my = axes[1] || 0;
        var active = null;
        if (buttons[12] && buttons[12].pressed) active = 'ArrowUp';
        else if (buttons[13] && buttons[13].pressed) active = 'ArrowDown';
        else if (buttons[14] && buttons[14].pressed) active = 'ArrowLeft';
        else if (buttons[15] && buttons[15].pressed) active = 'ArrowRight';
        else if (my < -0.5) active = 'ArrowUp';
        else if (my > 0.5) active = 'ArrowDown';
        else if (mx < -0.5) active = 'ArrowLeft';
        else if (mx > 0.5) active = 'ArrowRight';

        // a new direction taps once and starts the repeat; holding it keeps the repeat running
        if (active !== menuDir) {
          for (var c in repeatTimers) repeatStop(c);
          if (active) { tap(active); repeatStart(active); }
          menuDir = active;
        }

        for (var b2 = 0; b2 < buttons.length && b2 < 16; b2++) {
          var d2 = !!buttons[b2].pressed;
          if (d2 !== !!prevBtns[b2]) {
            var fn2 = MENU_BTNS[b2];
            if (fn2) fn2(d2);
          }
        }
      }

      prevBtns = buttons.map(function (b) { return !!b.pressed; });
    } else {
      if (pad) {
        pad = null;
        Module.se1Pad.connected = false;
        Module.se1Pad.id = '';
        Module.se1Pad.lastDevice = 'mouse';
        lastDevice = 'mouse';
        releaseAll();
        for (var r2 in repeatTimers) repeatStop(r2);
        prevBtns = [];
      }
    }
  }

  if (window.requestAnimationFrame) {
    (function loop() { tick(); requestAnimationFrame(loop); })();
  } else {
    setInterval(tick, 16);
  }
})();
