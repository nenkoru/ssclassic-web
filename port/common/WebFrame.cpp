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
#include <emscripten/threading.h>
#include <emscripten/atomic.h>
#include <Engine/Engine.h>
#include <Engine/Network/Network.h>
#include <Engine/Base/Shell.h>

/* demo playback clock in seconds, or -1 when no demo is playing (used by the shot capture) */
extern "C" EMSCRIPTEN_KEEPALIVE float SE1_DemoTime(void)
{
  if (_pNetwork == NULL || !_pNetwork->ga_bDemoPlay) return -1.0f;
  return _pNetwork->ga_fDemoTimer;
}
/* web persistence (port/web/persist.js): the page sets the flag through SE1_RequestSave
   (Module.se1SaveNow) on hide/pagehide/periodically; the engine stores its settings on the
   next frame, on this thread. The store itself is in SeriousSam.cpp. */
#ifdef __EMSCRIPTEN__
volatile int32_t se1_saveRequested;   // set by the page (SE1_RequestSave), consumed once per frame here
extern void SE1_StoreSettings(void);  // SeriousSam.cpp
static void se1_maybe_store_settings(void)
{
  if (emscripten_atomic_load_u32((void *)&se1_saveRequested)) {
    emscripten_atomic_store_u32((void *)&se1_saveRequested, 0);
    SE1_StoreSettings();
  }
}

/* engine console -> page console (port/web/pre.js drains it): CConsole::PutString copies its text
   into this ring under the console lock (one writer); the page reads [its tail, head) a few times
   a second and logs whole lines with console.log. The engine never waits for the page, so a slow
   main thread can only lose text (the page reports how much), not stall a frame. */
static char se1_conRing[1 << 16];
static volatile uint32_t se1_conHead;   // bytes written so far (wraps)
void SE1_WebConsolePut(const char *str)
{
  uint32_t h = se1_conHead;
  for (const char *p = str; *p; p++) se1_conRing[h++ & (sizeof(se1_conRing) - 1)] = *p;
  emscripten_atomic_store_u32((void *)&se1_conHead, h);
}
extern "C" EMSCRIPTEN_KEEPALIVE char *SE1_ConsoleRing(void) { return se1_conRing; }
extern "C" EMSCRIPTEN_KEEPALIVE int SE1_ConsoleRingSize(void) { return sizeof(se1_conRing); }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t SE1_ConsoleHead(void) { return emscripten_atomic_load_u32((void *)&se1_conHead); }

/* console command slot (dev tools: tools/se1d.mjs, Module.se1Cmd in port/web/pre.js): the page
   writes a UTF-8 console line into se1_cmd and commits it; the engine runs it through the shell on
   its own thread at the next frame and echoes it as "web: > ...", so the result lands in the log. */
static char se1_cmd[4096];
static volatile int32_t se1_cmdReady;
extern "C" EMSCRIPTEN_KEEPALIVE char *SE1_CommandBuffer(void) { return se1_cmd; }
extern "C" EMSCRIPTEN_KEEPALIVE int SE1_CommandBusy(void) { return emscripten_atomic_load_u32((void *)&se1_cmdReady) != 0; }
/* returns 0 while the previous command is still waiting for a frame (the caller retries) */
extern "C" EMSCRIPTEN_KEEPALIVE int SE1_CommandCommit(int len)
{
  if (emscripten_atomic_load_u32((void *)&se1_cmdReady)) return 0;
  if (len < 0) len = 0;
  if (len > (int)sizeof(se1_cmd) - 1) len = sizeof(se1_cmd) - 1;
  se1_cmd[len] = 0;
  emscripten_atomic_store_u32((void *)&se1_cmdReady, 1);
  return 1;
}
static void se1_maybe_run_command(void)
{
  if (!emscripten_atomic_load_u32((void *)&se1_cmdReady)) return;
  CTString strCmd = se1_cmd;
  emscripten_atomic_store_u32((void *)&se1_cmdReady, 0);
  CPrintF("web: > %s\n", (const char *)strCmd);
  _pShell->Execute(strCmd);
}
#endif

/* page options that must be in place before the first video mode (SeriousSam.cpp calls this
   right before the command-line script): ?res=WxH. Read through the main thread, which owns the
   page's URL; no file writes (the threaded build's main thread can't use the filesystem). */
void SE1_ApplyWebStartup(void)   /* C++ linkage: declared in SeriousSam.cpp */
{
  int w = MAIN_THREAD_EM_ASM_INT({ return Module['se1Res'] ? Module['se1Res'][0] : 0; });
  int h = MAIN_THREAD_EM_ASM_INT({ return Module['se1Res'] ? Module['se1Res'][1] : 0; });
  if (w > 0 && h > 0) {
    _pShell->SetINDEX("sam_iScreenSizeI", w);
    _pShell->SetINDEX("sam_iScreenSizeJ", h);
    CPrintF("web: start resolution %dx%d (?res=)\n", w, h);
  }
  /* ?room= (virtual LAN multiplayer, port/web/net.js): a fresh visit has no saved connection preset,
     and the game would stop at the "choose your connection" screen before joining. Use the fastest
     preset; the LAN switch is a fast local-like link. */
  int inRoom = MAIN_THREAD_EM_ASM_INT({ return Module.se1Net ? 1 : 0; });
  if (inRoom && _pShell->GetString("sam_strNetworkSettings") == "") {
    _pShell->Execute("sam_strNetworkSettings = \"Scripts\\NetSettings\\5mb-Fiber.ini\";");
    _pShell->Execute("include \"Scripts\\NetSettings\\5mb-Fiber.ini\";");
    CPrintF("web: virtual LAN room, connection preset 5mb-Fiber\n");
  }
}

#ifndef SE1_THREADS
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
#endif

#ifdef SE1_WITH_RUSTMOD
void SE1Mod_Frame(void);  // port/common/Se1ModHost.cpp
#endif

/* called right before SDL_GL_SwapWindow: Emscripten's SDL yields inside the swap, and the
   browser may present + clear the drawing buffer during that yield, so read frames back here */
extern "C" void SE1_GL1Shim_Flush(void);  // port/common/gl1shim.c: replay this frame's commands
extern "C" void SE1_GL1Shim_FlushFrame(void);  // SE1_THREADS: hand the frame over (+ capture + end of frame)

#ifndef SE1_THREADS
EM_JS(void, se1_capture_frame, (void), { if (Module['se1CaptureFrame']) Module['se1CaptureFrame'](); });
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
#ifdef __EMSCRIPTEN__
  se1_maybe_store_settings();
  se1_maybe_run_command();
#endif
  se1_wait_frame();
}
#else  /* SE1_THREADS: the engine runs in a worker (render plan phase 3) */
#include <emscripten/threading.h>
#include <emscripten/atomic.h>

/* Incremented by the page's main thread on every animation frame (and every 100 ms while the tab
   is hidden, so the simulation keeps running for multiplayer). The engine blocks on it after each
   frame instead of awaiting rAF through JSPI. */
static volatile int32_t _vsyncTick;
/* per-frame CPU work time, exposed to the page as Module.se1Perf (same shape as the JSPI build) */
static float _perfWork[65536];
static volatile int32_t _perfN;
static double _resumed;
static int _uncapped = -1;

static void start_main_thread_loop(void)
{
  static int started;
  if (started) return;
  started = 1;
  /* JS in port/web/pre.js: EM_ASM splits its code at top-level commas, so keep it a single call */
  MAIN_THREAD_EM_ASM({ Module['se1StartFrameLoop']($0, $1, $2); }, &_vsyncTick, &_perfN, _perfWork);
}

extern "C" void SE1_BeforeSwap(void)
{
  SE1_GL1Shim_FlushFrame();   // async hand-off; replay + capture + end of frame in one main-thread task
}

extern "C" void SE1_YieldToBrowser(void)
{
  double now = emscripten_get_now();
  if (_resumed > 0) { _perfWork[_perfN & 65535] = (float)(now - _resumed); _perfN = _perfN + 1; }
#ifdef SE1_WITH_RUSTMOD
  SE1Mod_Frame();   /* the Rust mod layer's per-frame hook (as in the single-threaded build) */
#endif
#ifdef __EMSCRIPTEN__
  se1_maybe_store_settings();
  se1_maybe_run_command();
#endif
  start_main_thread_loop();
  if (_uncapped < 0) _uncapped = MAIN_THREAD_EM_ASM_INT({ return Module.se1Uncapped ? 1 : 0; });
  if (_uncapped) {
    /* timedemo: no vsync wait. The GPU sync that keeps the queue bounded runs on the main thread
       at the end of each replayed frame (Module.se1ReplayBatch), so the worker doesn't wait for it;
       the double-buffered hand-off keeps the worker at most one frame ahead. */
  } else {
    /* Adaptive spin-wait for the next vsync tick. On phones (big.LITTLE), a thread that sleeps a large
       part of every frame gets clocked down or moved to a slow core, while the page's main thread
       stays boosted: on a Snapdragon 710 the same frame took 9.4 ms paced vs 4.4 ms uncapped. So when
       the frame's work is a large share of the frame budget, spin instead of sleeping (a busy core
       keeps its clock); fast machines (work a small share) keep sleeping and save power.
       ?spin=0 / ?spin=1 force it off / on. */
    static int spinMode = -2, spinning;
    static double workAvg, intervalAvg = 16.7, lastResumed;
    if (spinMode == -2) spinMode = MAIN_THREAD_EM_ASM_INT({ return Module.se1Spin === undefined ? -1 : Module.se1Spin; });
    if (_resumed > 0) workAvg = workAvg * 0.9 + (now - _resumed) * 0.1;
    if (spinMode >= 0) spinning = spinMode;
    else if (!spinning && workAvg > 0.35 * intervalAvg) spinning = 1;
    else if (spinning && workAvg < 0.12 * intervalAvg) spinning = 0;
    int32_t seen = _vsyncTick;
    if (spinning) {   /* spin, but never long: a hidden tab only ticks every 100 ms */
      double t0 = emscripten_get_now();
      for (unsigned k = 1; emscripten_atomic_load_u32((void *)&_vsyncTick) == (uint32_t)seen; k++)
        if (!(k & 1023) && emscripten_get_now() - t0 > 20.0) break;   /* clock reads are JS calls: rarely */
    }
    while (_vsyncTick == seen) emscripten_futex_wait((void *)&_vsyncTick, (uint32_t)seen, 100.0);
    double t = emscripten_get_now();
    if (lastResumed > 0) {
      double iv = t - lastResumed;
      if (iv > 4.0 && iv < 50.0) intervalAvg = intervalAvg * 0.95 + iv * 0.05;   /* vsync interval */
    }
    lastResumed = t;
  }
  /* SDL's keyboard/mouse/focus callbacks are registered from this thread, so the page queues them
     to it; a thread only runs its queue when it returns to its event loop, which the engine's main
     loop never does. Run them here, once per frame, right after the frame wait and before the engine
     reads input for the next frame, so input that arrived during the wait isn't a frame late. */
  emscripten_current_thread_process_queued_calls();
  _resumed = emscripten_get_now();
}
#endif

