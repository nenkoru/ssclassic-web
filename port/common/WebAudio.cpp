/* Web Audio output for the engine's SDL sound path (Engine/Sound/SoundLibrary.cpp).
 *
 * Emscripten's SDL2 audio uses a ScriptProcessorNode that pulls samples on the main thread,
 * so any long frame (level load, texture upload, first shader compile) starves it and the
 * output buzzes. Instead we play from an AudioWorklet on the audio rendering thread:
 *   - the engine keeps mixing into its own ring buffer (sdl_backbuffer) as before;
 *   - each MixSounds() we drain from that ring exactly what the worklet will consume to stay
 *     at a target backlog (~150 ms), measured with AudioContext.currentTime, and post it;
 *   - on a hitch the worklet plays its backlog, then silence (never stale or repeated data).
 * Draining at real-time pace keeps the engine's own "free space" based mixing intact.
 * The JS lives in port/web/audio.js (Module.se1audio). In the SE1_THREADS build the engine runs
 * in a worker: it writes into a ring in shared memory that the worklet reads directly (below).
 */
#include <emscripten.h>
#include <stdint.h>

#ifdef SE1_THREADS
/* SharedArrayBuffer ring (notes/nfsu2-tricks.md §4): the worklet reads interleaved int16 frames
   straight from wasm memory, so mixing needs no main-thread round trip. Indices are frame counts
   that wrap at 2^32; the backlog is write - read, exact (no clock estimate needed). */
#include <emscripten/threading.h>
#include <emscripten/atomic.h>
#include <string.h>
enum { RING_FRAMES = 32768 };                 /* ~0.74 s at 44.1 kHz; the target backlog is 0.15 s */
static int16_t _ring[RING_FRAMES * 2] __attribute__((aligned(16)));
static int32_t _ctl[4] __attribute__((aligned(16)));   /* write, read, flush generation, channels */
static int _rate = 44100, _ch = 2;
extern "C" {
void SE1_WebAudio_Init(int iRate, int ctChannels) {
  _rate = iRate; _ch = ctChannels > 1 ? 2 : 1;
  emscripten_atomic_store_u32(&_ctl[3], (uint32_t)_ch);
  emscripten_atomic_add_u32(&_ctl[2], 1);     /* drop anything queued in the old format */
  MAIN_THREAD_EM_ASM({ Module['se1audio'].initRing($0, $1, $2, $3, $4); }, iRate, _ch, _ring, RING_FRAMES, _ctl);
}
int SE1_WebAudio_WantedFrames(void) {
  int32_t queued = (int32_t)(emscripten_atomic_load_u32(&_ctl[0]) - emscripten_atomic_load_u32(&_ctl[1]));
  if (queued < 0) queued = 0;
  int32_t want = (int32_t)(0.15 * _rate) - queued;
  if (want > RING_FRAMES - queued) want = RING_FRAMES - queued;
  return want > 0 ? want : 0;
}
void SE1_WebAudio_Push(const int16_t *pswPCM, int ctFrames) {
  uint32_t w = emscripten_atomic_load_u32(&_ctl[0]);
  for (int i = 0; i < ctFrames; i++) {        /* the ring is always stereo-strided */
    uint32_t o = ((w + (uint32_t)i) % RING_FRAMES) * 2;
    _ring[o] = pswPCM[i * _ch];
    _ring[o + 1] = _ch > 1 ? pswPCM[i * _ch + 1] : pswPCM[i * _ch];
  }
  emscripten_atomic_store_u32(&_ctl[0], w + (uint32_t)ctFrames);   /* publish after the data */
}
void SE1_WebAudio_Flush(void) { emscripten_atomic_add_u32(&_ctl[2], 1); }
}
#else
EM_JS(void, se1_wa_init, (int rate, int channels, double targetSec), { Module['se1audio'].init(rate, channels, targetSec); });
EM_JS(int, se1_wa_wanted, (void), { return Module['se1audio'].wanted(); });
EM_JS(void, se1_wa_push, (const int16_t *pcm, int frames), { Module['se1audio'].push(pcm, frames); });
EM_JS(void, se1_wa_flush, (void), { Module['se1audio'].flush(); });
extern "C" {
void SE1_WebAudio_Init(int iRate, int ctChannels) { se1_wa_init(iRate, ctChannels, 0.15); }
int SE1_WebAudio_WantedFrames(void) { return se1_wa_wanted(); }
void SE1_WebAudio_Push(const int16_t *pswPCM, int ctFrames) { se1_wa_push(pswPCM, ctFrames); }
void SE1_WebAudio_Flush(void) { se1_wa_flush(); }
}
#endif
