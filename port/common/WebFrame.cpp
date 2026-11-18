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
      var gl = GL.currentContext.GLctx, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      var px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var name = 't' + String(Math.round(S.times[S.i] * 100)).padStart(5, '0') + '_' + w + 'x' + h + '.rgba';
      S.pending++;
      fetch('/__shots/' + encodeURIComponent(S.label) + '/' + name, { method: 'POST', body: px })
        .finally(function() { S.pending--; if (S.done && S.pending === 0) window.__shotsDone = true; });
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
    if (typeof GL !== 'undefined' && GL.currentContext) GL.currentContext.GLctx.finish();
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
});

#ifdef SE1_WITH_RUSTMOD
void SE1Mod_Frame(void);  // port/common/Se1ModHost.cpp
#endif

/* called right before SDL_GL_SwapWindow: Emscripten's SDL yields inside the swap, and the
   browser may present + clear the drawing buffer during that yield, so read frames back here */
extern "C" void SE1_BeforeSwap(void)
{
  se1_capture_frame();
}

extern "C" void SE1_YieldToBrowser(void)
{
#ifdef SE1_WITH_RUSTMOD
  SE1Mod_Frame();
#endif
  se1_wait_frame();
}
