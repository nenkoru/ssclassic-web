# Render architecture plan: command stream → WebGPU → worker

Status 2026-11-18: proposal. Measurements this builds on are in `notes/plan.md` (Perf log).

## Why

- A frame is ~205 draws and ~2000 WebGL calls (~10 per draw). Every call crosses wasm→JS→WebGL
  validation→Chrome's GPU command buffer.
- On a weak GPU (software-GL proxy), ~13% of frames hitch 20–140 ms when that command buffer backs up.
  This is independent of resolution.
- Draw merging is ruled out: 96% of draws change texture.
- So the cost to remove is *per-call*, and the stall to hide is *in the game thread*.

## Target architecture (same shape as nfsu2-web, see notes/nfsu2-tricks.md §2–§3)

```
 engine thread (worker)                          page main thread
 ─────────────────────                           ────────────────
 game logic, physics, sound mixing               input → mailbox (SAB)
 renderer (CRenderer, BSP, models)               rAF: read frame's command list
 gl1shim: GL1 calls → compact command records ─▶   replay on WebGPU (or WebGL2 fallback)
          + one vertex/index arena per frame       present
 audio mixer → SAB ring ─────────────────────▶   AudioWorklet drains the ring
```

- The engine never touches a graphics API. It writes fixed-size records (state, texture binds, draw
  ranges, uploads) into double-buffered shared memory. The page replays them with **one wasm→JS crossing
  per frame**, not ~2000.
- GPU backpressure then stalls the *replay*, not game logic, sound or input.

## Phases

Each phase must beat the previous one in `tools/bench.mjs`, on both the GPU and `--software-gl`. Each
phase must also pass the visual regression test from phase 0 before it lands.

### Phase 0: visual regression test (small; prerequisite)
- In the timedemo, capture frames at fixed demo times (readPixels → PNG through the dev server). Compare
  against reference images from the current WebGL2 path with a tolerance (`tools/shotdiff`).
- This is needed because phases 1–3 replace the renderer underneath the engine, and the eye alone misses
  regressions like a wrong blend mode on one surface type.

### Phase 1: command stream in gl1shim, replayed on WebGL2 (medium; still single-threaded)
- **Records.** The shim stops calling WebGL. Each GL1-visible state change and draw appends a record:
  - a packed state key: blend / depth / cull / alpha / clip / texenv per unit / program key;
  - texture binds per unit;
  - matrix and uniform blocks, deduplicated;
  - draw ranges into the frame arena.
- **Frame arena.** All vertex and index data for the frame goes in one arena, uploaded with one
  `bufferData` per frame instead of ~390.
- **Resource queue,** ordered against the draws (nfsu2's `gpu_proto.h` pattern):
  - texture create/upload/delete;
  - `readPixels` needs a sync point: screenshots only, since depth reads are already stubbed.
- **Replay.** `SwapBuffers` hands the frame to a JS replayer (a new `port/web/gfx/webgl2.js`). It issues
  WebGL2 calls with state caching done in JS, where the calls happen anyway.
- **Expected:** fewer total WebGL calls (one upload per frame, cached state), no glue per call, and
  measurable CPU savings. It also creates the seam phases 2 and 3 plug into.
- **Risks:**
  - The GL1 semantics the engine relies on in the middle of a frame. `glGetTexLevelParameteriv` is
    answered from shim-side metadata already. `glReadPixels` needs a flush.
  - Texture uploads during a frame need correct ordering.

### Phase 2: WebGPU replayer (large; keep WebGL2 as fallback)
- Use `navigator.gpu` from JS directly; no Dawn/`webgpu.h` in C, since C only writes records.
- **Pipelines** are keyed by the packed state key. WGSL comes from the same key, ported from gl1shim's GLSL
  generator. Pipeline creation goes through an async warm-up list cached in localStorage
  (nfsu2 `loadWarm`/`warmUp`).
- **Uniforms:** one ring buffer per frame with dynamic offsets. Static world matrices are deduplicated.
- **Bind groups:** one fixed layout (group 0: uniforms; group 1: up to 4 texture+sampler). Bind groups are
  cached per texture set.
- **Textures:** GPUTexture plus `writeTexture` per mip. The engine uploads RGBA8, so there's no format
  zoo.
- **Depth:** depth32float. Future: GPU occlusion queries for flares (replacing the "always visible" stub).
- **Render bundles** for the static parts of the world, once the stream shows which ranges repeat
  frame to frame.
- **Expected:** a much lower per-draw cost than WebGL2, and the biggest win for weak hardware.
- **Risks:**
  - WebGPU availability: Chrome yes, Safari 26, Firefox partial. That's why the WebGL2 replayer stays.
  - Pipeline creation hitches: mitigated by the warm-up list.

### Phase 3: engine in a worker (large; infrastructure)
- **Threads build:** `-pthread`, `-sPROXY_TO_PTHREAD`, shared memory. This needs COOP/COEP headers:
  `tools/devserver.py --isolate` now, the Rust `se1-server` for hosting, and `coi-serviceworker` as a
  static-host fallback.
- **Drop JSPI.** A worker may block (`Atomics.wait`), so the engine's blocking loop runs unchanged and
  the rAF-yield hack goes away. JSPI is Chrome-only, so this also opens the door to Firefox/Safari.
- **Files:** WASMFS instead of the JS MEMFS. JS FS calls from a pthread are proxied to the main thread.
  This is also where the lazy, OPFS-cached data loading from `notes/plan.md` belongs.
- **Input:** replace Emscripten's SDL2 event path with a shared mailbox written by the page (nfsu2
  `input_proto.h`): keys by `KeyboardEvent.code`, pointer-lock deltas, gamepads polled in rAF.
- **Audio:** the mixer writes an SPSC float ring in shared memory and the AudioWorklet reads it directly,
  replacing per-frame `postMessage`.
- **Background tabs:** the worker keeps simulating while the tab is hidden, which multiplayer needs
  (plan.md note). Replay simply skips frames while hidden.
- **Risks:**
  - SDL2 assumptions in the engine: window, events, GL context creation. The engine thread never creates
    a GL context; a stub "context" plus our recorder replaces `SDL_GL_*`.
  - Hosting needs the isolation headers.

## Order and why

1 → 2 → 3, with 0 first.
- Phase 1 is the seam everything else needs and pays for itself on WebGL2.
- Phase 2 attacks per-draw cost directly, which is the measured problem.
- Phase 3 removes the remaining stalls from the game thread and unlocks non-Chrome browsers and
  background simulation for multiplayer. But it is mostly infrastructure, and its perf win depends on
  phase 1 existing.

## Out of scope here
- Texture arrays/atlases to make draws mergeable: invasive for wrap-mode textures; revisit only if
  phase 2 leaves draw count as the bottleneck.
- A Rust renderer: possible later as the replayer (wgpu → WebGPU), but the replayer is JS/TS-sized work.
  Rust wins nothing until the command format is stable.

## Results

### Phase 0 (3bbc5c0)
- `tools/bench.mjs --shots <label>` captures 8 frames (3..17 s of demo time); `tools/shotdiff.py` compares them.
- Capture mode needs `sam_iVideoSetup = 3` and `gfx_iLensFlareQuality = 0` (port/data/SE1Mod/shots.ini):
  - flares fade on wall-clock time, so frames would depend on build speed;
  - the GLSettings presets run after the command-line script and would re-enable them.
- Same-build runs are bit-identical.

### Phase 1 (command stream + JS WebGL2 replayer)
- Visual: vs the old renderer, 8/8 frames pass (7 bit-identical, 1 at 0.002% of pixels).
- GPU, interleaved A/B: ~1790 -> ~2400 fps (+34%); CPU per frame mean 0.55 -> 0.41 ms, p95 1.2 -> 0.7,
  p99 1.9 -> 0.85.
- WebGL calls per frame: 1980 -> 1650; bufferData calls ~390 -> 2.
- Software GL: unchanged (~103 fps, same spikes). As expected, SwiftShader is GPU-side bound: phase 1 removes
  CPU-side glue, not GPU work. Remaining per-draw state calls (vertexAttribPointer 705, bindTexture 210,
  activeTexture 178) are the WebGPU phase's target.

### Phase 2 (WebGPU replayer, opt-in `?gfx=webgpu`)
- Visual: 8/8 frames pass vs the WebGL2 baseline (mean diff <= 0.02, <= 0.035% pixels: rasterization
  differences between backends).
- Headless Chrome, Apple Metal-3 adapter, interleaved A/B vs WebGL2 replay: 550 vs 2450 fps timedemo,
  CPU per frame 0.87 vs 0.40 ms, p99 1.9 vs 0.85 ms.
  - The throughput gap is inflated by the timedemo's per-frame `onSubmittedWorkDone()` round trip
    (WebGL's `finish()` is cheaper); vsync-paced play doesn't wait like that.
  - The CPU gap is real: per-draw JS in the replayer (`replay` 24% + `prep` 5% + `uniforms` 2% of
    busy samples), e.g. a new Float32Array view per uniform slot and string keys for texture bind
    groups.
- No software WebGPU adapter on macOS Chrome (SwiftShader WebGPU unavailable), so no potato proxy here.
- Stays opt-in; WebGL2 remains the default.
- Optimization pass 1:
  - Changes: persistent typed views (no allocation per draw), sampler and single-texture bind group
    cached on the texture, no redundant setBindGroup(0), overlay layout reads every 60 flushes instead
    of every flush, timedemo sync pipelined two frames deep.
  - Result: 550 -> ~1400 fps; CPU per frame 0.87 -> 0.69 ms (p99 1.9 -> 1.6). WebGL2 on the same
    run: ~2490 fps, 0.39 ms.
- Next (structural):
  - render bundles for static world geometry;
  - one writeBuffer of all per-draw uniforms per flush, already the case;
  - packing the per-draw state changes the engine makes;
  - measuring on a real weak GPU, since macOS Chrome has no software WebGPU adapter.

### Render scale / dynamic resolution (`?scale=0.5`, `?scale=auto`)
- The engine keeps its logical size (HUD layout, input: SDL maps mouse by window size / CSS size, so
  the backing store size doesn't matter). Both replayers draw into a smaller backing store with scaled
  viewport and scissor; the canvas keeps its CSS size.
- Visual: scale 1 unchanged (8/8 on both backends); scale 0.5 renders 512x384 correctly on both.
- Potato proxy (software GL, vsync on, ~1050 presented frames, late = interval > 1.5x median):
  - scale 1: 9 and 15 late frames;
  - scale 0.5: 4 and 2 late frames;
  - auto: 5, 10 and 5 late frames, with 4-8 scale changes per run. It follows the demo's heavy/light
    scenes; hysteresis is "step down on 2+ late frames per 30, up after 3 s without any".
  - With vsync the software GPU mostly holds 60 fps (~1% late at full resolution). The uncapped "13%
    over 16.7 ms" figure measured CPU work, not presentation.
- Auto stays experimental (opt-in); next: a GPU timer query (EXT_disjoint_timer_query_webgl2 /
  WebGPU timestamps) instead of frame-interval inference, plus upscaling quality (CSS
  `image-rendering`, or an FSR-style pass).

### Phase 3, milestone 1: engine in a worker (`-DSE1_THREADS=ON`, serve with `devserver.py --isolate`)
- Build: pthreads + PROXY_TO_PTHREAD, no JSPI.
  - The engine's SDL_GL_* calls are renamed to stubs (force-included port/common/sdlgl_threads.h): the
    worker has no GL context.
  - The main-thread replayer creates its own WebGL2 context.
- Every replayer, audio and capture call is proxied synchronously to the main thread (MAIN_THREAD_EM_ASM).
- Frame pacing: a rAF loop on the main thread bumps a shared counter (every 100 ms while hidden), and
  the worker futex-waits on it.
- Fixed on the way, for both builds: texture uploads are now commands in the stream (data arena;
  WebGPU splits the pass around uploads). In the threaded build every flush is its own main-thread task,
  and Chrome presented half-drawn frames between them.
- Visual: threaded vs single-threaded 8/8 (7 bit-identical). Capture mode now also pins console lines,
  the display-mode report and the HUD time; those fade on wall-clock time or depend on the Rust config.
- Perf (timedemo, WebGL2): threaded 1525 fps / 0.66 ms CPU vs single-threaded 2450 fps / 0.40 ms.
  Every replay is a synchronous round trip, so nothing overlaps yet.
- Loading is slow (~20 s for the intro): MEMFS lives on the main thread, so every file read from the
  worker is a synchronous proxy.
- Rust mod layer off in this build (std without atomics; needs nightly build-std). Done in milestone 5.
- Next:
  - asynchronous double-buffered frame hand-off (worker records frame N+1 while main replays N);
  - ~~worker-local file access~~ (done, milestone 2);
  - ~~SAB audio ring~~ (done, milestone 4);
  - ~~Rust with build-std~~ (done, milestone 5).

### Phase 3, milestone 2: WASMFS + frame/capture fixes
- Filesystem: the threaded build uses WASMFS (the filesystem lives in wasm), so the worker reads
  files directly. The intro now loads as fast as single-threaded (~20 s before; a full capture run
  takes 3–5 s).
- Case-insensitive paths (the data and code disagree on letter case, Windows style): MEMFS keeps the
  JS lookup hook; for WASMFS, port/common/CaseFs.c wraps fopen/open/opendir (`-Wl,--wrap`) and
  retries a miss component by component with strcasecmp. The top-level symlink aliases are gone:
  they showed up in directory scans as duplicate folders.
- `CUnixFileSystem::FindFiles` returns entries in case-insensitive name order, as on Windows.
  readdir() order depends on the filesystem. Single-threaded captures are unchanged by this.
- Main-thread `FS` calls abort under WASMFS + PROXY_TO_PTHREAD. So:
  - the benchmark driver follows the exported `SE1_DemoTime()` instead of reading SeriousSam.log;
  - `?res=` is applied in C (`SE1_ApplyWebStartup`, before the command-line script) instead of
    writing PersistentSymbols.ini from preRun.
- Fixed black captured frames in the threaded build. The last replay, the `?shots=` capture and
  `endFrame` were separate main-thread tasks, and Chrome could present (and clear) the canvas
  between them. They are now one task: `SE1_GL1Shim_FlushFrame` → `Module.se1PresentFrame`.
- Visual:
  - threaded vs threaded: 8/8;
  - threaded vs single-threaded *on WASMFS*: 8/8, bit-identical;
  - MEMFS vs WASMFS (any threading): a small deterministic offset in animation phase, a few pixels
    on the palms and the weapon bob.
  - What was ruled out for that offset:
    - every byte the engine reads (3,538 files hashed through fread) is identical;
    - path resolution (ExpandFilePath, 803 lookups) is identical;
    - listing order, and case-insensitive stat, made no difference.
  - Likely cause: an uninitialized read in the engine that depends on heap layout. Not pursued; the
    WASMFS builds have their own baseline.
- Perf (timedemo, WebGL2, median of 3):
  - threaded: 1541 fps, 0.63 ms mean, p99 1.27 ms, max 11 ms (the 767 ms load hitch is gone);
  - single-threaded: 2453 fps, 0.40 ms.
  - Throughput is still bound by the synchronous replay round trip (next: double-buffered hand-off).

### Phase 3, milestone 3: asynchronous, double-buffered frame hand-off
- gl1shim keeps two batches (command buffer + vertex/index/texture arenas). A flush hands the
  current batch to the main thread with MAIN_THREAD_ASYNC_EM_ASM and records into the other one.
  The page (`Module.se1ReplayBatch`) clears the batch's busy flag (Atomics) after replaying it.
  The worker only waits when it laps the replayer, so it records frame N+1 while the page replays N.
- Synchronous proxies (createProgram, readPixels, getParam...) share the FIFO queue, so they still
  run after every batch handed over before them.
- The end-of-frame batch carries its own demo time: `?shots=` captures must label the frame being
  shown, not the one the engine is simulating.
- Timedemo GPU sync moved into the page's end-of-frame task; the worker no longer waits for it.
- Visual: bit-identical to milestone 2 (8/8); WebGPU threaded vs WebGL2 threaded 8/8.
- Perf (timedemo, WebGL2, median of 3): threaded 1856 fps, 0.54 ms mean, p99 1.0 ms, max 2.8 ms
  (was 1541 fps / max 11 ms); single-threaded 2453 fps.
  - Headless vsync runs at 30 fps for both builds (the headless rAF rate), with no late frames.

### Phase 3, milestone 4: shared-memory audio ring (threaded build)
- The engine worker writes interleaved int16 PCM into a ring in shared wasm memory (32768 frames)
  and publishes a write index. The AudioWorklet reads the ring directly and publishes a read index
  (Atomics). This replaces two synchronous main-thread round trips per mix (`wanted` + `push`).
  - The backlog is write − read, exact, instead of being estimated from AudioContext.currentTime.
  - Target backlog: 150 ms.
  - Flushes and format changes bump a generation counter that the worklet watches.
- `?mute=1` and the benchmark play through a zero-gain node, so the worklet keeps consuming.
- Measured: the read index advances at exactly 44.1 kHz (220,672 frames in 5.004 s) and the backlog
  holds at 138 ms.
- Headless timedemo throughput is unchanged (no running AudioContext there). The win is in real
  play: the worker never stalls on the main thread to mix.
- A one-off 11–15 ms frame shows up in most timedemo runs with or without audio (first-use compile
  or GC); not yet investigated.
- The single-threaded build keeps its clock-based worklet path (no SharedArrayBuffer without COOP/COEP).

### Phase 3, milestone 5: Rust mod layer in the threaded build
- Rust's precompiled std for wasm32-unknown-emscripten has no atomics, so the threaded build rebuilds
  it with them:
  `cargo +nightly build -Z build-std=std,panic_abort` with
  `RUSTFLAGS=-C target-feature=+atomics,+bulk-memory,+mutable-globals`, into `rust/target-mt`.
- CMake does this when `SE1_THREADS=ON`. One-time setup:
  `rustup toolchain install nightly --profile minimal --component rust-src --target wasm32-unknown-emscripten`.
  The single-threaded build still uses stable Rust.
- Verified in normal play: config.toml's HUD time and clock show up in the threaded build.
  Captures are unchanged (shots.ini pins those cvars).

### Threaded build is the default
- `SE1_THREADS` defaults to ON. `-DSE1_THREADS=OFF` gives the single-threaded JSPI build, which
  runs on any page.
- `tools/devserver.py` sends COOP/COEP by default; `--no-isolate` turns them off (`--isolate` is
  still accepted).
- Static hosts that can't send headers: `port/web/isolate.js` (first --pre-js, threaded build only)
  registers `coi-sw.js` (copied next to the page by CMake), which adds the headers. The page reloads
  once. It's guarded against reload loops (sessionStorage) and shows a message when isolation is
  impossible (no service workers, not a secure context).
- Verified: a server with no COOP/COEP → one reload → `crossOriginIsolated`, the game runs; with
  headers the script is a no-op (captures 8/8).

### Worker profile: synchronous proxy per quad draw
- New tools:
  - `tools/profile-worker.mjs` profiles the engine worker over DevTools and attributes futex waits
    (synchronous proxies) to their callers;
  - `tools/bench.mjs --cpu-throttle N` adds DevTools CPU throttling;
  - the benchmark now reports main-thread replay time per frame (`replay`).
- Found: `shim_glDrawArrays` called `gfx_quad_capacity` on every quad draw. In the threaded build
  that is a synchronous main-thread round trip: 28% of the worker's busy time.
  - Fix: mirror the replayer's doubling capacity in C, so it's called only when the buffer grows.
  - Timedemo: threaded 1852 → 2619 fps (0.54 → 0.38 ms), now ahead of single-threaded (2421).
- Potato emulation (`--software-gl --vsync --cpu-throttle N`), before this fix:
  - threaded: 58 fps at 4× (2.3 ms CPU per frame) and 57 fps at 12× (6.4 ms);
  - single-threaded at 4×: 55.9 fps, twice the late frames, 44.7 ms max;
  - main-thread replay at 8×: 1.1 ms per frame.
- Next worker hot spots: CRenderer::ScanOneLine / AddActiveSector / MakeSpan (visibility),
  musl qsort (smoothsort: sift/trinkle, ~6%), bind_client_arrays.
