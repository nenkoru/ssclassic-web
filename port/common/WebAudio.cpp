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
 * in a worker, which has no AudioContext, so calls are proxied to the main thread.
 * TODO (threads): a SharedArrayBuffer ring read by the worklet directly (notes/nfsu2-tricks.md §4).
 */
#include <emscripten.h>
#include <stdint.h>

#ifdef SE1_THREADS
#include <emscripten/threading.h>
extern "C" {
void SE1_WebAudio_Init(int iRate, int ctChannels) { MAIN_THREAD_EM_ASM({ Module['se1audio'].init($0, $1, 0.15); }, iRate, ctChannels); }
int SE1_WebAudio_WantedFrames(void) { return MAIN_THREAD_EM_ASM_INT({ return Module['se1audio'].wanted(); }); }
void SE1_WebAudio_Push(const int16_t *pswPCM, int ctFrames) { MAIN_THREAD_EM_ASM({ Module['se1audio'].push($0, $1); }, pswPCM, ctFrames); }
void SE1_WebAudio_Flush(void) { MAIN_THREAD_EM_ASM({ Module['se1audio'].flush(); }); }
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
