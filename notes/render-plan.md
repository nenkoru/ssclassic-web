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
