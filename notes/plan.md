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
