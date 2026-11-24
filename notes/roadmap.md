# Roadmap

What's next, in rough priority order. Details and measurements live in notes/render-plan.md
(rendering, threads, phone results) and notes/plan.md (port phases, mods, requirements).

## Plan (2026-11-24)

### Now: finish what's open
1. ~~**`navroamtest` in `tools/test.sh`**, skipped when the full data is missing.~~ Done (2026-11-24):
   the "nav roam (full data)" step serves build-web-tfe-full on port +2; SKIP without data/tfe-full-web.
2. ~~**Lazy data loading with an OPFS cache.**~~ Done (2026-11-24): the big files come on demand in
   256 KiB chunks and stay in OPFS. Full data, 100 Mbit / 40 ms: menu in 14.3 s instead of 33.9 s,
   73 MB instead of 393 MB; a reload reads no game data from the network (notes/lazy-data.md).
   Next there: a boot prefetch list for high-latency links.
3. **Platform items below:** public hosting of what the demo data's license allows, checks on real
   phones and pads.
4. **CI** (branch `ci-workflow`): when the user says so; it needs a token with the `workflow` scope.

### Later: bot nav maps
- **Bot nav for every level** (on hold, the user said not yet).
   - Bake the 14 other TFE levels and the demo's KarnakDemo, one Chrome at a time (`navbake.mjs --jobs 1`).
   - Relink the builds, then run `navroamtest` on a few levels.
   - A baked demo level also cuts `bottest`'s 95 s wait for a live nav build.
- **Fix what the bakes and roam tests show** (leaks in deserts, water, ice), then the known limits in
   notes/bots.md: doors that open on approach, lifts, teleporters, small islands.

### Next: the multiverse (notes/multiverse-games.md)
1. **SS1 as an Archipelago game.** A client in the Rust mod; level secrets, kills and pickups as
   "locations", weapons, keys and level unlocks as "items". It joins the existing multiworld
   (about 80 games, including Doom via APDOOM and an existing Fusion integration) before we build
   anything of our own.
   Prototype done (notes/archipelago.md, `tools/aptest.mjs`): Hatshepsut's weapon pickups are
   checks, weapons are items. Next: the other pickups, secrets, level exits and unlocks, keys.
2. **TFE↔TSE live portal:** two same-origin iframes on one hub page. It answers the open questions:
   the per-frame canvas copy, memory with two heaps, joining mid-game.
3. **War server** in `rust/se1-server`: fronts, heartbeats, distress calls, portal tickets; protocol
   modelled on Archipelago's.
4. **Rescue portal SS1→SS1**, then a **Doom front** (Odamex client ported to the browser, Freedoom data).
5. **Handoff fronts** for third-party ports (nfsu2-web, iw4L, Halo) and the official games (Fusion
   via Lua, SS4 via files), through a published adapter spec.

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

1. **CPU-time quality controller: done (opt-in).** `?quality=auto` (`rust/se1-mod/src/quality.rs`)
   lowers particles, model LOD, lens flares, shadows and model detail in steps while frames keep
   missing the refresh budget, and restores them after a run of good windows.
   - Still open: whether it should be on by default on phones, and a CPU-time signal (worker work
     per frame) instead of frame intervals.
2. **Engine visibility code** (ASER: ScanOneLine, AddActiveSector, MakeSpan, ClipToOnePlane, about
   25–45% of worker time).
   - Upstream disabled its coherent-scan-line shortcut because of bugs.
   - Gains here mean algorithm work: high risk, and hard to verify on a phone given run-to-run noise.
   - Needs a profiling build linked at -O1 first: Binaryen inlines the helpers, so the profile can't
     split them now.
3. **Model rendering** (RenderModel, UnpackFrame, ~12%). Look at per-frame vertex unpacking and
   lerping; wasm SIMD.
4. **Shim vertex copies: done.** Indexed draws copy only the vertex range their indices use (min to
   max, found in the loop that copies the indices) instead of everything up to the highest index
   (`port/common/gl1shim.c`; `?vrange=0` restores the full copy for comparisons). Over a timedemo
   that is 58% fewer vertex bytes (18.9 GB to 7.9 GB, `tools/vrangetest.mjs`); captures are
   unchanged on WebGL2 and WebGPU (8/8).
5. **Synchronous shader calls: done.** createProgram and uniformLocation are recorded in the frame
   stream with worker-allocated handles (`port/common/gl1shim.c`); a threaded session now has 6
   synchronous calls in all (start-up queries), counted in `Module.se1GfxSync`.
6. **Weak-driver draw cost:** 208 draws per frame, 4% mergeable. Texture arrays or atlases would
   make more draws mergeable, but that's invasive (wrap modes).
7. **Power:** the adaptive vsync spin keeps a core busy on slow devices. Measure battery and heat on
   the phone; consider spinning only for the last part of the frame.

## Platform

- **Saves and settings: done.** The user dir is stored in OPFS (threaded) or IndexedDB
  (single-threaded) and the page asks the engine to store its settings when the tab is hidden or
  closed (`port/common/Persist.cpp`, `port/web/persist.js`).
- **Data loading:** lazy fetch plus an OPFS cache: done (notes/lazy-data.md). Still open: a boot
  prefetch list, compressed textures where supported (notes/plan.md, performance item 5).
- **Hosting:** `tools/package.sh` builds a folder any static host can serve (threaded build via
  `coi-sw.js` or `_headers`, single-threaded fallback, landing page). Still open: the actual public
  deployment; the demo data's license decides what may be served.
- **Input:** touch controls (`port/web/touch.js`), game controllers with aim assist
  (`port/web/gamepad.js`, `port/common/AimAssist.cpp`); all in `notes/controls.md`. Still open: a
  check on real phones and real pads.

## Mods and gameplay (the original goals)

- Existing community content mods, installable from the browser (notes/plan.md, "existing mods").
- Remixed and bigger maps; level "bridges" instead of loading screens.
- An L4D-style "director".
- **Multiplayer:** 2–4 player co-op works over a virtual LAN (WebSocket switch in rust/se1-server;
  notes/multiplayer.md).
  - Done: a lobby on the page (`port/web/lobby.js`) and WebRTC peer links (`?rtc=1`: direct data
    channels, the switch as signalling and fallback).
  - Next for the 128-player goal: interest management in the engine's own netcode (the switch only
    forwards packets), STUN/TURN for players behind NATs, and a test over the internet.
  - Re-profile then: 128 players will move the hot spots.
- **Serious Survivors** (`?mode=survivors`, notes/survivors.md): a full 20-minute run on host API v5,
  whose engine damage hook gives the guns exact rank bonuses and crits.

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
