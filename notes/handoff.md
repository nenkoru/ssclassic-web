# Handoff (2026-11-24)

Where the work stands, so a new session can pick it up. The other notes have the details:
- notes/features.md: every feature, its switch and its test;
- notes/roadmap.md: priorities;
- notes/bots.md: bots;
- notes/multiplayer.md, notes/survivors.md, notes/controls.md.

## Standing rules

- **Repo:**
  - `~/code/repos/serioussam-web`, GitHub `nenkoru/ssclassic-web`, branch `main`.
  - Push every step. Conventional Commits, ending with the `Co-Authored-By: Claude …` line.
  - Never rewrite pushed history.
- **Game data** under `data/` is never committed. Keep the nfsu2-web MIT credit.
- **Shell:** prefix commands with `rtk` (see ~/CLAUDE.md).
  - The `rm` guard hook blocks `rm` with computed paths: use literal paths or Python.
- **Delegation:** routine, well-specified work goes to the local model via the `omp-delegate`
  skill (~/CLAUDE.md). Design and debugging stay with Claude.
- **`src/`** is upstream SE1 (UPSTREAM.md). Keep engine changes small and guarded, and list them in
  notes/features.md, "Engine changes since `vanilla`".
- **Branches:**
  - `ci-workflow` holds `.github/workflows/ci.yml`. Leave it unpushed: the user said "not now".
    Pushing it needs a token with the `workflow` scope.
  - `ci-test-suite` exists only on the remote.
- **Memory:** run **one headless Chrome at a time**.
  - The Mac (36 GB) died of memory once, with several game tabs and test runs going in parallel.
  - Bake levels with `--jobs 1`.
  - Check `pgrep -f "Chrome.*headless" | wc -l` is 0 after test runs.
  - The test scripts close their Chrome (tools/chrome.mjs `closeChrome` also reaps orphaned ones).
  - `tools/cleantmp.py` deletes leftover temp profiles (about 350 MB each).

## Builds and servers

Emscripten builds (CMake + ninja, Release, `SE1_THREADS`, `SE1_RUSTMOD`). Rebuild with
`ninja -C <dir>`: it rebuilds the Rust mod (`cargo +nightly`, wasm32-unknown-emscripten) and links.

| Dir | Data | Served on | Use |
|---|---|---|---|
| build-web-tfe-full | data/tfe-full-web (retail TFE, 386 MB packed) | 8096 | playing, nav baking, `navroamtest` |
| build-web-tfe-mt | demo | 8094 | most tests (`bottest`, `svtest`, …) |
| build-web-tfe-rel | demo, single-threaded (slow) | 8092 | |
| build-web-tfe | | 8090 | |
| build-test-mt / -st | demo | own servers | `tools/test.sh` |

- **Serve a build:** `python3 tools/devserver.py --port 8096 build-web-tfe-full`.
  - It binds 127.0.0.1 and sends COOP/COEP.
  - Gyro (WebHID) and the threaded build only work on localhost or HTTPS.
- **Multiplayer switch:** `cd rust && cargo run -p se1-server --release` (ws://0.0.0.0:9002).
- **Data is packed into the build** (`--preload-file`). After adding or changing files under
  `data/tfe-full-web` (e.g. a baked `.nav`), relink: `touch port/common/Se1ModBots.cpp && ninja -C build-web-tfe-full`.
- **Full data** comes from a retail install: `tools/make_full_data.sh SamTFE <retail dir>`.
  `data/tse-full` exists too.

## Links (full build on 8096)

| What | URL |
|---|---|
| Menu | http://127.0.0.1:8096/serioussam.html |
| Campaign + 3 bots | http://127.0.0.1:8096/serioussam.html?bots=3&args=%2Blevel%20Levels%2F01_Hatshepsut.wld |
| Survivors (+ bots) | http://127.0.0.1:8096/serioussam.html?mode=survivors&bots=3 |
| Strong aim assist | http://127.0.0.1:8096/serioussam.html?aimassist=3 |
| DualSense gyro | http://127.0.0.1:8096/serioussam.html?gyrosens=2 (click "Enable gyro" once; touchpad click toggles) |
| Host co-op | http://127.0.0.1:8096/serioussam.html?room=test&host=1 (others: `?room=test`) |
| WebGPU, post pass, auto quality | `?gfx=webgpu`, `?post=fxaa,sharpen`, `?quality=auto` |

## What was done last (2026-11-18 … 11-21)

- **Survivors auto guns:** every owned gun fires on its own (`f8eb82a`, `?svautofire=0` turns it
  off).
- **Bots: baked nav graphs** (`00657c8`, `2712da6`).
  - `tools/navbake.mjs` maps a level offline. Bots load `Nav/Levels/<level>.nav` at level start;
    otherwise they build a graph live (about 95 s on the demo level).
  - The baked graph passes through doors (host API v10 `ray_door`). The runtime probes doors and
    plans around the closed ones.
  - Fixes from the roam test:
    - no floors inside solids;
    - a tall step isn't a slope;
    - roam goals stay in the bot's strongly connected part of the graph;
    - paths start from the feet.
  - `tools/navroamtest.mjs` (`?botroam=N`): on Hatshepsut, 93–95% of goals reached.
  - `tools/bottest.mjs` now measures movement from where the bots joined. Its "bots move" check
    was flaky.
- **State:** all pushed (`main` = `2712da6`). 116 Rust tests pass; the demo `bottest` passes.

## Open, in rough order

1. **Bake the other 14 TFE levels.**
   - Command: `node tools/navbake.mjs http://127.0.0.1:8096/serioussam.html data/tfe-full-web --jobs 1`, then relink the full build.
   - Then run `navroamtest` on a few of them (e.g. `Levels/02_SandCanyon.wld`).
   - Expect new leaks: deserts, water, ice.
   - Also bake the demo data's level, so `bottest` doesn't wait 95 s for a live build.
2. **Bot nav limits** (notes/bots.md, "Limits"):
   - doors that open on approach look closed until a human opens them;
   - lifts count as doors;
   - teleporters aren't followed;
   - Hatshepsut has a few small islands: the intro box and two closed rooms.
3. **Add `navroamtest` to `tools/test.sh`.** It needs full data, so make it a skip-if-missing step.
4. **Roadmap items** (notes/roadmap.md):
   - lazy data loading with an OPFS cache;
   - public hosting (what the demo data's license allows);
   - real-device checks for touch and pads;
   - interest management and STUN/TURN for the 128-player goal;
   - engine visibility code performance.
5. **Bevy rewrite question:** see notes/bevy-rewrite.md. It's a research report, not a decision.
6. **Multiverse idea:** see notes/multiverse-games.md (war server, rescue portals, Doom/Odamex front). Research only, nothing built.

## Gotchas

- The browser pane in the desktop app keeps the game paused ("Click to play"). Use the headless test
  scripts (tools/*.mjs) for checks; they emulate focus and pointer lock.
- **Bot status line format** (the tests parse it):

  ```
  se1mod: bots: N [<id> <state> hp <hp> at <x> <z> heading … pitch … weapon … blocked … goals <r>/<m> wp … to … eye …] … | nav …
  ```

  Change the regexes in bottest.mjs and navroamtest.mjs with it.
- Static obstacles (statues) block walk rays only in a bake; a live build skips them for speed.
- **Rays started inside a solid see none of its faces** (`CCastRay`). The nav builder guards
  against it (no floor inside a solid).
- **Survivors mode with `svcap=1`** keeps monsters off. Without it, bots in the roam test fight
  instead of roaming.
