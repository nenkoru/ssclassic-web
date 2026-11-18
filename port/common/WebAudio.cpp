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
 * No SharedArrayBuffer needed (works without COOP/COEP); see notes/nfsu2-tricks.md §4 for the
 * SAB ring variant if we move to threads later.
 */
#include <emscripten.h>
#include <stdint.h>

EM_JS(void, se1_wa_init, (int rate, int channels, double targetSec), {
  if (Module.se1Audio) {          /* re-init (e.g. sound format changed): retune, keep context */
    var B = Module.se1Audio;
    B.rate = rate; B.ch = channels; B.started = false;
    if (B.node) B.node.port.postMessage({ rate: rate, ch: channels });
    return;
  }
  var A = Module.se1Audio = { rate: rate, ch: channels, target: targetSec, node: null,
                              ctx: null, framesSent: 0, totalPushed: 0, t0: 0, started: false };
  try {
    A.ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  } catch (e) {
    A.ctx = new AudioContext();   /* browser picked its rate; worklet resamples */
  }
  /* worklet: queue of interleaved Float32Array chunks; nearest-neighbour resampling when the
     context rate differs from the engine rate; silence when the queue is empty */
  var src =
    "class SE1Player extends AudioWorkletProcessor {" +
    " constructor(o){ super(); this.q=[]; this.off=0; this.ch=o.processorOptions.ch;" +
    "   this.step=o.processorOptions.rate/sampleRate; this.pos=0; this.has=false; this.b=null; this.o=0;" +
    "   this.port.onmessage=(e)=>{ var d=e.data;" +
    "     if(d==='flush'||(d&&d.rate)){ this.q=[]; this.off=0; this.has=false;" +
    "       if(d.rate){ this.step=d.rate/sampleRate; this.ch=d.ch; } }" +
    "     else this.q.push(d); }; }" +
    " frame(){ while(this.q.length && this.off>=this.q[0].length){ this.q.shift(); this.off=0; }" +
    "   if(!this.q.length) return false; this.b=this.q[0]; this.o=this.off; this.off+=this.ch; return true; }" +
    " process(_, outs){ var out=outs[0], L=out[0], R=out[1]||out[0];" +
    "   for(var i=0;i<L.length;i++){" +
    "     this.pos+=this.step; while(this.pos>=1){ this.pos-=1; this.has=this.frame(); }" +
    "     if(this.has){ L[i]=this.b[this.o]; R[i]=this.ch>1?this.b[this.o+1]:L[i]; } else { L[i]=0; R[i]=0; } }" +
    "   return true; } }" +
    "registerProcessor('se1-player', SE1Player);";
  var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  A.ctx.audioWorklet.addModule(url).then(function() {
    A.node = new AudioWorkletNode(A.ctx, 'se1-player',
      { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { ch: A.ch, rate: A.rate } });  /* current values: init may have run again */
    /* ?mute=1 (and the ?bench=1 benchmark): keep the whole audio path running, just silent */
    var q = new URLSearchParams(location.search);
    if (!q.has('mute') && !q.has('bench')) A.node.connect(A.ctx.destination);
  }).catch(function(e) { console.error('se1 audio: worklet failed', e); });
  /* autoplay policy: resume on the first user gesture */
  var resume = function() { if (A.ctx.state !== 'running') A.ctx.resume(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach(function(ev) { window.addEventListener(ev, resume, true); });
});

/* how many frames the worklet needs to get back to the target backlog */
EM_JS(int, se1_wa_wanted, (void), {
  var A = Module.se1Audio;
  if (!A || !A.node || A.ctx.state !== 'running') return 0;
  var now = A.ctx.currentTime;
  if (!A.started) { A.started = true; A.t0 = now; A.framesSent = 0; }
  var consumed = (now - A.t0) * A.rate;
  var queued = A.framesSent - consumed;
  if (queued < 0) {            /* underrun: restart the clock from "empty" */
    A.t0 = now; A.framesSent = 0; queued = 0;
  }
  var want = Math.floor(A.target * A.rate - queued);
  return want > 0 ? want : 0;
});

EM_JS(void, se1_wa_push, (const int16_t *pcm, int frames), {
  var A = Module.se1Audio;
  if (!A || !A.node || frames <= 0) return;
  var n = frames * A.ch, f = new Float32Array(n);
  var src = HEAP16.subarray(pcm >> 1, (pcm >> 1) + n);   /* view, no copy */
  for (var i = 0; i < n; i++) f[i] = src[i] * (1 / 32768);
  A.node.port.postMessage(f, [f.buffer]);
  A.framesSent += frames;
  A.totalPushed += frames;
});

EM_JS(void, se1_wa_flush, (void), {
  var A = Module.se1Audio;
  if (!A || !A.node) return;
  A.node.port.postMessage('flush');
  A.started = false;
});

extern "C" {
void SE1_WebAudio_Init(int iRate, int ctChannels) { se1_wa_init(iRate, ctChannels, 0.15); }
int SE1_WebAudio_WantedFrames(void) { return se1_wa_wanted(); }
void SE1_WebAudio_Push(const int16_t *pswPCM, int ctFrames) { se1_wa_push(pswPCM, ctFrames); }
void SE1_WebAudio_Flush(void) { se1_wa_flush(); }
}
