/* Hand control back to the browser once per presented frame.
 *
 * The engine's main loop (and its level-loading progress hook) never returns to the browser.
 * With JSPI, blocking calls can suspend the wasm stack: we await the next animation frame
 * after every buffer swap, so Chrome presents the frame we just drew (including loading
 * screens), runs input/audio events, and paces us to vsync. The race with a short timeout
 * keeps loading moving when rAF is throttled (hidden tab).
 *
 * Also:
 *  - per-frame CPU time (work between resuming and the next swap) in Module.se1Perf.work
 *    (ms, ring of the last 65536 frames): vsync hides headroom, this doesn't;
 *  - ?uncapped=1 timedemo mode (no vsync wait);
 *  - ?shots=<label> visual regression capture (SE1_BeforeSwap): frames at fixed demo times are
 *    read back before the swap and POSTed to the dev server.
 */
#include <emscripten.h>
#include <Engine/Engine.h>
#include <Engine/Network/Network.h>

/* demo playback clock in seconds, or -1 when no demo is playing (used by the shot capture) */
extern "C" EMSCRIPTEN_KEEPALIVE float SE1_DemoTime(void)
{
  if (_pNetwork == NULL || !_pNetwork->ga_bDemoPlay) return -1.0f;
  return _pNetwork->ga_fDemoTimer;
}

EM_JS(void, se1_capture_frame, (void), {
  var S = Module.se1Shots;
  if (S && !S.done && typeof GL !== 'undefined' && GL.currentContext) {
    var t = Module._SE1_DemoTime();
    while (t >= 0 && S.i < S.times.length && t >= S.times[S.i]) {
      var tname = 't' + String(Math.round(S.times[S.i] * 100)).padStart(5, '0');
      S.pending++;
      Module['se1gfx'].capture(function (px, w, h) {   /* bottom-up RGBA from either replayer */
        fetch('/__shots/' + encodeURIComponent(S.label) + '/' + tname + '_' + w + 'x' + h + '.rgba', { method: 'POST', body: px })
          .finally(function() { S.pending--; if (S.done && S.pending === 0) window.__shotsDone = true; });
      });
      S.i++;
    }
    if (S.i >= S.times.length) { S.done = true; if (S.pending === 0) window.__shotsDone = true; }
  }

});

EM_ASYNC_JS(void, se1_wait_frame, (void), {
  var P = Module.se1Perf || (Module.se1Perf = { work: new Float32Array(65536), n: 0, resumed: 0 });
  var now = performance.now();
  if (P.resumed) { P.work[P.n & 65535] = now - P.resumed; P.n++; }

  if (Module.se1Uncapped) {
    /* benchmark "timedemo" mode: don't wait for vsync, just let the browser run its task queue
       (MessageChannel messages aren't throttled); throughput = frames rendered per second.
       One GPU sync per frame keeps the GPU queue bounded without vsync backpressure (the
       shim turns the engine's own glFinish into a no-op for normal, rAF-paced play). */
    var sync = Module['se1gfx'] && Module['se1gfx'].sync();   /* WebGL2: finish(); WebGPU: a promise */
    if (sync) await sync;
    var mc = Module.se1MC || (Module.se1MC = new MessageChannel());
    await new Promise(function(resolve) { mc.port1.onmessage = resolve; mc.port2.postMessage(0); });
    P.resumed = performance.now();
    return;
  }
  await new Promise(function(resolve) {
    var timer = 0, raf = 0;
    var finish = function() { cancelAnimationFrame(raf); clearTimeout(timer); resolve(); };
    raf = requestAnimationFrame(finish);
    timer = setTimeout(finish, 100);   /* hidden tab: rAF is throttled */
  });
  P.resumed = performance.now();

  /* ?scale=auto: dynamic resolution. Frames arriving late while the CPU work leaves headroom means
     the GPU is the bottleneck: render fewer pixels. Raise the scale again when frames are on time.
     The vsync interval is estimated as the shortest recent frame interval. */
  var D = Module.se1Drs;
  if (D) {
    var tn = P.resumed;
    if (D.last) {
      var dt = tn - D.last;
      if (dt < 100) {   /* ignore loading stalls and hidden-tab frames */
        D.vs = D.vs ? Math.min(D.vs * 1.002 + 0.001, Math.max(dt, 4)) : dt;
        D.ema = D.ema ? D.ema * 0.9 + dt * 0.1 : dt;
        var wk = P.work[(P.n - 1) & 65535] || 0;
        D.work = D.work ? D.work * 0.9 + wk * 0.1 : wk;
        D.n = (D.n || 0) + 1;
        /* hysteresis: step down only on repeated late frames (not one hitch), step up only after
           ~3 s without any, so the resolution doesn't pump */
        var late = dt > D.vs * 1.5;
        D.lateWin = (D.lateWin || 0) + (late ? 1 : 0);
        D.sinceLate = late ? 0 : (D.sinceLate || 0) + 1;
        if (D.n % 30 === 0) {
          var cs = Module.se1Scale || 1, ns = cs;
          if (D.lateWin >= 2 && D.work < D.vs * 0.6) ns = Math.max(D.min, cs * 0.85);
          else if (D.sinceLate > 180 && cs < 1) { ns = Math.min(1, cs * 1.06); D.sinceLate = 0; }
          ns = Math.round(ns * 20) / 20;
          if (ns !== cs) { Module.se1Scale = ns; D.changed = tn; D.changes = (D.changes || 0) + 1; }
          D.lateWin = 0;
        }
      }
    }
    D.last = tn;
  }
});

#ifdef SE1_WITH_RUSTMOD
void SE1Mod_Frame(void);  // port/common/Se1ModHost.cpp
#endif

/* called right before SDL_GL_SwapWindow: Emscripten's SDL yields inside the swap, and the
   browser may present + clear the drawing buffer during that yield, so read frames back here */
extern "C" void SE1_GL1Shim_Flush(void);  // port/common/gl1shim.c: replay this frame's commands

EM_JS(void, se1_end_frame, (void), { if (Module['se1gfx'] && Module['se1gfx'].endFrame) Module['se1gfx'].endFrame(); });

extern "C" void SE1_BeforeSwap(void)
{
  SE1_GL1Shim_Flush();   // the frame must be drawn before it's captured or presented
  se1_capture_frame();
  se1_end_frame();       // e.g. apply a new render scale for the next frame
}

extern "C" void SE1_YieldToBrowser(void)
{
#ifdef SE1_WITH_RUSTMOD
  SE1Mod_Frame();
#endif
  se1_wait_frame();
}
