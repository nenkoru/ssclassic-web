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
      // ?profile=1: sample the demo window with the JS Self-Profiling API (needs the
      // Document-Policy: js-profiling header, sent by tools/devserver.py)
      if (new URLSearchParams(location.search).get('profile') && typeof Profiler !== 'undefined') {
        B.profiler = new Profiler({ sampleInterval: 1, maxBufferSize: 1000000 });
      }
    }
    else if (B.state === 'running' && log.slice(B.logAt).indexOf('stopping game') >= 0) {
      var P = Module.se1Perf, n = Math.min(P.n, 65536);
      var a = Array.from(P.work.slice(0, n)).sort(function (x, y) { return x - y; });
      var q = function (p) { return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
      var secs = (now - B.startT) / 1000;
      B.stats = { seconds: +secs.toFixed(1), fps: +(P.n / secs).toFixed(1), meanMs: +(a.reduce(function (s, x) { return s + x; }, 0) / a.length).toFixed(2),
        p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +a[a.length - 1].toFixed(1),
        over16_7: a.filter(function (x) { return x > 16.7; }).length, hiddenMs: Math.round(B.hiddenMs + (document.hidden ? now - lastVis : 0)) };
      clearInterval(t);
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
