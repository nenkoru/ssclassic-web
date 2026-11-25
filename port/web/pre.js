// Runs before the engine module starts (linked with --pre-js).
// ?args=+script%20SE1Mod/bench.ini  ->  engine command line "+script SE1Mod/bench.ini"
// ?bench=1                          ->  shorthand for the demo benchmark
(function () {
  var q = new URLSearchParams(location.search);
  var args = [];
  if (q.get('bench')) args.push('+script', 'SE1Mod/bench.ini');
  if (q.get('args')) args = args.concat(q.get('args').split(' ').filter(Boolean));
  if (args.length) Module['arguments'] = args;
  if (q.get('uncapped') === '1') Module['se1Uncapped'] = true;
  if (q.get('spin') === '0' || q.get('spin') === '1') Module['se1Spin'] = +q.get('spin');   // threaded vsync wait (WebFrame.cpp)   // timedemo: no vsync wait (port/common/WebFrame.cpp)
  // ?quality=auto: the Rust mod layer lowers rendering cvars while frames keep missing
  if (q.get('quality') === 'auto') Module['se1QualityAuto'] = 1;
  // ?bots=N: N AI co-op bots on the host (rust/se1-mod/src/bots); ?botskill=0..1 their skill
  if (q.get('bots')) Module['se1Bots'] = Math.min(255, Math.max(0, +q.get('bots') || 0));
  if (q.get('botskill')) Module['se1BotSkill'] = Math.min(1, Math.max(0, +q.get('botskill')));
  // ?navbake=1 (tools/navbake.mjs): bake the level's bot nav graph once a player is in it
  if (q.get('navbake')) Module['se1NavBake'] = 1;
  // ?botroam=N (tools/navroamtest.mjs): bots ignore the players and roam to random points up to N m away
  if (q.get('botroam')) Module['se1BotRoam'] = Math.max(0, +q.get('botroam') || 0);
  // ?vrange=0: gl1shim copies the whole client array [0, maxIndex] for indexed draws instead of
  // just the range the indices use (A/B switch for tools/vrangetest.mjs; 1 is the default)
  if (q.get('vrange') === '0') Module['se1VRange'] = 0;
  // ?gpuanim=0|1: model animation + lighting in the vertex shader, instanced draws (WebGL2 only;
  // port/common/GpuAnim.cpp). Console: mdl_bGpuAnim. Unset: GpuAnim.cpp's default.
  if (q.get('gpuanim') === '0' || q.get('gpuanim') === '1') Module['se1GpuAnim'] = +q.get('gpuanim');
  // ?scale=0.5 renders at half resolution (engine/HUD/input stay at full logical size);
  // ?scale=auto = dynamic resolution: lowers it while frames are GPU-bound, raises it with headroom
  var sc = q.get('scale');
  if (sc === 'auto') Module['se1Drs'] = { min: 0.5 };
  else if (sc && +sc > 0) Module['se1Scale'] = Math.min(1, +sc);
  // ?post=fxaa,sharpen enables the post-processing chain (gfx.js); ?postsharp=0..1 scales the
  // sharpen strength (default 0.5)
  var post = q.get('post');
  if (post) {
    var ps = +q.get('postsharp');
    Module['se1PostOpts'] = { effects: post.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
                              sharp: isNaN(ps) ? 0.5 : Math.min(1, Math.max(0, ps)) };
  }
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
// ?res=640x480: start the engine at that resolution (applied in C by SE1_ApplyWebStartup in
// port/common/WebFrame.cpp, before the first video mode is set; works in both builds).
(function () {
  var m = /^(\d+)x(\d+)$/.exec(new URLSearchParams(location.search).get('res') || '');
  if (m) Module['se1Res'] = [+m[1], +m[2]];
})();

Module['preRun'] = (Module['preRun'] || []).concat([function () {
  if (!FS.lookupNode) return;   // WASMFS (threaded build): port/common/CaseFs.c does this in C
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

// Engine console -> page console: drain the engine's console ring (port/common/WebFrame.cpp) four
// times a second and console.log each whole line. The mod's own lines ("se1mod...") are skipped:
// the mod host already logs those as "[se1mod] ...", right away.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var tail = -1, part = '', dec = new TextDecoder();
  setInterval(function () {
    if (!Module['_SE1_ConsoleHead'] || !Module.HEAPU8) return;
    var head = Module['_SE1_ConsoleHead']() >>> 0, size = Module['_SE1_ConsoleRingSize']();
    if (tail < 0) tail = head > size ? (head - size) >>> 0 : 0;
    var n = (head - tail) >>> 0;
    if (!n) return;
    if (n > size) { console.warn('[engine] console ring overran, ' + (n - size) + ' bytes lost'); tail = (head - size) >>> 0; n = size; }
    var ring = Module['_SE1_ConsoleRing'](), bytes = new Uint8Array(n), start = tail % size;
    var first = Math.min(n, size - start);
    bytes.set(Module.HEAPU8.subarray(ring + start, ring + start + first), 0);
    if (first < n) bytes.set(Module.HEAPU8.subarray(ring, ring + n - first), first);
    tail = head;
    var lines = (part + dec.decode(bytes)).split('\n');
    part = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/\r$/, '');
      if (l && l.lastIndexOf('se1mod', 0) !== 0) console.log(l);
    }
  }, 250);
})();

// Console command (dev tools: tools/se1d.mjs): Module.se1Cmd('sam_bShowAllLevels=1') queues one
// console line; the engine runs it on its own thread at the next frame (port/common/WebFrame.cpp)
// and logs "web: > <line>". Lines queue here while the engine's one-line slot is busy.
Module['se1Cmd'] = function (line) {
  var q = Module.se1CmdQueue || (Module.se1CmdQueue = []);
  line = String(line).trim();
  if (!/;$/.test(line)) line += ';';   // shell statements end with ';'
  q.push(line);
  if (q.length === 1) setTimeout(Module.se1CmdPump, 0);
  return q.length;
};
Module.se1CmdPump = function () {
  var q = Module.se1CmdQueue;
  if (!q || !q.length) return;
  if (!Module['_SE1_CommandBuffer']) { setTimeout(Module.se1CmdPump, 100); return; }
  var bytes = new TextEncoder().encode(q[0]).subarray(0, 4095);
  var ptr = Module['_SE1_CommandBuffer']();
  // the slot is only written while the engine isn't reading it: CommandCommit refuses while busy
  if (Module['_SE1_CommandBusy']()) { setTimeout(Module.se1CmdPump, 16); return; }
  Module.HEAPU8.set(bytes, ptr);
  if (!Module['_SE1_CommandCommit'](bytes.length)) { setTimeout(Module.se1CmdPump, 16); return; }
  q.shift();
  if (q.length) setTimeout(Module.se1CmdPump, 16);
};

// Visual regression capture (?shots=): called once per frame right before the swap, after the
// frame's commands were replayed. Grabs frames at fixed demo times via the active replayer.
Module['se1CaptureFrame'] = function (tDemo) {
  var S = Module.se1Shots;
  if (!S || S.done || !Module['se1gfx']) return;
  // demo time of the frame being shown: passed by the threaded build (the engine is a frame ahead)
  var t = tDemo !== undefined ? tDemo : Module._SE1_DemoTime();
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

// SE1_THREADS: one batch of recorded commands from the engine worker (gl1shim hand_off). Replays
// it; at the end of a frame (present) also runs the ?shots= capture and ends the frame, all in this
// one task. Then frees the batch for the worker (busy flag in shared memory). Timedemo mode: the
// per-frame GPU sync happens here, so the worker never waits for it.
Module['se1ReplayBatch'] = function (busy, present, c, n, v, nv, ix, ni, d, nd, tDemo) {
  var g = Module['se1gfx'], R = Module.se1Replay || (Module.se1Replay = { ms: new Float32Array(65536), n: 0, acc: 0 });
  var t0 = performance.now();
  try {
    if (g && (n || nv || ni)) g.replay(c, n, v, nv, ix, ni, d, nd);
    if (present) {
      if (Module['se1CaptureFrame']) Module['se1CaptureFrame'](tDemo);
      if (g && g.endFrame) g.endFrame();
      if (Module.se1Uncapped && g && g.sync) g.sync();
    }
  } finally {
    Atomics.store(HEAP32, busy >> 2, 0);
    Atomics.notify(HEAP32, busy >> 2);
    // main-thread replay time per frame (all batches of the frame), for the benchmark
    R.acc += performance.now() - t0;
    if (present) { R.ms[R.n & 65535] = R.acc; R.n++; R.acc = 0; }
  }
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

// WASMFS (SE1_THREADS build) has no lookup hook: Windows-style case-insensitive paths are
// resolved in C instead (port/common/CaseFs.c wraps fopen/open/opendir).
