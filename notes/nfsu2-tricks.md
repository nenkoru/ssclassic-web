# nfsu2-web: tricks to reuse (paths relative to refs/nfsu2-web, MIT — keep credit)

## Summary
1. Toolchain: wasi-sdk + their own JS host (no Emscripten). Wasm features: SIMD, exnref EH + sjlj, shared 4 GB imported memory. Not used: memory64, JSPI, asyncify.
2. Main loop: the blocking loop runs unchanged on a pool of Web Workers sharing one memory. Workers sleep and block with `Atomics.wait`. The page thread never blocks (`Atomics.waitAsync` + rAF).
3. Sync file IO: a per-thread RPC slot goes to an I/O worker (OPFS + fetch), with an Atomics doorbell. Lesson learned: wait on the value you just loaded, and slice waits to 1 s.
4. Threads are serialised by a FIFO ticket "big guest lock" (`runtime/web/ticketlock.h`). An unfair mutex starved the audio and loader threads.
5. Graphics: a C D3D9 command recorder writes fixed-width draw records into double-buffered shared memory (`runtime/web/gpu_proto.h`, `gpu_web.c`). A TS encoder (`web/src/gpu/encoder.ts`) reads them in place and issues WebGPU calls.
6. Vertex transform runs on the CPU (`runtime/vsemu.c`). Fixed-function pixel work is one tiny WGSL shader (`FF_FS` in `web/src/gpu/wgsl.ts`: col0×tex0 + alpha test via `override` + fog). One fixed bind-group layout.
7. The pipeline cache is keyed by packed state. The list is kept in localStorage and pre-created at the next start (`loadWarm`/`warmUp`).
8. Textures: DXT goes in natively with BC, else is converted to ASTC, else decoded to BGRA8 on the CPU. All depth is depth32float.
9. Audio: an SPSC float32 ring in the SAB (`runtime/web/audio_proto.h`) is drained by an AudioWorklet (`web/src/audio/worklet.ts`). Adaptive target fill of 512–1024 frames. Cursors keep advancing when nothing consumes, so the game never stalls on audio.
10. Data: the Rust server serves the install dir plus `/data-manifest`. The I/O worker reads 1 MiB blocks and caches them sparsely in OPFS (`web/src/host/datacache.ts`). Saves are an OPFS overlay (`web/src/app/savefs.ts`).
11. Input: a shared mailbox (`runtime/web/input_proto.h`, `web/src/input/index.ts`). `KeyboardEvent.code` maps to scancode. Meta-down releases all keys (macOS). `navigator.keyboard.lock()` in fullscreen. Gamepads polled each frame. We need pointer lock + movementX/Y.
12. Net: one WebSocket per browser to a Rust "virtual LAN switch" (`web/server-rs/crates/lan`, 10.77.x.x virtual IPs, resume token in the first message). UDP is emulated in C over it (`runtime/web/net_lan.c`). The net worker handles packets off the main thread. No WebRTC; NAT is a non-issue.
13. Scale: the roam hub (`crates/roam`) gives each player its nearest ≤64 peers by predictive distance, with hysteresis. They simulated 1400 players and benchmarked 3000. There's a load generator `roamload`. This is the model for our 128-player interest management.
14. Testing: timed input scripts replayed in lockstep with frames (`runtime/autotest.c`), headless Chrome via Playwright (`web/tools/run-suite.mjs`, `browser.mjs`), a log judge (`judge.mjs`), frame dumps plus contact sheets, and multiplayer pair/crowd tests.
15. Gotchas:
    - COOP/COEP headers are required for SharedArrayBuffer.
    - Memory: try a 4 GB max, then fall back to max=initial.
    - WebKit: never GCs worker garbage, and `waitAsync` sometimes isn't woken (bound waits at ~20 ms).
    - Firefox: needs a back-buffer composite.
    - `clock_time_get` is the hottest import, so keep it allocation-free.
    - Signed i32 pointers ≥2 GB need `>>>0`.
    - Signature mismatches link but trap at runtime.
