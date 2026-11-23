# Playtests

Recorded play sessions, so pacing, fun and problems can be found from data. No video and no
microphone: a timeline of what happened in the game and what the player did, the engine's console,
and a few small screenshots around anything that went wrong.

## Quiet recording (the default)

Every game page served from a dev host (localhost, a private IP, `*.local`) records quietly. Nothing
needs to be pressed and nothing appears except a faint dot at the bottom left (it explains itself
for 6 s at the start). `?rec=0` turns it off. It is skipped on other hosts, in headless Chrome
(unless `?rec=quiet`), and with `shots`, `bench` or `timedemo`. If the server has no upload
endpoint (404/405/501), it stops uploading.

On top of the telemetry below, quiet mode keeps:

- `console.txt`: the page's console, which includes every engine `CPrintF` line
  (`<t>\t<level>\t<text>`, 200 lines a second at most).
- a flight recorder: a 480 px JPEG every 2 s in a ring of 10, plus one kept every 30 s. On a
  trigger (an error, a context loss, an abort in the console, a death, a hitch over 250 ms, a
  marker key) the ring and the next 2 frames are uploaded as `shot-<t*10>.jpg`.
- events: `build` (the wasm's Last-Modified), `death`, `hitch` (a frame over 100 ms), `error`.

### Triage

`python3 tools/playtriage.py --new` reads every session not yet triaged and writes
`triage.md` and `triage.json` next to it. It finds, without being told:

| Finding | Rule |
|---|---|
| error | a page exception, an unhandled rejection, a lost WebGL context (high) |
| console | a problem line (cannot, failed, error, warning…) not seen in an earlier session; at startup it is low |
| hitch | frames over 100 ms, grouped per level |
| slow | the median frame over 20 ms for 5 s or more |
| death | deaths within 15 units of each other; quitting within a minute of dying |
| stuck | 6 s without moving while pressing movement keys |
| pointer | in play for 5 s without the mouse captured |
| mash | 6 presses of one key in a second (not movement) |
| option | a malformed URL option (e.g. a second `?`) |
| idle | a long session with little time in play |
| marker | F7, F8, F10 presses |

Each finding links the nearest screenshots. Console lines seen once are remembered in
`data/playtests/.baseline.json`, so the next session only raises new ones; lines known to be
harmless go in `tools/playtriage-ignore.txt`. `--inbox` lists sessions waiting; `--hook` is the
Claude Code SessionStart hook (`.claude/settings.json`, local), which triages new sessions and puts
the summary into the next coding session, so a played session gets looked at without being
reported.

### Next: an engine demo per session

The telemetry says where a problem happened; it can't replay it. The engine can: `CGame::StartDemoRec`
writes a `.dem` with every player action, and `dem_bPlay` plays it back deterministically. Plan:

1. On the first level start in quiet mode, call `StartDemoRec("Demos/rec-<session>.dem")` from the
   mod (an exported `SE1_StartDemo`), restarting it on each level change.
2. Upload the demo file from WASMFS with the session (a `demo.dem` POST on level end and on
   page hide), size-capped.
3. A `tools/replay.mjs <session> [--at t]` that loads the demo in headless Chrome at the same
   build, seeks to a finding and takes full-size screenshots and engine state, so a finding can
   be reproduced and a fix checked against the same input.

The build must match: the `build` event records the wasm's Last-Modified, and replay refuses a
different one.

## Opt-in playtests

Add `&rec=1` to any game URL served by `tools/devserver.py`, e.g.

- Survivors on the demo maps: `http://127.0.0.1:8094/serioussam.html?mode=survivors&rec=1`
- Survivors on the full game: `http://127.0.0.1:8096/serioussam.html?mode=survivors&level=Levels/01_Hatshepsut.wld&rec=1`
- The campaign: `http://127.0.0.1:8096/serioussam.html?rec=1`

A **REC** badge appears at the top left. While playing:

| Key | Marker |
|---|---|
| F7 | fun moment |
| F8 | boring or frustrating moment |
| F10 | bug |

The game never sees these keys. Press them whenever something stands out; one press is enough.

When a Survivors run ends, a short survey opens (fun 1–5, pacing, difficulty, best and worst
moment). In the campaign, or to stop early, click **Finish** on the badge. Closing the tab also
works: the data is uploaded every 4 s, so nothing is lost except the survey.

## Where it goes

`data/playtests/<session>/` (ignored by git, never committed):

- `meta.json`: start time, URL options, browser, screen.
- `telemetry.jsonl`: one event per line, `t` = seconds since the start:
  - `hud`: Survivors HUD twice a second (run time, level, XP, kills, alive monsters, build).
  - `mod`: every message the game mod sent (card offers, chests, banners, warnings,
    achievements, the run's end with damage by source).
  - `answer`: the player's choices (card index 0–3, 10 reroll, 11 skip, 20 chest, 30 endless).
  - `tel`: once a second in any mode (health, armor, weapon, ammo, position, level).
  - `input`: once a second (keys, mouse movement, clicks, wheel, device).
  - `state`: once a second (in play or in a menu, hidden tab, fps and engine work time).
  - `marker`, `survey`, page visibility.
- `survey.json`: the survey answers.

## Analyse

`python3 tools/playtest-report.py data/playtests/<session> [more sessions...]` writes, into each
session's `report/` folder:

- `report.md`, covering:
  - pacing per minute;
  - level-up rhythm and choices;
  - downtime and danger spikes;
  - player activity;
  - performance;
  - survey answers;
  - notable moments around markers and deaths.
- `summary.json`: the same metrics for comparisons.
- `timeline.png`: one chart of the whole session.

With several sessions it also writes `compare.md`.

## Bot baseline

`node tools/playtest-bot.mjs <url> [--max 600] [--extra "&svgod=1"]` plays a Survivors run with
the recorder on, to have sessions to compare against. Its playing is crude:
- it walks at random;
- it sweeps its view slowly, relying on aim assist on high;
- it picks random cards.

Without god mode it dies within seconds on Normal. Serve with
`--playtests-dir data/playtests-bot` to keep its sessions apart from human ones.

## Code

- `port/web/playtest.js`: the recorder (quiet and opt-in), badge, markers, survey, flight recorder.
- `tools/playtriage.py`: triage; `tools/test_playtriage.py`: its test.
- `rust/se1-mod/src/lib.rs`: `post_telemetry` writes the `tel` samples when the page sets
  `se1PlaytestOn`.
- `tools/devserver.py`: `POST /__playtest/<session>/<file>[?append=1]`.
- `tools/playtesttest.mjs`: the test, part of `tools/test.sh`.
