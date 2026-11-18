// Runs before the engine module starts (linked with --pre-js).
// ?args=+script%20SE1Mod/bench.ini  ->  engine command line "+script SE1Mod/bench.ini"
// ?bench=1                          ->  shorthand for the demo benchmark
(function () {
  var q = new URLSearchParams(location.search);
  var args = [];
  if (q.get('bench')) args.push('+script', 'SE1Mod/bench.ini');
  if (q.get('args')) args = args.concat(q.get('args').split(' ').filter(Boolean));
  if (args.length) Module['arguments'] = args;
  if (q.get('uncapped') === '1') Module['se1Uncapped'] = true;   // timedemo: no vsync wait (port/common/WebFrame.cpp)
  // ?scale=0.5 renders at half resolution (engine/HUD/input stay at full logical size);
  // ?scale=auto = dynamic resolution: lowers it while frames are GPU-bound, raises it with headroom
  var sc = q.get('scale');
  if (sc === 'auto') Module['se1Drs'] = { min: 0.5 };
  else if (sc && +sc > 0) Module['se1Scale'] = Math.min(1, +sc);
  // ?shots=<label>: deterministic demo replay, capture frames at fixed demo times and POST them
  // to the dev server (tools/devserver.py saves them under data/shots/<label>/). Starts at 3 s:
  // lens flares fade on wall-clock time, so the first second varies run to run.
  if (q.get('shots')) {
    Module['arguments'] = (Module['arguments'] || []).concat(['+script', 'SE1Mod/shots.ini']);
    Module['se1Shots'] = { label: q.get('shots'), times: [3, 5, 7, 9, 11, 13, 15, 17], i: 0, pending: 0, done: false };
  }
})();

// Windows file-name semantics: Croteam's code, scripts and every community mod assume
// case-insensitive paths ("demos\x.dem" for "Demos/x.dem"). Emscripten resolves every path
// component through FS.lookupNode; when the exact name is missing, fall back to a
// case-insensitive match in that directory. Exact matches stay the fast path.
// ?res=640x480: start the engine at that resolution. Resolution is a persistent console
// variable read from Scripts/PersistentSymbols.ini in the user folder before the window is
// created (changing it later from a script via ApplyVideoMode() aborts the script).
Module['preRun'] = (Module['preRun'] || []).concat([function () {
  var m = /^(\d+)x(\d+)$/.exec(new URLSearchParams(location.search).get('res') || '');
  if (!m) return;
  var dir = '/libsdl/Serious-Engine/' + (Module['se1Game'] || 'serioussam') + '/Scripts';
  FS.mkdirTree(dir);
  FS.writeFile(dir + '/PersistentSymbols.ini',
    'sam_iScreenSizeI = ' + m[1] + ';\nsam_iScreenSizeJ = ' + m[2] + ';\n');
}]);

Module['preRun'] = (Module['preRun'] || []).concat([function () {
  var lookupNode = FS.lookupNode;
  FS.lookupNode = function (parent, name) {
    try {
      return lookupNode.call(FS, parent, name);
    } catch (e) {
      if (!(e instanceof FS.ErrnoError) || e.errno !== 44 /* ENOENT */) throw e;
      var contents = parent && parent.contents, lower = name.toLowerCase();
      if (contents && typeof contents === 'object' && !ArrayBuffer.isView(contents)) {
        for (var k in contents) {
          if (k.toLowerCase() === lower) return lookupNode.call(FS, parent, k);
        }
      }
      throw e;
    }
  };
}]);

// Visual regression capture (?shots=): called once per frame right before the swap, after the
// frame's commands were replayed. Grabs frames at fixed demo times via the active replayer.
Module['se1CaptureFrame'] = function () {
  var S = Module.se1Shots;
  if (!S || S.done || !Module['se1gfx']) return;
  var t = Module._SE1_DemoTime();
  while (t >= 0 && S.i < S.times.length && t >= S.times[S.i]) {
    var tname = 't' + String(Math.round(S.times[S.i] * 100)).padStart(5, '0');
    S.pending++;
    Module['se1gfx'].capture(function (px, w, h) {   // bottom-up RGBA from either replayer
      fetch('/__shots/' + encodeURIComponent(S.label) + '/' + tname + '_' + w + 'x' + h + '.rgba', { method: 'POST', body: px })
        .finally(function () { S.pending--; if (S.done && S.pending === 0) window.__shotsDone = true; });
    });
    S.i++;
  }
  if (S.i >= S.times.length) { S.done = true; if (S.pending === 0) window.__shotsDone = true; }
};

// SE1_THREADS build (port/common/WebFrame.cpp): runs on the page's main thread. Bumps a shared
// counter on every animation frame (and every 100 ms while hidden, so the simulation keeps going),
// which the engine worker waits on after each frame, and exposes the worker's per-frame CPU times
// (a ring in shared memory) as Module.se1Perf, the same shape the single-threaded build uses.
Module['se1StartFrameLoop'] = function (tickPtr, nPtr, workPtr) {
  var tick = tickPtr >> 2;
  var n = nPtr >> 2;
  var work = workPtr >> 2;
  Module.se1Perf = {
    get n() { return Atomics.load(HEAP32, n); },
    set n(v) { Atomics.store(HEAP32, n, v); },
    get work() { return HEAPF32.subarray(work, work + 65536); }
  };
  function bump() { Atomics.add(HEAP32, tick, 1); Atomics.notify(HEAP32, tick); }
  (function raf() { bump(); requestAnimationFrame(raf); })();
  setInterval(function () { if (document.hidden) bump(); }, 100);
};
