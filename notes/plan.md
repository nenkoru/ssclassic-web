# Port plan

## Phase 1: boot to the menu in Chrome (TFE, demo data)
- **Toolchain: Emscripten**, not wasi-sdk like nfsu2. We have the real source, so we get its SDL2 port, a virtual FS and GL bindings for free. nfsu2 needed its own host because it runs recompiled x86 code.
- **Build:**
  - Native `tools/bin/ecc-<game>` generates the entity code. Pass `-DECC=...`.
  - Add an EMSCRIPTEN branch to CMake.
  - Build everything as static libraries, link with whole-archive, and add a symbol registry for the dlopen sites (`STATICALLY_LINKED` hooks).
  - `USE_ASM=OFF`, `USE_SYSTEM_VULKAN=OFF`, `USE_SINGLE_THREAD=ON`.
  - Add `__EMSCRIPTEN__` to the Types.h arch checks.
- **Main loop: JSPI.** Chrome ships it.
  - `SDL_Delay`/`Sleep`/`LimitFrameRate` become `emscripten_sleep`, which yields to the browser, so the blocking `while` loops survive unchanged.
  - Asyncify is the fallback for Firefox.
  - Later, possibly: a PROXY_TO_PTHREAD worker model like nfsu2.
- **Graphics: our own GL 1.x → WebGL2 shim**, behind the engine's `pgl*` function-pointer table (454 entries in `gl_functions.h`; only a fraction are actually used).
  - Matrix stacks, immediate-mode batching, client arrays and texenv/combine go into a small generated GLSL shader keyed by state, plus alpha test, clip plane and texture-based fog.
  - It's more predictable than `-sLEGACY_GL_EMULATION`, which lacks combine/clip planes. It's also the same idea as nfsu2's FF_FS + pipeline-key cache, so a WebGPU backend later is a drop-in.
- **Sound:**
  - Emscripten's SDL2 audio callback, called from the main loop (single-threaded).
  - Vorbis linked directly (`-sUSE_VORBIS`) instead of dlopen.
  - Later: an AudioWorklet + SAB ring.
- **Data:** the demo `.gro` files are served by a local dev server and fetched into MEMFS at start (later: lazy, cached in OPFS). The user dir goes to IDBFS.
- **Input:** SDL2 port plus pointer lock on click.

## Phase 2: hardening
- Playwright headless test, screenshot dumps, timed input scripts (nfsu2 pattern).

## Phase 3: mods
- Remixed or bigger maps.
- Seamless level "bridges" with no loading screens.
- An L4D-style director.
- 128-player MP: a WebSocket virtual-LAN relay (nfsu2 `crates/lan` pattern) emulating the UDP socket layer in CommunicationInterface.cpp, then an authoritative server with interest management (`crates/roam` pattern).

## Requirement: existing mods (2026-11-18)
- Content mods (.gro / Mods/<name>/ with maps, textures, sounds) must just work: install via drag-drop or URL
  into OPFS, list in the Mods menu, switch by reloading the page into the mod (upstream uses execl).
- Code mods (Windows .dll entities/game) can't run; ones with source (e.g. XPLUS in this repo) get rebuilt for wasm.
- Steam Workshop is a Revolution-engine thing and needs Steam auth: only via the Rust server as a proxy, later.
  ModDB-style direct downloads first. Respect each mod's license when hosting a catalog.

## Requirement: performance (2026-11-18) — 60 fps on low-end hardware
Measure first (tools/devserver.py + JS Self-Profiling API), then:
1. Release build: no -sASSERTIONS/--profiling-funcs, -O3 + LTO, -msimd128, wasm-opt.
2. gl1shim: stream arrays into one ring VBO (bufferSubData, no per-draw bufferData), cache uniforms/
   attrib state per program, skip redundant state changes, merge consecutive draws with equal state.
3. Engine hot spots from profiles (portable C paths replaced x86 asm: SIMD rewrites where it matters).
4. Threads (PROXY_TO_PTHREAD + OffscreenCanvas, COOP/COEP) and/or a WebGPU backend for the renderer.
5. Data: lazy fetch + OPFS cache instead of a 117 MB preload; compressed textures where supported.
- Background tabs: today the game pauses when hidden (no rAF, 1 s timer throttling). For MP keep the
  loop alive while hidden (MessageChannel yield, skip rendering), honouring sam_bPauseOnMinimize.

### Perf log (2026-11-18)
Benchmark: `node tools/bench.mjs <url> 3` (headless Chrome, GPU, muted, Auto-Demo0001 timedemo, uncapped:
fps = frames rendered while the demo plays in real time; CPU ms/frame from port/common/WebFrame.cpp).
Measure only headless: the shared pane gets hidden/throttled, and headless follows the display refresh
(30 Hz when the Mac display is on another desktop) -> always use uncapped mode for comparisons.
- -O3/LTO vs dev build: no difference -> cost is not in engine C++ but in wasm<->JS WebGL call overhead.
- Profile (release, vsync): bufferData per array per draw, redundant uniform/attrib/bind calls, glFinish
  every frame, failing depth readPixels, per-sample audio conversion.
- Lesson: a bufferSubData ring is a trap on ANGLE/Metal (whole-buffer hazard tracking -> stall or full
  buffer copy): 9 fps, 500 ms frames. Use one bufferData per draw with all arrays packed instead.
- Lesson: without vsync backpressure, dropping glFinish lets the GPU queue grow unbounded (hangs);
  the timedemo does one GPU sync per frame for both builds to stay comparable.
- Tried and reverted (measured in same-session interleaved A/B):
  - caching locked (CVA) arrays per lock: -15% GPU fps. The engine swaps pointers within a lock, so it
    re-uploaded anyway, one bufferData per array.
  - skipping unchanged glVertexAttribPointer calls: -8% GPU fps. Re-specifying right after bufferData
    seems to be ANGLE's cheap path.
- Software GL (SwiftShader, "potato GPU" proxy, `--software-gl`):
  - 1024x768: 104 fps avg, p95 62 / p99 142 ms.
  - 640x480 (`?res=640x480`): 170 fps, p95 36 / p99 73 ms.
  - At both resolutions ~13% of frames exceed 16.7 ms, so the hitches are per-draw overhead, not fill
    rate.
  - Next levers: fewer draw calls (merge consecutive draws with identical state in gl1shim), a render
    scale option, WebGPU.
  - Caveat: SwiftShader on a fast CPU overstates per-draw cost vs a real weak iGPU, so treat it as a
    pessimistic bound.
