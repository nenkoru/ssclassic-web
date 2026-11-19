# Playtests

Recorded play sessions, so pacing and fun can be analysed from data. No video and no
microphone: only a timeline of what happened in the game and what the player did.

## Record

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

- `port/web/playtest.js`: the recorder, badge, markers and survey.
- `rust/se1-mod/src/lib.rs`: `post_telemetry` writes the `tel` samples when the page sets
  `se1PlaytestOn`.
- `tools/devserver.py`: `POST /__playtest/<session>/<file>[?append=1]`.
- `tools/playtesttest.mjs`: the test, part of `tools/test.sh`.
