# Roadmap

What's next, in rough priority order. Details and measurements live in notes/render-plan.md
(rendering, threads, phone results) and notes/plan.md (port phases, mods, requirements).

## Where we are (2026-11-19)

- **Default build:** threaded (engine in a worker) with WASMFS, the Rust mod layer, a double-buffered
  frame hand-off and a shared-memory audio ring.
- **Renderer:** WebGL2 by default; WebGPU opt-in with `?gfx=webgpu` (same image, see "Renderer" below).
- **Mac (M-series), timedemo:** ~2900 fps, worker 0.34 ms per frame.
- **Xiaomi Mi 8 SE (Snapdragon 710), paced:** 59.7 fps, worker p50 6 ms, no frames over budget.
  - Capped to 1.2 GHz (budget-phone class): 54–58 fps, p50 ~8 ms, some frames over budget.
- **Regression gates:** 8 reference frames bit-identical (`tools/bench.mjs --shots`), the timedemo
  and paced benchmarks, and phone runs over adb (`--android`, `--android-cap`, `--android-cores`).

## Renderer

- **WebGL2 is the default.** It runs everywhere the threaded build runs, and it's faster here:
  2870–2920 fps vs 2424 for WebGPU in the threaded timedemo on the Mac. Both render the same frames
  (captures match).
- **WebGPU stays as an option** (`?gfx=webgpu`). Revisit when:
  - it's available on the low-end phones we target (Chrome on Android needs Android 12+; the
    Mi 8 SE runs 11);
  - or a feature needs it (compute, many lights).

## Performance (deferred)

1. **CPU-time quality controller for slow devices.** The CPU counterpart of `?scale=auto`: watch the
   worker's time per frame and trim `mdl_fLODMul` / `mdl_fLODAdd`, `wld_iDetailRemovingBias`,
   `gfx_fEnvParticlesDensity` and lens flares when a device falls behind; restore them when it
   catches up.
   - Targets the occasional slow frames on budget phones (1.2 GHz class).
   - It changes how the game looks on slow devices, so it needs a design decision on what may drop.
2. **Engine visibility code** (ASER: ScanOneLine, AddActiveSector, MakeSpan, ClipToOnePlane, about
   25–45% of worker time).
   - Upstream disabled its coherent-scan-line shortcut because of bugs.
   - Gains here mean algorithm work: high risk, and hard to verify on a phone given run-to-run noise.
   - Needs a profiling build linked at -O1 first: Binaryen inlines the helpers, so the profile can't
     split them now.
3. **Model rendering** (RenderModel, UnpackFrame, ~12%). Look at per-frame vertex unpacking and
   lerping; wasm SIMD.
4. **Shim vertex copies** (put_vertices, 4–7%). The per-attribute streams touch more memory than the
   old packed arena; try copying only the vertex range a draw uses.
5. **Remaining synchronous calls** (createProgram, uniformLocation: ~55 ms in total per session on
   the phone). Same approach as texture handles: allocate in the shim, resolve on the main thread.
6. **Weak-driver draw cost:** 208 draws per frame, 4% mergeable. Texture arrays or atlases would
   make more draws mergeable, but that's invasive (wrap modes).
7. **Power:** the adaptive vsync spin keeps a core busy on slow devices. Measure battery and heat on
   the phone; consider spinning only for the last part of the frame.

## Platform

- **Saves and settings in the threaded build:** WASMFS persists through OPFS, which isn't wired up
  yet, so every visit starts fresh (a "first run" each time).
- **Data loading:** lazy fetch plus an OPFS cache instead of preloading 117 MB; compressed textures
  where supported (notes/plan.md, performance item 5).
- **Hosting:** a public deployment. Static hosts work through `coi-sw.js`. The demo data's license
  decides what may be served.
- **Touch controls** for phones: there are none, so on a phone the game can only show the demo.
- **Fallback:** serve the single-threaded build where cross-origin isolation is impossible.

## Mods and gameplay (the original goals)

- Existing community content mods, installable from the browser (notes/plan.md, "existing mods").
- Remixed and bigger maps; level "bridges" instead of loading screens.
- An L4D-style "director".
- **Multiplayer:** 2–4 player co-op works over a virtual LAN (WebSocket switch in rust/se1-server;
  notes/multiplayer.md).
  - Next: a lobby UI, then interest management in the switch and WebRTC peer links for the
    128-player goal.
  - Re-profile then: 128 players will move the hot spots.
- **Serious Survivors** (`?mode=survivors`, notes/survivors.md) is a prototype; it shows what the mod
  host API v2 can drive.

## Testing

- **CI:** `.github/workflows/ci.yml` is ready on branch `ci-workflow`. It runs tools/test.sh on
  GitHub Actions with the demo data. Pushing it needs a GitHub token with the `workflow` scope.
- **Baseline:** the `vanilla` tag is the plain port with the full test suite, before multiplayer
  and mods.
- More real devices: a budget Android phone, an older iPhone, a Chromebook.
- Use several runs per phone result: the scheduler moving the worker between core types makes single
  runs differ by up to 2×.

## Known issues

- MEMFS and WASMFS builds differ by a small deterministic animation-phase offset. Probably an
  uninitialized read in the engine that depends on heap layout; each filesystem has its own
  reference captures.
- A demo started from the command line (`+script`) before the first video mode makes that mode
  reload every texture (1.4 s on the phone). The benchmark avoids it with `sam_iVideoSetup = 3`;
  players starting from the menu don't hit it.
- The benchmark's paced numbers on the Mac depend on the headless display rate.
