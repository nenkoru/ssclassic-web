#!/usr/bin/env python3
"""Turn a recorded playtest session into a pacing report.

Usage:
    python3 tools/playtest-report.py <session-dir> [<session-dir> ...] [--out <dir>]

For each session writes into <session-dir>/report/ (or <out>/<session>/):
    summary.json, report.md, timeline.png
With two or more sessions also writes compare.md next to the output dirs.

Only Python 3 stdlib + Pillow.
"""

import json
import math
import os
import sys

# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load(session_dir):
    """Load a session folder. Returns (events, meta, survey).

    events: list of dicts from telemetry.jsonl (unknown types kept, bad lines
    skipped). meta: dict from meta.json ({} if absent). survey: dict from
    survey.json (None if absent).
    """
    events = []
    tel_path = os.path.join(session_dir, "telemetry.jsonl")
    if os.path.isfile(tel_path):
        with open(tel_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev, dict) and "t" in ev:
                    events.append(ev)
    events.sort(key=lambda e: e.get("t", 0.0))

    meta = {}
    meta_path = os.path.join(session_dir, "meta.json")
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                m = json.load(f)
            if isinstance(m, dict):
                meta = m
        except (ValueError, OSError):
            pass

    survey = None
    survey_path = os.path.join(session_dir, "survey.json")
    if os.path.isfile(survey_path):
        try:
            with open(survey_path, "r", encoding="utf-8") as f:
                s = json.load(f)
            if isinstance(s, dict):
                survey = s
        except (ValueError, OSError):
            pass

    return events, meta, survey


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _num(v):
    """Return v as float, or None."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None


def _mean(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _clamp(v, lo, hi):
    if v is None:
        return None
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def analyse(events, meta, survey):
    """Pure analysis. Returns the summary dict (all numbers in seconds)."""
    if not events:
        return None
    t0 = events[0].get("t", 0.0) or 0.0
    t1 = events[-1].get("t", 0.0) or 0.0
    duration = max(0.0, t1 - t0)

    def rt(t):
        """Run-time seconds: recording time minus start time, clamped."""
        return _clamp(t - t0, 0.0, duration)

    mode = "survivors" if any(e.get("type") == "hud" for e in events) else "campaign"

    # --- tel series (once a second, all modes) ----------------------------
    tels = [e for e in events if e.get("type") == "tel"]
    tel_offset = None
    if tels:
        gt0 = _num(tels[0].get("gt"))
        if gt0 is not None:
            tel_offset = rt(tels[0].get("t", t0)) - gt0

    # hp series in run-time coordinates
    hp_series = []  # (run_t, hp)
    for e in tels:
        hp = _num(e.get("hp"))
        if hp is None:
            continue
        t = rt(e.get("t", t0))
        if tel_offset is not None:
            gt = _num(e.get("gt"))
            if gt is not None:
                t = _clamp(t + (gt - gt0), 0.0, duration)
        hp_series.append((t, hp))

    # --- state / input / perf (once a second) ------------------------------
    states = [e for e in events if e.get("type") == "state"]
    inputs = [e for e in events if e.get("type") == "input"]
    perf_samples = [e.get("perf") for e in states if e.get("perf")]

    menu_time = 0.0
    hidden_time = 0.0
    play_windows = []  # (from, to) run-time windows with play == 1
    device_share = {}
    for i, e in enumerate(states):
        t = rt(e.get("t", t0))
        dt = None
        if i + 1 < len(states):
            dt = (rt(states[i + 1].get("t", t0)) - t)
        if dt is None:
            dt = 1.0
        play = e.get("play")
        if play == 0:
            menu_time += dt
        elif play == 1:
            play_windows.append((t, t + dt))
        if e.get("hidden"):
            hidden_time += dt
        dev = e.get("device")
        if dev and play == 1:
            device_share[dev] = device_share.get(dev, 0.0) + dt

    def in_play(t):
        return any(a <= t <= b for a, b in play_windows)

    # --- hud series (survivors) --------------------------------------------
    huds = [e for e in events if e.get("type") == "hud"]
    hud_runs = []  # (run_t, hud dict)
    for e in huds:
        h = e.get("hud")
        if not isinstance(h, dict):
            continue
        t = rt(e.get("t", t0))
        hud_runs.append((t, h))

    # kills over run-time (cumulative)
    kill_points = []
    for t, h in hud_runs:
        k = _num(h.get("kills"))
        if k is not None:
            kill_points.append((t, k))

    def kills_in(a, b):
        """Kills that happened in run-time window [a, b)."""
        total = 0
        prev = 0
        have_prev = False
        for t, k in kill_points:
            if t < a:
                prev = k
                have_prev = True
                continue
            if t >= b:
                break
            if have_prev:
                total += max(0, k - prev)
            else:
                # first kill point in window: count all kills up to k
                total += k
            prev = k
            have_prev = True
        return total

    # alive / kills per run-minute (survivors only; empty for campaign)
    alive_per_min = []
    kills_per_min = []
    if mode == "survivors":
        nmin = max(1, int(math.ceil(duration / 60.0)))
        for m in range(nmin):
            a, b = m * 60.0, (m + 1) * 60.0
            vals = [
                _num(h.get("alive"))
                for t, h in hud_runs
                if a <= t < b
            ]
            alive_per_min.append(_mean(vals))
        kills_per_min = [kills_in(m * 60.0, (m + 1) * 60.0) for m in range(nmin)]

    # --- mod messages -------------------------------------------------------
    offers = []  # (t, msg)
    banners = []  # (t, text)
    warns = []
    ends = []
    chests = []
    for e in events:
        if e.get("type") != "mod":
            continue
        msg = e.get("msg")
        if not isinstance(msg, dict):
            continue
        t = e.get("t", t0)
        mtype = msg.get("type")
        if mtype == "offer":
            offers.append((t, msg))
        elif mtype == "banner":
            banners.append((t, str(msg.get("text", ""))))
        elif mtype == "warn":
            warns.append((t, str(msg.get("text", ""))))
        elif mtype == "end":
            ends.append((t, msg))
        elif mtype == "chest":
            chests.append(t)

    answers = [e for e in events if e.get("type") == "answer"]

    # --- level-ups ----------------------------------------------------------
    levelups = []
    levelup_gaps = []
    last_offer_rt = None
    for i, (t, msg) in enumerate(offers):
        t_rt = rt(t)
        answer = None
        for a in answers:
            if t <= a.get("t", 0) <= (offers[i + 1][0] if i + 1 < len(offers) else t1 + 60):
                answer = a
                break
        choose_s = None
        picked = None
        if answer is not None:
            choose_s = max(0.0, answer.get("t", 0) - t)
            v = answer.get("v")
            cards = msg.get("cards") or []
            if isinstance(v, int) and not isinstance(v, bool):
                if 0 <= v < len(cards):
                    picked = cards[v].get("name") if isinstance(cards[v], dict) else None
                elif v == 10:
                    picked = "reroll"
                elif v == 11:
                    picked = "skip"
                else:
                    picked = "skip"
            if picked is None:
                picked = "skip"
            choose_s = round(choose_s, 2)
        # run time at the offer
        run_time = None
        for t2, h in reversed(hud_runs):
            if t2 <= t:
                run_time = _num(h.get("time"))
                break
        levelups.append(
            {
                "t": round(t_rt, 2),
                "run_time": round(run_time, 1) if run_time is not None else None,
                "level": msg.get("level"),
                "choose_s": choose_s,
                "cards": [c.get("name") for c in (msg.get("cards") or []) if isinstance(c, dict)],
                "picked": picked,
            }
        )
        if last_offer_rt is not None:
            levelup_gaps.append(round(t_rt - last_offer_rt, 2))
        last_offer_rt = t_rt

    # --- downtime: run-time windows >= 15 s with no new kills, state "run" --
    downtime = []
    if kill_points:
        # kill_points has every HUD sample (twice a second): a gap starts at the last sample where
        # the kill count went UP, and ends at the next increase (or the last sample)
        seg_last_kill = kill_points[0][0]
        prev_k = kill_points[0][1]
        for t, k in kill_points[1:]:
            if k > prev_k:
                if t - seg_last_kill >= 15.0:
                    downtime.append({"from": round(seg_last_kill, 1), "to": round(t, 1)})
                seg_last_kill = t
            prev_k = k
        last_t = kill_points[-1][0]
        if last_t - seg_last_kill >= 15.0:   # trailing gap: no kill until the end of the samples
            downtime.append({"from": round(seg_last_kill, 1), "to": round(last_t, 1)})

    # --- damage spikes: top 5 biggest HP drops within 3 s -------------------
    damage_spikes = []
    for i in range(1, len(hp_series)):
        t_prev, hp_prev = hp_series[i - 1]
        t, hp = hp_series[i]
        if t - t_prev > 3.0:
            continue
        drop = hp_prev - hp
        if drop > 0:
            alive = None
            for t2, h in reversed(hud_runs):
                if t2 <= t:
                    alive = _num(h.get("alive"))
                    break
            damage_spikes.append(
                {
                    "t": round(t, 2),
                    "hp_before": round(hp_prev, 1),
                    "hp_after": round(hp, 1),
                    "alive": alive,
                    "_drop": drop,
                }
            )
    damage_spikes.sort(key=lambda s: s["_drop"], reverse=True)
    damage_spikes = [
        {k: v for k, v in s.items() if k != "_drop"} for s in damage_spikes[:5]
    ]

    # --- near death: times hp <= 25 -----------------------------------------
    near_death = [round(t, 2) for t, hp in hp_series if hp <= 25]

    # --- deaths: hp number -> null/0, or end with victory false --------------
    deaths = []
    for i in range(1, len(hp_series)):
        t_prev, hp_prev = hp_series[i - 1]
        t, hp = hp_series[i]
        if hp_prev > 0 and (hp == 0):
            deaths.append(round(t, 2))
    # hp number -> null
    all_hp = [(rt(e.get("t", t0)), _num(e.get("hp"))) for e in tels]
    prev_num = None
    for t, hp in all_hp:
        if hp is None:
            if prev_num is not None and prev_num > 0:
                if not (deaths and abs(t - deaths[-1]) < 1.0):
                    deaths.append(round(t, 2))
            prev_num = None
        else:
            prev_num = hp
    for t, msg in ends:
        if msg.get("victory") is False:
            deaths.append(round(rt(t), 2))
    deaths = sorted(set(deaths))

    # --- markers -------------------------------------------------------------
    markers = []
    for e in events:
        if e.get("type") != "marker":
            continue
        t = rt(e.get("t", t0))
        ctx = None
        for bt, text in banners:
            if e.get("t", 0) - 20.0 <= bt <= e.get("t", 0):
                ctx = text
        alive = None
        level = None
        for t2, h in reversed(hud_runs):
            if t2 <= t:
                alive = _num(h.get("alive"))
                level = h.get("level")
                break
        markers.append(
            {
                "t": round(t, 2),
                "kind": e.get("kind"),
                "run_time": round(t, 1),
                "context": ctx,
                "alive": alive,
                "level": level,
            }
        )

    # --- apm: key presses + clicks per minute in play ------------------------
    apm = None
    play_seconds = sum(b - a for a, b in play_windows)
    if play_seconds > 0:
        presses = 0.0
        for e in inputs:
            t = rt(e.get("t", t0))
            if not in_play(t):
                continue
            presses += _num(e.get("keys")) or 0.0
            presses += _num(e.get("clicks")) or 0.0
        apm = round(presses / (play_seconds / 60.0), 1)

    # --- idle: windows >= 10 s in play with no input -------------------------
    idle = []
    input_times = [rt(e.get("t", t0)) for e in inputs if in_play(rt(e.get("t", t0)))]
    for a, b in play_windows:
        # merge play windows that are contiguous
        pass
    # work over the merged in-play span
    merged = []
    for a, b in play_windows:
        if merged and a - merged[-1][1] <= 1.5:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    for a, b in merged:
        seg_inputs = [t for t in input_times if a <= t <= b]
        seg_inputs.sort()
        seg_start = a
        for t in seg_inputs:
            if t - seg_start >= 10.0:
                idle.append({"from": round(seg_start, 1), "to": round(t, 1)})
            seg_start = t
        if b - seg_start >= 10.0:
            idle.append({"from": round(seg_start, 1), "to": round(b, 1)})

    # --- perf ----------------------------------------------------------------
    perf = {
        "fps_p50": None,
        "fps_min": None,
        "work_p50_ms": None,
        "work_max_ms": None,
        "slow_seconds": 0.0,
    }
    if perf_samples:
        frames = [_num(p.get("frames")) for p in perf_samples]
        frames = [f for f in frames if f is not None]
        p50s = [_num(p.get("p50")) for p in perf_samples]
        p50s = [p for p in p50s if p is not None]
        maxs = [_num(p.get("max")) for p in perf_samples]
        maxs = [m for m in maxs if m is not None]
        if frames:
            perf["fps_p50"] = round(_mean(frames), 1)
            perf["fps_min"] = min(frames)
        if p50s:
            perf["work_p50_ms"] = round(_mean(p50s), 2)
        if maxs:
            perf["work_max_ms"] = round(max(maxs), 2)
        slow = 0.0
        for i, p in enumerate(perf_samples):
            f = _num(p.get("frames"))
            if f is not None and f < 50:
                dt = 1.0
                if i + 1 < len(perf_samples):
                    dt = rt(states[i + 1].get("t", t0)) - rt(states[i].get("t", t0))
                slow += max(0.0, dt)
        perf["slow_seconds"] = round(slow, 1)

    # --- survey ---------------------------------------------------------------
    survey_out = (survey or {}).get("answers") if isinstance(survey, dict) else None
    bot = bool(survey_out) and survey_out.get("other") == "bot"

    # --- result ----------------------------------------------------------------
    result = None
    if ends:
        msg = ends[-1][1]
        result = {
            "victory": msg.get("victory"),
            "run_time_s": _num(msg.get("time")),
            "level": msg.get("level"),
            "kills": msg.get("kills"),
            "score": msg.get("score"),
            "gold": msg.get("gold"),
        }

    summary = {
        "session": meta.get("session") or os.path.basename(os.path.normpath(str(meta.get("_dir", "")))),
        "mode": mode,
        "duration_s": round(duration, 2),
        "result": result,
        "levelups": levelups,
        "levelup_gaps_s": levelup_gaps,
        "kills_per_min": kills_per_min,
        "alive_per_min": alive_per_min,
        "downtime": downtime,
        "damage_spikes": damage_spikes,
        "near_death": near_death,
        "deaths": deaths,
        "markers": markers,
        "menu_time_s": round(menu_time, 1),
        "hidden_time_s": round(hidden_time, 1),
        "apm": apm,
        "idle": idle,
        "device_share": {k: round(v, 1) for k, v in sorted(device_share.items())},
        "perf": perf,
        "survey": survey_out,
        "bot": bot,
    }

    # --- campaign extras ---------------------------------------------------------
    if mode == "campaign":
        dist_points = []
        for e in tels:
            pos = e.get("pos")
            if isinstance(pos, (list, tuple)) and len(pos) >= 2 and all(
                _num(x) is not None for x in pos[:2]
            ):
                t = rt(e.get("t", t0))
                if tel_offset is not None:
                    gt = _num(e.get("gt"))
                    if gt is not None:
                        t = _clamp(t + (gt - gt0), 0.0, duration)
                dist_points.append((t, pos[0], pos[1]))
        distance = 0.0
        for i in range(1, len(dist_points)):
            _, x0, y0 = dist_points[i - 1]
            _, x1, y1 = dist_points[i]
            distance += math.hypot(x1 - x0, y1 - y0)
        play_min = max(play_seconds, 1.0) / 60.0
        summary["distance_per_min"] = round(distance / play_min, 1)

        weapon_switches = 0
        prev_weapon = None
        for e in tels:
            w = e.get("weapon")
            if isinstance(w, (int, float)) and w:
                if prev_weapon is not None and w != prev_weapon:
                    weapon_switches += 1
                prev_weapon = w
        summary["weapon_switches"] = weapon_switches

        ammo_out = 0
        prev_ammo_by_weapon = {}
        for e in tels:
            weapon = e.get("weapon")
            ammo = e.get("ammo")
            if not isinstance(ammo, (list, tuple)) or len(ammo) < 1:
                continue
            if not isinstance(weapon, (int, float)) or weapon < 0:
                continue
            idx = int(weapon)
            if idx >= len(ammo):
                continue
            cur = _num(ammo[idx])
            if cur is None:
                continue
            prev = prev_ammo_by_weapon.get(weapon)
            if prev is not None and prev > 0 and cur == 0:
                ammo_out += 1
            prev_ammo_by_weapon[weapon] = cur
        summary["ammo_out_events"] = ammo_out

    return summary, {
        "t0": t0,
        "duration": duration,
        "hp_series": hp_series,
        "hud_runs": hud_runs,
        "offers": [(rt(t), m) for t, m in offers],
        "banners": [(rt(t), text) for t, text in banners],
        "warns": [(rt(t), text) for t, text in warns],
        "ends": [(rt(t), m) for t, m in ends],
        "tels": tels,
    }


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


def write_summary(summary, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
        f.write("\n")


def _fmt(v, nd=1):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def write_markdown(summary, extra, path):
    s = summary
    lines = []
    ap = lines.append
    ap(f"# Playtest {s['session']}")
    ap("")

    # --- Summary ---
    ap("## Summary")
    ap("")
    r = s["result"]
    if r:
        outcome = "victory" if r.get("victory") else "defeat"
        ap(
            f"{s['mode']} session lasting {s['duration_s']:.0f} s ended in {outcome} "
            f"(level {r.get('level')}, {r.get('kills')} kills, score {r.get('score')}, "
            f"gold {r.get('gold')}). "
        )
    else:
        ap(
            f"{s['mode']} session lasting {s['duration_s']:.0f} s with no end message "
            f"(run cut off). "
        )
    ap(
        f"{len(s['levelups'])} level-ups, {len(s['deaths'])} death(s), "
        f"{sum(1 for d in s['downtime'])} downtime window(s) "
        f"({sum(d['to'] - d['from'] for d in s['downtime']):.0f} s total), "
        f"menu time {s['menu_time_s']:.0f} s."
    )
    ap("")
    ap("| metric | value |")
    ap("|---|---|")
    ap(f"| mode | {s['mode']} |")
    ap(f"| duration | {_fmt(s['duration_s'])} s |")
    if r:
        ap(f"| result | {r.get('victory')} (level {r.get('level')}, {r.get('kills')} kills) |")
    ap(f"| level-ups | {len(s['levelups'])} |")
    ap(f"| mean level-up gap | {_fmt(_mean(s['levelup_gaps_s']))} s |")
    total_kills = sum(s["kills_per_min"])
    ap(f"| total kills | {total_kills} |")
    ap(f"| kills/min | {_fmt(_mean([k for k in s['kills_per_min']] or [0]))} |")
    ap(f"| downtime | {sum(d['to'] - d['from'] for d in s['downtime']):.0f} s in {len(s['downtime'])} window(s) |")
    ap(f"| deaths | {len(s['deaths'])} |")
    ap(f"| menu time | {s['menu_time_s']:.0f} s |")
    ap(f"| apm | {_fmt(s['apm'])} |")
    p = s["perf"]
    ap(f"| fps (mean) | {_fmt(p['fps_p50'])} |")
    if s["mode"] == "campaign":
        ap(f"| distance/min | {_fmt(s.get('distance_per_min'))} m |")
        ap(f"| weapon switches | {s.get('weapon_switches', 0)} |")
        ap(f"| ammo-out events | {s.get('ammo_out_events', 0)} |")
    ap("")

    # --- Pacing ---
    ap("## Pacing")
    ap("")
    ap("Per run-minute: kills, mean alive, level reached, HP min, events, markers.")
    ap("")
    ap("| min | kills | alive | level | hp min | events | markers |")
    ap("|---|---|---|---|---|---|---|")
    nmin = max(1, int(math.ceil(s["duration_s"] / 60.0)))
    for m in range(nmin):
        a, b = m * 60.0, (m + 1) * 60.0
        kills = s["kills_per_min"][m] if m < len(s["kills_per_min"]) else 0
        alive = s["alive_per_min"][m] if m < len(s["alive_per_min"]) else None
        level = None
        for t, h in extra["hud_runs"]:
            if a <= t < b:
                level = h.get("level")
        hp_min = None
        for t, hp in extra["hp_series"]:
            if a <= t < b:
                hp_min = hp if hp_min is None else min(hp_min, hp)
        ev = []
        for t, m2 in extra["offers"]:
            if a <= t < b:
                ev.append(f"L{m2.get('level')} offer")
        for t, text in extra["banners"]:
            if a <= t < b:
                ev.append("banner")
        for t, text in extra["warns"]:
            if a <= t < b:
                ev.append("warn")
        for t, m2 in extra["ends"]:
            if a <= t < b:
                ev.append("end")
        marks = []
        for mk in s["markers"]:
            if a <= mk["t"] < b:
                marks.append(mk.get("kind") or "?")
        ap(
            f"| {m}-{m + 1} | {kills} | {_fmt(alive, 0)} | {level if level is not None else '-'} "
            f"| {_fmt(hp_min, 0)} | {'; '.join(ev) or '-'} | {' '.join(marks) or '-'} |"
        )
    ap("")

    # --- Level-ups ---
    ap("## Level-ups")
    ap("")
    if s["levelups"]:
        ap("| t (s) | run time | level | choose (s) | cards | picked |")
        ap("|---|---|---|---|---|---|")
        for lu in s["levelups"]:
            ap(
                f"| {_fmt(lu['t'])} | {_fmt(lu['run_time'])} | {lu['level'] if lu['level'] is not None else '-'} "
                f"| {_fmt(lu['choose_s'], 2)} | {' / '.join(lu['cards']) or '-'} | {lu['picked'] or '-'} |"
            )
        if s["levelup_gaps_s"]:
            ap("")
            ap(f"Gaps between offers (run s): {', '.join(_fmt(g) for g in s['levelup_gaps_s'])}")
    else:
        ap("No level-ups (campaign session or no offers recorded).")
    ap("")

    # --- Downtime and danger ---
    ap("## Downtime and danger")
    ap("")
    if s["downtime"]:
        ap("Downtime windows (no new kills while in play, >= 15 s):")
        ap("")
        for d in s["downtime"]:
            ap(f"- {d['from']:.0f}-{d['to']:.0f} s ({d['to'] - d['from']:.0f} s)")
    else:
        ap("No downtime windows of 15 s or more.")
    ap("")
    if s["damage_spikes"]:
        ap("Biggest HP drops (within 3 s):")
        ap("")
        for sp in s["damage_spikes"]:
            ap(
                f"- t={sp['t']:.1f} s: hp {sp['hp_before']:.0f} -> {sp['hp_after']:.0f} "
                f"(alive {sp['alive'] if sp['alive'] is not None else '-'})"
            )
    else:
        ap("No damage spikes detected.")
    ap("")
    if s["near_death"]:
        ap(f"Near death (hp <= 25) at: {', '.join(f'{t:.1f}' for t in s['near_death'])} s")
    ap("")
    if s["deaths"]:
        ap(f"Deaths at: {', '.join(f'{t:.1f}' for t in s['deaths'])} s")
    ap("")

    # --- Player ---
    ap("## Player")
    ap("")
    ap(f"Menu time: {s['menu_time_s']:.0f} s. Hidden time: {s['hidden_time_s']:.0f} s.")
    ap("")
    if s["apm"] is not None:
        ap(f"APM (keys + clicks per minute in play): {s['apm']:.1f}")
    ap("")
    if s["device_share"]:
        ap("Device share (in-play seconds): " + ", ".join(f"{k} {v:.0f} s" for k, v in s["device_share"].items()))
    ap("")
    if s["idle"]:
        ap("Idle windows (>= 10 s in play, no input):")
        for d in s["idle"]:
            ap(f"- {d['from']:.0f}-{d['to']:.0f} s")
    else:
        ap("No idle windows of 10 s or more.")
    ap("")

    # --- Performance ---
    ap("## Performance")
    ap("")
    p = s["perf"]
    ap(
        f"fps: mean {_fmt(p['fps_p50'])}, min {_fmt(p['fps_min'], 0)}; "
        f"engine work: p50 {_fmt(p['work_p50_ms'], 2)} ms, max {_fmt(p['work_max_ms'], 1)} ms; "
        f"slow seconds (< 50 fps): {p['slow_seconds']:.0f} s"
    )
    ap("")

    # --- Survey ---
    ap("## Survey")
    ap("")
    if s["survey"]:
        ap(f"Why: {(s.get('survey') or {}).get('why') if isinstance(s.get('survey'), dict) else ''}")
        for k, v in s["survey"].items():
            if v:
                ap(f"- {k}: {v}")
        if s["bot"]:
            ap("")
            ap("Flagged as a bot session.")
    else:
        ap("No survey.")
    ap("")

    # --- Notable moments ---
    ap("## Notable moments")
    ap("")
    moments = []
    for mk in s["markers"]:
        moments.append((mk["t"], f"marker: {mk.get('kind')}", mk))
    for t in s["deaths"]:
        moments.append((t, "death", None))
    for sp in s["damage_spikes"]:
        moments.append((sp["t"], f"hp {sp['hp_before']:.0f}->{sp['hp_after']:.0f}", sp))
    moments.sort(key=lambda m: m[0])
    if not moments:
        ap("None.")
    for t, label, _ in moments:
        a, b = max(0.0, t - 10.0), min(s["duration_s"], t + 10.0)
        kills = 0
        for m, k in enumerate(s["kills_per_min"]):
            if m * 60.0 < b and (m + 1) * 60.0 > a:
                kills += k
        alive = None
        for t2, h in extra["hud_runs"]:
            if t2 <= t:
                alive = h.get("alive")
        hp = None
        for t2, hpv in extra["hp_series"]:
            if t2 <= t:
                hp = hpv
        ap(
            f"- t={t:.1f} s — {label}; ±10 s: kills {kills}, "
            f"alive {alive if alive is not None else '-'}, hp {hp if hp is not None else '-'}"
        )
    ap("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def write_timeline(summary, extra, path):
    from PIL import Image, ImageDraw, ImageFont

    W, H = 1400, 700
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttf", 14)
        sfont = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
        sfont = font

    ML, MR, MT, MB = 70, 20, 40, 50
    plot_w = W - ML - MR
    plot_h = H - MT - MB
    duration = max(1.0, extra["duration"])

    def X(t):
        return ML + plot_w * (t / duration)

    # strip layout (top to bottom)
    strips = [
        ("alive", MT, 120),
        ("kills", MT + 140, 120),
        ("hp", MT + 280, 140),
        ("level", MT + 440, 100),
    ]
    base_y = MT + 560

    def Y(strip_name, v, vmax):
        _name, y0, h = strips[strip_index[strip_name]]
        return y0 + h - (h * (v / vmax if vmax else 0))

    strip_index = {n: i for i, (n, _, _) in enumerate(strips)}

    # --- monsters alive line ---
    name, y0, h = strips[0]
    d.text((ML, y0 - 18), "monsters alive", font=sfont, fill="black")
    d.line([(ML, y0 + h), (ML + plot_w, y0 + h)], fill="#cccccc")
    alive_pts = [(t, _num(hh.get("alive")) or 0) for t, hh in extra["hud_runs"]]
    if alive_pts:
        vmax = max(v for _, v in alive_pts) or 1
        pts = [(X(t), Y("alive", v, vmax)) for t, v in alive_pts]
        d.line(pts, fill="#888888", width=1)

    # --- kills per 10 s bars ---
    name, y0, h = strips[1]
    d.text((ML, y0 - 18), "kills / 10 s", font=sfont, fill="black")
    d.line([(ML, y0 + h), (ML + plot_w, y0 + h)], fill="#cccccc")
    kill_pts = []
    for t, hh in extra["hud_runs"]:
        k = _num(hh.get("kills"))
        if k is not None:
            kill_pts.append((t, k))
    bars = []
    for i in range(0, int(math.ceil(duration / 10.0))):
        a, b = i * 10.0, (i + 1) * 10.0
        total = 0
        prev = None
        for t, k in kill_pts:
            if t < a:
                prev = k
                continue
            if t >= b:
                break
            if prev is not None:
                total += max(0, k - prev)
            prev = k
        bars.append((a, b, total))
    if bars:
        vmax = max(v for _, _, v in bars) or 1
        for a, b, v in bars:
            x0, x1 = X(a), X(b)
            yv = Y("kills", v, vmax)
            d.rectangle([x0 + 1, yv, x1 - 1, y0 + h], fill="#cfe0f5", outline="#99aacc")

    # --- HP line ---
    name, y0, h = strips[2]
    d.text((ML, y0 - 18), "hp", font=sfont, fill="black")
    d.line([(ML, y0 + h), (ML + plot_w, y0 + h)], fill="#cccccc")
    if extra["hp_series"]:
        vmax = max(v for _, v in extra["hp_series"]) or 1
        pts = [(X(t), Y("hp", v, vmax)) for t, v in extra["hp_series"]]
        d.line(pts, fill="#cc6666", width=2)

    # --- XP level steps ---
    name, y0, h = strips[3]
    d.text((ML, y0 - 18), "xp level", font=sfont, fill="black")
    d.line([(ML, y0 + h), (ML + plot_w, y0 + h)], fill="#cccccc")
    levels = [(t, _num(hh.get("level")) or 1) for t, hh in extra["hud_runs"]]
    if levels:
        vmax = max(v for _, v in levels) or 1
        prev = None
        for t, v in levels:
            if prev is not None and v != prev[1]:
                d.line([(X(prev[0]), Y("level", prev[1], vmax)), (X(t), Y("level", prev[1], vmax))],
                       fill="#4488cc", width=2)
                d.line([(X(t), Y("level", prev[1], vmax)), (X(t), Y("level", v, vmax))],
                       fill="#4488cc", width=2)
            prev = (t, v)
        if prev is not None:
            d.line([(X(prev[0]), Y("level", prev[1], vmax)), (X(duration), Y("level", prev[1], vmax))],
                   fill="#4488cc", width=2)

    # --- vertical event lines ---
    for t, _m in extra["offers"]:
        d.line([(X(t), MT), (X(t), base_y)], fill="#3366cc", width=1)
    for t, text in extra["banners"] + extra["warns"]:
        d.line([(X(t), MT), (X(t), base_y)], fill="#bbbbbb", width=1)
        label = text[:18]
        d.text((X(t) + 2, MT + 2), label, font=sfont, fill="#666666")
    for mk in summary["markers"]:
        t = mk["t"]
        color = {"fun": "#33aa33", "boring": "#ee9922", "bug": "#cc2222"}.get(mk.get("kind"), "#999999")
        d.line([(X(t), MT), (X(t), base_y)], fill=color, width=2)
    for t in summary["deaths"]:
        d.line([(X(t), MT), (X(t), base_y)], fill="black", width=2)

    # --- x axis ---
    d.line([(ML, base_y), (ML + plot_w, base_y)], fill="black")
    step = 30 if duration > 600 else (10 if duration > 120 else 5)
    tick = 0
    while tick <= duration:
        x = X(tick)
        d.line([(x, base_y), (x, base_y + 5)], fill="black")
        d.text((x - 10, base_y + 8), str(int(tick)), font=sfont, fill="black")
        tick += step
    d.text((ML + plot_w // 2 - 40, H - 20), "run time (s)", font=font, fill="black")

    # --- legend ---
    lx, ly = ML + 10, MT + 4
    items = [
        ("alive", "#888888", "line"),
        ("kills/10s", "#cfe0f5", "bar"),
        ("hp", "#cc6666", "line"),
        ("level", "#4488cc", "line"),
        ("level-up", "#3366cc", "line"),
        ("banner/warn", "#bbbbbb", "line"),
        ("fun", "#33aa33", "line"),
        ("boring", "#ee9922", "line"),
        ("bug", "#cc2222", "line"),
        ("death", "black", "line"),
    ]
    for label, color, kind in items:
        if kind == "bar":
            d.rectangle([lx, ly, lx + 16, ly + 10], fill=color, outline="#99aacc")
        else:
            d.line([(lx, ly + 5), (lx + 16, ly + 5)], fill=color, width=2)
        d.text((lx + 20, ly), label, font=sfont, fill="black")
        ly += 16

    img.save(path)


def write_compare(summaries, path):
    lines = ["# Playtest comparison", ""]
    header = ["metric"] + [s["session"] for s in summaries]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "---|" * len(header))

    def row(name, fn):
        vals = []
        for s in summaries:
            try:
                v = fn(s)
            except Exception:
                v = "-"
            vals.append("-" if v is None else str(v))
        lines.append(f"| {name} | " + " | ".join(vals) + " |")

    row("duration (s)", lambda s: f"{s['duration_s']:.0f}")
    row("result", lambda s: ("victory" if (s["result"] or {}).get("victory") else "defeat")
        if s["result"] else "no end")
    row("level", lambda s: (s["result"] or {}).get("level") if s["result"] else "-")
    row("kills", lambda s: (s["result"] or {}).get("kills") if s["result"] else sum(s["kills_per_min"]))
    row("kills/min", lambda s: _mean(s["kills_per_min"]))
    row("mean level-up gap (s)", lambda s: _mean(s["levelup_gaps_s"]))
    row("downtime total (s)", lambda s: sum(d["to"] - d["from"] for d in s["downtime"]))
    row("menu time (s)", lambda s: f"{s['menu_time_s']:.0f}")
    row("fps (mean)", lambda s: s["perf"]["fps_p50"])
    row("survey fun", lambda s: (s["survey"] or {}).get("fun") if s["survey"] else "-")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def process_session(session_dir, out_dir):
    session_dir = os.path.abspath(session_dir)
    events, meta, survey = load(session_dir)
    if not events:
        return None
    result = analyse(events, meta, survey)
    if result is None:
        return None
    summary, extra = result
    if not summary["session"]:
        summary["session"] = os.path.basename(session_dir)
    target = os.path.join(out_dir, summary["session"]) if out_dir else os.path.join(session_dir, "report")
    os.makedirs(target, exist_ok=True)
    write_summary(summary, os.path.join(target, "summary.json"))
    write_markdown(summary, extra, os.path.join(target, "report.md"))
    write_timeline(summary, extra, os.path.join(target, "timeline.png"))
    return summary


def main(argv):
    args = []
    out_dir = None
    i = 0
    while i < len(argv):
        if argv[i] == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if not args:
        print("usage: playtest-report.py <session-dir> [...] [--out <dir>]", file=sys.stderr)
        return 2

    summaries = []
    for d in args:
        s = process_session(d, out_dir)
        if s is None:
            print(f"warn: no events in {d}", file=sys.stderr)
            continue
        summaries.append(s)
        print(f"report written: {s['session']}")

    if len(summaries) >= 2:
        if out_dir:
            compare_path = os.path.join(out_dir, "compare.md")
        else:
            first = os.path.abspath(args[0])
            compare_path = os.path.join(os.path.dirname(first), "compare.md")
        write_compare(summaries, compare_path)
        print(f"compare written: {compare_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
