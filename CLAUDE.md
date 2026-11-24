# Serious Sam web port: notes for Claude

Serious Engine 1 (upstream `src/`, GPL-2.0) built with Emscripten, a Rust game mod, and a browser
page. The user plays the `full` build; the tests use the free demo data. Longer context:
`notes/handoff.md` (state, open items, gotchas), `notes/roadmap.md`, `notes/features.md`.

## Start of a session

1. `node tools/dev.mjs status`: what is running, which builds are stale, whether a headless Chrome
   or the Chrome lock is held, git state, and play sessions waiting for triage.
2. **Play sessions.** The user plays without reporting problems; every play on a dev host is
   recorded quietly (`notes/playtests.md`). If the SessionStart context or `status` lists sessions
   waiting, run `python3 tools/playtriage.py --new`, read each `data/playtests/<session>/triage.md`
   and the screenshots it links, and raise or fix what it shows. Triage is a lead, not a verdict:
   confirm in the code or with `se1d` before calling something a bug. Harmless console lines go
   in `tools/playtriage-ignore.txt`.

## The dev loop

| Do | Command |
|---|---|
| start servers in the background | `node tools/dev.mjs serve full` (also `mt`, `rel`, `web`, `switch`) |
| stop, logs | `node tools/dev.mjs stop all`, `node tools/dev.mjs logs full -n 50` |
| rebuild | `node tools/dev.mjs build full` (ninja; rebuilds the Rust mod and links) |
| game URLs | `node tools/dev.mjs urls` |
| poke the running game | `node tools/se1d.mjs open ?mode=survivors`, then `cmd 'cht_bGod=1'`, `log --grep RE`, `wait RE`, `eval 'js'`, `shot`, `quit` |
| whole test suite | `tools/test.sh` (builds `build-test-mt`/`-st` with demo data) |
| one test | `node tools/<name>test.mjs <url>` against a running server, e.g. port 8094 |

- `se1d` keeps one headless game open between commands (it quits after 20 idle minutes). Its
  `cmd` runs an engine console line (statements end with `;`, added if missing) and prints the
  console lines it caused. Prefer it to writing a one-off CDP script.
- The page console carries the engine console: `CPrintF` lines reach it through a ring buffer
  (`port/common/WebFrame.cpp`), mod lines through `host_log`. In the page, `Module.se1Cmd(line)`
  runs a console line.
- The browser pane in the desktop app keeps the game paused ("Click to play"); use the headless
  tools for checks.

| Build dir | Data | Port | Use |
|---|---|---|---|
| build-web-tfe-full | data/tfe-full-web (retail) | 8096 | the user plays here |
| build-web-tfe-mt | demo | 8094 | most tests |
| build-web-tfe-rel | demo, single-threaded | 8092 | |
| build-test-mt / -st | demo | own | `tools/test.sh` |
| build-pub-mt/byod, build-pub-st/byod | none: the player imports their folder (`notes/user-data.md`) | 8088 (`serve pub`) | the public bundle (`tools/package.sh`) |

Data is packed into the build: after changing files under a build's data dir, relink
(`touch port/common/Se1ModBots.cpp && node tools/dev.mjs build full`).

## Rules

- **One headless Chrome at a time.** The 36 GB Mac died of memory once. The tools take a lock in
  `tools/chrome.mjs` and wait for each other; don't run tests in parallel or bypass it
  (`SE1_CHROME_LOCK=0`). After a run, `dev.mjs status` should show 0 headless Chromes.
- **Shell:** prefix commands with `rtk`. The `rm` guard hook blocks `rm` with computed paths: use
  literal paths or Python.
- **Commits:** Conventional Commits (`CONTRIBUTING.md`), ending with the `Co-Authored-By: Claude …`
  line. Push every step to `main`. Never rewrite pushed history.
- **`data/` is never committed** (retail game data, recordings, logs, screenshots).
- **`src/` is upstream** (`UPSTREAM.md`): keep engine changes small, guarded by `__EMSCRIPTEN__`,
  `STATICALLY_LINKED` or `SE1_WITH_RUSTMOD`, and list them in `notes/features.md`.
- Keep the nfsu2-web MIT credit (README).
- Leave the `ci-workflow` branch unpushed.
- Routine, well-specified work goes to the local model (the `omp-delegate` skill, `~/CLAUDE.md`).

## Where things are

| Path | What |
|---|---|
| `port/web/` | the page: `pre.js` (Module setup, console bridge), `gfx.js` / `gfx-webgpu.js`, `input.js`, `audio.js`, `net.js`, `survivors.js`, `playtest.js` (recorder) |
| `port/common/` | C++ glue: `WebFrame.cpp` (frame loop, exports the page calls), bots, mod host |
| `rust/se1-mod/` | the game mod (Survivors mode, telemetry), wasm; `rust/se1-server/` the multiplayer switch |
| `src/SamTFE`, `src/SamTSE` | upstream engine and game code |
| `tools/` | dev CLI, daemon, servers, tests, triage, bench |
| `notes/` | design notes and research |
