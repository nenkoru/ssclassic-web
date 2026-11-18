// Web Audio output for the engine's SDL sound path (see port/common/WebAudio.cpp for the design).
// Lives in a pre-js module so both builds can reach it: the single-threaded build calls it from
// EM_JS, the SE1_THREADS build from the engine worker via MAIN_THREAD_EM_ASM (an AudioContext
// only exists on the page's main thread). PCM pointers are into (shared) wasm memory.
Module['se1audio'] = {
  init: function (rate, channels, targetSec) {
    if (Module.se1Audio) {          // re-init (e.g. sound format changed): retune, keep context
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
      A.ctx = new AudioContext();   // browser picked its rate; worklet resamples
    }
    // worklet: queue of interleaved Float32Array chunks; nearest-neighbour resampling when the
    // context rate differs from the engine rate; silence when the queue is empty
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
    A.ctx.audioWorklet.addModule(url).then(function () {
      A.node = new AudioWorkletNode(A.ctx, 'se1-player',
        { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { ch: A.ch, rate: A.rate } });  // current values: init may have run again
      // ?mute=1 (and the ?bench=1 benchmark): keep the whole audio path running, just silent
      var q = new URLSearchParams(location.search);
      if (!q.has('mute') && !q.has('bench')) A.node.connect(A.ctx.destination);
    }).catch(function (e) { console.error('se1 audio: worklet failed', e); });
    // autoplay policy: resume on the first user gesture
    var resume = function () { if (A.ctx.state !== 'running') A.ctx.resume(); };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, resume, true); });
  },

  // how many frames the worklet needs to get back to the target backlog
  wanted: function () {
    var A = Module.se1Audio;
    if (!A || !A.node || A.ctx.state !== 'running') return 0;
    var now = A.ctx.currentTime;
    if (!A.started) { A.started = true; A.t0 = now; A.framesSent = 0; }
    var consumed = (now - A.t0) * A.rate;
    var queued = A.framesSent - consumed;
    if (queued < 0) {            // underrun: restart the clock from "empty"
      A.t0 = now; A.framesSent = 0; queued = 0;
    }
    var want = Math.floor(A.target * A.rate - queued);
    return want > 0 ? want : 0;
  },

  push: function (pcm, frames) {
    var A = Module.se1Audio;
    if (!A || !A.node || frames <= 0) return;
    var n = frames * A.ch, f = new Float32Array(n);
    var src = HEAP16.subarray(pcm >> 1, (pcm >> 1) + n);   // view, no copy
    for (var i = 0; i < n; i++) f[i] = src[i] * (1 / 32768);
    A.node.port.postMessage(f, [f.buffer]);
    A.framesSent += frames;
    A.totalPushed += frames;
  },

  flush: function () {
    var A = Module.se1Audio;
    if (!A || !A.node) return;
    A.node.port.postMessage('flush');
    A.started = false;
  }
};
