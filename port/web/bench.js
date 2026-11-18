// Demo benchmark driver: paste-free version of the in-page harness. Loaded only with ?bench=1.
// Measures CPU ms per frame (Module.se1Perf, port/common/WebFrame.cpp) between the demo start
// (+1 s warm-up) and its end ("stopping game"), and whether the page stayed visible.
(function () {
  if (!new URLSearchParams(location.search).get('bench')) return;
  var B = window.__bench = { state: 'waiting', stats: null, hiddenMs: 0 };
  var lastVis = performance.now();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) lastVis = performance.now(); else if (B.state === 'running') B.hiddenMs += performance.now() - lastVis;
  });
  var t = setInterval(function () {
    var log = '';
    try { log = FS.readFile('/libsdl/Serious-Engine/serioussam/SeriousSam.log', { encoding: 'utf8' }); } catch (e) { return; }
    var now = performance.now();
    if (B.state === 'waiting' && log.indexOf('Started playing demo') >= 0) { B.state = 'warmup'; B.warmT = now; }
    else if (B.state === 'warmup' && now - B.warmT > 1000) {
      B.state = 'running'; B.startT = now; B.logAt = log.length; Module.se1Perf.n = 0;
      // presented-frame intervals (what the player sees), independent of CPU work time
      B.iv = []; var lastRaf = 0;
      (function rafLoop(ts) { if (lastRaf) B.iv.push(ts - lastRaf); lastRaf = ts; if (B.state === 'running') requestAnimationFrame(rafLoop); })(0);
      // ?profile=1: sample the demo window with the JS Self-Profiling API (needs the
      // Document-Policy: js-profiling header, sent by tools/devserver.py)
      if (new URLSearchParams(location.search).get('profile') && typeof Profiler !== 'undefined') {
        B.profiler = new Profiler({ sampleInterval: 1, maxBufferSize: 1000000 });
      }
      // ?glstats=1: count WebGL draws and how many could merge with the previous draw
      // (only vertex/index upload calls in between, no state change)
      if (new URLSearchParams(location.search).get('glstats') && GL.currentContext) {
        var gl = GL.currentContext.GLctx;
        var G = B.gl = { draws: 0, mergeable: 0, calls: 0, byName: {}, cleanSinceDraw: false, drawsWhileLastWasDraw: 0 };
        var neutral = { bufferData: 1, bufferSubData: 1, bindBuffer: 1, vertexAttribPointer: 1,
                        enableVertexAttribArray: 1, disableVertexAttribArray: 1 };
        for (var k in gl) {
          if (typeof gl[k] !== 'function') continue;
          (function (name, fn) {
            gl[name] = function () {
              G.calls++; G.byName[name] = (G.byName[name] || 0) + 1;
              if (name === 'drawElements' || name === 'drawArrays') {
                G.draws++;
                if (G.cleanSinceDraw) G.mergeable++;
                G.cleanSinceDraw = true;
              } else if (!neutral[name]) {
                G.cleanSinceDraw = false;
              }
              return fn.apply(gl, arguments);
            };
          })(k, gl[k]);
        }
      }
    }
    else if (B.state === 'running' && log.slice(B.logAt).indexOf('stopping game') >= 0) {
      var P = Module.se1Perf, n = Math.min(P.n, 65536);
      var a = Array.from(P.work.slice(0, n)).sort(function (x, y) { return x - y; });
      var q = function (p) { return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
      var secs = (now - B.startT) / 1000;
      B.stats = { seconds: +secs.toFixed(1), fps: +(P.n / secs).toFixed(1), meanMs: +(a.reduce(function (s, x) { return s + x; }, 0) / a.length).toFixed(2),
        p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +a[a.length - 1].toFixed(1),
        over16_7: a.filter(function (x) { return x > 16.7; }).length,
        frameMs: B.iv.length ? +B.iv.slice().sort(function (x, y) { return x - y; })[B.iv.length >> 1].toFixed(1) : 0,
        lateFrames: (function () { var iv = B.iv.slice().sort(function (x, y) { return x - y; }), med = iv[iv.length >> 1] || 0;
                                   return B.iv.filter(function (x) { return x > med * 1.5; }).length; })(),
        presented: B.iv.length, backend: Module['se1gfx'] && Module['se1gfx'].backend, scale: Module['se1Scale'] || 1, scaleChanges: (Module['se1Drs'] && Module['se1Drs'].changes) || 0, hiddenMs: Math.round(B.hiddenMs + (document.hidden ? now - lastVis : 0)) };
      clearInterval(t);
      if (B.gl) {
        var G = B.gl, fr = Math.max(1, P.n);
        var top = Object.keys(G.byName).sort(function (a, b) { return G.byName[b] - G.byName[a]; }).slice(0, 15)
          .map(function (n) { return n + ' ' + (G.byName[n] / fr).toFixed(1); });
        B.stats.gl = { drawsPerFrame: +(G.draws / fr).toFixed(1), mergeablePerFrame: +(G.mergeable / fr).toFixed(1),
                       callsPerFrame: +(G.calls / fr).toFixed(1), topCallsPerFrame: top };
      }
      if (B.profiler) {
        B.state = 'profiling';
        B.profiler.stop().then(function (tr) {
          var self = {}, incl = {}, total = 0;
          var name = function (fi) { var f = tr.frames[fi]; return f.name || '(anonymous)'; };
          tr.samples.forEach(function (s) {
            if (s.stackId === undefined) return; // idle
            total++;
            var st = tr.stacks[s.stackId], top = true, seen = {};
            while (st) {
              var nm = name(st.frameId);
              if (top) { self[nm] = (self[nm] || 0) + 1; top = false; }
              if (!seen[nm]) { incl[nm] = (incl[nm] || 0) + 1; seen[nm] = 1; }
              st = st.parentId !== undefined ? tr.stacks[st.parentId] : null;
            }
          });
          var topN = function (o, k) {
            return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, k)
              .map(function (n) { return (100 * o[n] / total).toFixed(1) + '%  ' + n; });
          };
          B.stats.profile = { busySamples: total, self: topN(self, 30), inclusive: topN(incl, 40) };
          B.state = 'done';
        });
      } else {
        B.state = 'done';
      }
      console.log('BENCH ' + JSON.stringify(B.stats));
    }
  }, 50);
})();
