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
   Next there: a boot prefetch list for high-latency links (only for builds that serve data).
3. **Ship it: put the game where people can play.**
   - ~~Bring your own data.~~ Done (2026-11-24): neither the retail data nor the demo may be served,
     so the public page carries the engine and the repo's GPL files only (a 34 MB bundle). The
     player picks their game folder once; it's copied into OPFS and the big files are read from
     there on demand (notes/user-data.md, `tools/userdatatest.mjs`, the "user data" steps in
     `tools/test.sh`). It passes with retail data on a plain static server, threaded through
     `coi-sw.js` and single-threaded.
   - The boot prefetch list is dropped for the public site: with the player's own files there is
     nothing slow to fetch.
   - **Deploy** (`tools/package.sh <out> build-pub-mt/byod build-pub-st/byod`): the host, the
     domain and a neutral page title ("Serious Sam" is a trademark) are the user's call.
   - **Real devices:** phones, pads, Safari (`createWritable`), folder picking on mobile (a zip
     import?).
4. **CI** (branch `ci-workflow`): when the user says so; it needs a token with the `workflow` scope.

### Engine speed push (2026-11-23 to 2026-11-25): where it stopped
Goal: 10x faster than the original engine for big crowds (thousands of monsters, hundreds of
players), with the simulation unchanged bit for bit. Not reached yet.

**The bench.**
- `tools/perfbench.mjs --check` replays the demo. "SAME simulation, 384 ticks" is the behaviour
  oracle, and every perf change must pass it.
- `tools/optbuild.sh` builds the perf build in any worktree, and `tools/perfsnap.py` serves copies
  of builds side by side.
- `--profile` gives self-time profiles. To keep inlined functions apart in a profile, add a dummy
  second call site guarded by `extern volatile int _se1never`.
- Each nontrivial change was proven with a temporary verify build that runs the old code next to
  the new one and counts mismatches. The counts are in the notes.

**Results.** Mean engine ms per frame against the reference engine (main at 02a890b):

| Scenario | Reference | Now | Speedup |
|---|---|---|---|
| demo | 0.32 | 0.33 | 1.0x |
| stress300 | 4.22 | 2.67 | 1.6x |
| stress500 | 5.95 | 3.13 | 1.9x |
| stress1000 | 37.3 | 4.09 | 9.1x |
| stress2000 | 45.2 | 10.1 | 4.5x |
| stress4000 | can't run (2047 entity handles) | ~37–40 | |

- The details are in `notes/perf/` (collision, collision2, collision3, rays2, rays3, models,
  models2, render3, gpuanim, visibility, ai, players) and the list is in `notes/features.md`.
- The changes merged after 02a890b (model lights per polygon, the sphere gather) add a few percent
  on top. They have not been benched against the reference engine yet.

**Next, in order:**
1. **Collision grid scan from dense arrays** (`WorldCollisionGrid.cpp`).
   - At stress4000, the scan that rebuilds the candidate list takes 16.3% of the frame, and the
     box tests 10.3%.
   - A dense copy of each cell's entry list (record indices oldest first; read backwards it is the
     list order) and a packed array of each record's first cell measured 1.11x at stress4000,
     1.15x at stress2000 and 1.13x at stress1000, with "SAME" on the demo.
   - It is on the local branch `perf/grid-dense-scan` (ac241f2), not on main: the verify build
     (`#define SE1_VERIFYDENSE`, which compares each cell scan with the linked-list walk) printed no
     counts before the session ended. Take the counts, then merge.
2. **The r5c regression.** Two changes on top of the dense scan made stress2000 4x slower
   (37 ms against 8 ms), though the demo stayed SAME:
   - a dense array of record boxes for the grid's box test;
   - B's sphere box edges hoisted out of the A loop in `ClipModelMoveToModel()`.
   Find which one does it before trying either again. The patch (both changes on top of the dense
   scan) is `notes/perf/grid-r5c-regression.diff`.
3. **Per-pair collision cost**, about 33% at stress4000: `ClipModelMoveToModel()` 22% and
   `PrepareProjectionsAndSpheres()` 10%. Only ~11% of the pairs could be rejected early (pair
   counters in collision3.md), so what's left is the arithmetic.
4. **Small crowds** (stress300 and stress500, only 1.6–1.9x). Track O (branch
   `t3/optimize-crowd-frame-time`) profiled the whole frame there. It was stopped at the end of the
   session, unreviewed and unbenched. It left:
   - 4 commits: FilterBitmap in SIMD, mod page options cached, freed event copies on a free list,
     and perfbench saving the raw `.cpuprofile`;
   - uncommitted BSP.cpp/.h work;
   - a draft `notes/perf/frame4.md` in its worktree.
   Review and bench it before merging.
5. **Leads not taken:**
   - `FilterBitmap` takes 0.8% of the frame, which suggests a texture is uploaded again every frame
     (render3.md). Track O made it faster, but didn't find why it runs every frame.
   - `PrepareRayModelHits` takes 6% at stress4000.
   - `ClipMoveToBrushes` takes 2–6%.
6. **Rejected, with numbers in the notes:**
   - threaded collision prefetch (track L);
   - the grid box test on copied box arrays (collision3.md);
   - caching `GetLightStrength`, and a radix sort for delayed models (render3.md).

**Tooling gotchas.**
- `se1d` runs one daemon on port 9230 for all worktrees: give each track its own `SE1D_PORT`.
- `se1d open` fails with "fetch failed" when it waits on the Chrome lock longer than its fetch
  timeout.
- `tools/bottest.mjs` is timing-flaky: it passes and fails on the same build.

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
  `coi-sw.js` or `_headers`, single-threaded fallback, landing page). No game data may be served, so
  the public bundle is made of the user-data pages (`<build>/byod/`, notes/user-data.md). Still
  open: the actual deployment (host, domain, name).
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
