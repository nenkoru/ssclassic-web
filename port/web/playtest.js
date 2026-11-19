// Playtest recorder (?rec=1): a data timeline of a play session for analysis (no video).
//
// Everything goes to the dev server (tools/devserver.py) as
//   data/playtests/<session>/meta.json        who/what/when: URL options, browser, screen
//   data/playtests/<session>/telemetry.jsonl  one JSON event per line, "t" = seconds since start
//   data/playtests/<session>/survey.json      the answers of the end-of-session survey
// and is analysed with tools/playtest-report.py.
//
// Events: every message the Rust mod posts (Survivors: offer, chest, banner, warn, achv, end, ...;
// any mode: "tel" samples of health/armor/weapon/ammo/position each second), Survivors HUD
// snapshots twice a second, the answers the page sends back (card picks, rerolls, skips), and once
// a second an input summary, frame performance and the page state (in play or in a menu, paused,
// hidden). Markers: F7 fun, F8 boring/frustrating, F10 bug (the game never sees these keys).
// The survey opens when a Survivors run ends, or from the REC badge's Finish button.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  if (q.get('rec') !== '1') return;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  var d = new Date();
  var session = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) +
    pad2(d.getMinutes()) + pad2(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 6);
  var t0 = performance.now();
  function now() { return Math.round((performance.now() - t0) / 10) / 100; }   // seconds, 10 ms steps
  var base = '/__playtest/' + session + '/';
  var R = Module.se1Playtest = { session: session, events: 0, uploaded: 0, failed: 0 };   // status (tests)
  Module['se1PlaytestOn'] = 1;            // the mod reads page_option("se1PlaytestOn") and posts "tel" samples

  // ---- upload: buffer lines, append them to telemetry.jsonl every few seconds
  var buf = [];
  function log(ev) { ev.t = now(); buf.push(JSON.stringify(ev)); R.events++; }
  function post(name, body, append, beacon) {
    var url = base + name + (append ? '?append=1' : '');
    if (beacon && navigator.sendBeacon) { if (navigator.sendBeacon(url, new Blob([body]))) return; }
    fetch(url, { method: 'POST', body: body, keepalive: body.length < 60000 }).then(function (r) {
      if (!r.ok) R.failed++; else R.uploaded++;
    }, function () { R.failed++; });
  }
  function flush(beacon) {
    if (!buf.length) return;
    var body = buf.join('\n') + '\n';
    buf = [];
    post('telemetry.jsonl', body, true, beacon);
  }
  setInterval(function () { flush(false); }, 4000);
  addEventListener('pagehide', function () { log({ type: 'page', state: 'pagehide' }); flush(true); });
  document.addEventListener('visibilitychange', function () {
    log({ type: 'page', state: document.visibilityState });
    if (document.visibilityState === 'hidden') flush(true);
  });

  var opts = {};
  q.forEach(function (v, k) { opts[k] = v; });
  post('meta.json', JSON.stringify({
    session: session, started: d.toISOString(), url: location.pathname, options: opts,
    userAgent: navigator.userAgent, screen: [screen.width, screen.height], window: [innerWidth, innerHeight],
    dpr: devicePixelRatio, threads: typeof SharedArrayBuffer !== 'undefined' && !!window.crossOriginIsolated,
    touch: navigator.maxTouchPoints || 0
  }, null, 1), false, false);
  log({ type: 'start', session: session });

  // ---- what the mod says: wrap Module.se1ModUi (survivors.js defines it before this script runs)
  var lastHud = 0;
  var inner = Module.se1ModUi;
  Module.se1ModUi = function (json) {
    var m = null;
    try { m = JSON.parse(json); } catch (e) {}
    if (m && (m.type === 'tel' || m.type === 'tel_level')) { log(m); return; }   // ours only: not for survivors.js
    if (m) {
      if (m.type === 'hud') {
        var t = performance.now();
        if (t - lastHud >= 500) { lastHud = t; log({ type: 'hud', hud: m }); }
      } else if (m.type !== 'fx') {          // fx: visual effects, many per second, no signal
        log({ type: 'mod', msg: m });
      }
      if (m.type === 'end') setTimeout(function () { survey('run ended'); }, 4000);
    }
    if (inner) return inner(json);
  };
  // the page's answers to the mod (card picks, rerolls, skips, chest, endless)
  var hooked = false;
  function hookSend() {
    if (hooked || !Module._SE1Mod_UiSend) return;
    var send = Module._SE1Mod_UiSend;
    Module._SE1Mod_UiSend = function (v) { log({ type: 'answer', v: v }); return send(v); };
    hooked = true;
  }

  // ---- input summary, once a second
  var inp = { keys: 0, codes: {}, mouse: 0, clicks: 0, wheel: 0 };
  addEventListener('keydown', function (e) {
    if (e.code === 'F7' || e.code === 'F8' || e.code === 'F10') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) mark(e.code === 'F7' ? 'fun' : e.code === 'F8' ? 'boring' : 'bug');
      return;
    }
    if (!e.repeat) { inp.keys++; inp.codes[e.code] = (inp.codes[e.code] || 0) + 1; }
  }, true);
  addEventListener('mousemove', function (e) { inp.mouse += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0); }, true);
  addEventListener('mousedown', function () { inp.clicks++; }, true);
  addEventListener('wheel', function () { inp.wheel++; }, { capture: true, passive: true });

  function want() { try { return Module._SE1_WantPointer ? Module._SE1_WantPointer() : -1; } catch (e) { return -1; } }
  var lastPerfN = 0;
  setInterval(function () {
    hookSend();
    var device = (Module.se1Touch && Module.se1Touch.active) ? 'touch'
      : (Module.se1Pad && Module.se1Pad.connected && Module.se1Pad.lastDevice === 'pad') ? 'pad' : 'mouse';
    log({ type: 'input', keys: inp.keys, codes: inp.codes, mouse: Math.round(inp.mouse), clicks: inp.clicks, wheel: inp.wheel, device: device });
    inp = { keys: 0, codes: {}, mouse: 0, clicks: 0, wheel: 0 };
    // frames and engine work time per frame since the last sample
    var P = Module.se1Perf, perf = null;
    if (P && P.work) {
      var n = P.n, k = Math.min(n - lastPerfN, 600), ms = [];
      for (var i = n - k; i < n; i++) ms.push(P.work[i & 65535]);
      lastPerfN = n;
      ms.sort(function (a, b) { return a - b; });
      perf = { frames: k, p50: ms.length ? +ms[ms.length >> 1].toFixed(2) : null, max: ms.length ? +ms[ms.length - 1].toFixed(2) : null };
    }
    log({ type: 'state', play: want(), locked: !!document.pointerLockElement, hidden: document.hidden,
      fullscreen: !!document.fullscreenElement, perf: perf });
  }, 1000);

  // ---- REC badge with the marker legend and a Finish button
  var badge = document.createElement('div');
  badge.id = 'rec';
  badge.style.cssText = 'position:fixed;top:8px;left:8px;z-index:60;padding:4px 8px;border-radius:6px;' +
    'background:rgba(0,0,0,.55);color:#ddd;font:12px/1.4 system-ui,sans-serif;pointer-events:auto;user-select:none';
  badge.innerHTML = '<span style="color:#e33">&#9679;</span> REC <span id="rec-t">0:00</span>' +
    ' &middot; F7 fun &middot; F8 boring &middot; F10 bug &middot; <a href="#" id="rec-finish" style="color:#ffd75e">Finish</a>';
  function attach() { if (document.body && !badge.parentNode) document.body.appendChild(badge); }
  attach(); document.addEventListener('DOMContentLoaded', attach);
  setInterval(function () {
    var s = Math.floor(now()), el = document.getElementById('rec-t');
    if (el) el.textContent = Math.floor(s / 60) + ':' + pad2(s % 60);
  }, 1000);
  badge.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'rec-finish') { e.preventDefault(); survey('finish button'); }
  });
  function mark(kind) {
    log({ type: 'marker', kind: kind });
    badge.style.background = kind === 'fun' ? 'rgba(40,140,40,.8)' : kind === 'boring' ? 'rgba(160,110,0,.8)' : 'rgba(170,30,30,.8)';
    setTimeout(function () { badge.style.background = 'rgba(0,0,0,.55)'; }, 400);
  }

  // ---- end-of-session survey
  var surveyed = false;
  function survey(why) {
    if (surveyed) return;
    surveyed = true;
    log({ type: 'survey_open', why: why });
    flush(false);
    if (document.pointerLockElement) document.exitPointerLock();
    var o = document.createElement('div');
    o.id = 'rec-survey';
    o.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7)';
    var row = function (name, label, values) {
      return '<div style="margin:10px 0 4px;font-weight:600">' + label + '</div><div>' + values.map(function (v) {
        return '<label style="margin-right:10px;white-space:nowrap"><input type="radio" name="' + name + '" value="' + v + '"> ' + v + '</label>';
      }).join('') + '</div>';
    };
    var text = function (name, label) {
      return '<div style="margin:10px 0 4px;font-weight:600">' + label + '</div>' +
        '<textarea name="' + name + '" rows="2" style="width:100%;box-sizing:border-box;background:#111;color:#ddd;border:1px solid #555;border-radius:4px"></textarea>';
    };
    o.innerHTML = '<form style="width:min(520px,calc(100vw - 24px));max-height:90vh;overflow:auto;background:#1a1a1a;color:#ddd;' +
      'border:1px solid #555;border-radius:8px;padding:16px;font:14px/1.4 system-ui,sans-serif">' +
      '<h2 style="margin:0 0 6px;font-size:17px;color:#ffd75e">How was it?</h2>' +
      row('fun', 'Fun', ['1', '2', '3', '4', '5']) +
      row('pacing', 'Pacing', ['too slow', 'about right', 'too fast']) +
      row('difficulty', 'Difficulty', ['too easy', 'about right', 'too hard']) +
      text('best', 'Most fun moment') + text('worst', 'Most boring or annoying moment') + text('other', 'Anything else') +
      '<div style="margin-top:14px;display:flex;gap:8px"><button type="submit" style="flex:1;padding:8px">Send</button>' +
      '<button type="button" id="rec-skip" style="padding:8px">Skip</button></div></form>';
    document.body.appendChild(o);
    var form = o.querySelector('form');
    // typing in the survey must not reach the game
    o.addEventListener('keydown', function (e) { e.stopPropagation(); }, false);
    o.addEventListener('keyup', function (e) { e.stopPropagation(); }, false);
    var done = function (answers) {
      post('survey.json', JSON.stringify({ why: why, at: now(), answers: answers }, null, 1), false, false);
      log({ type: 'survey', answers: answers });
      flush(false);
      o.remove();
      badge.innerHTML = '&#10003; playtest saved: ' + session;
    };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = {};
      new FormData(form).forEach(function (v, k) { a[k] = v; });
      done(a);
    });
    o.querySelector('#rec-skip').addEventListener('click', function () { done(null); });
  }
  Module.se1PlaytestSurvey = survey;    // tests
})();
