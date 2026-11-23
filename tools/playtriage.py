#!/usr/bin/env python3
"""Find problems in recorded play sessions, without the player reporting anything.

The page records every session played from the dev server (port/web/playtest.js, quiet mode) into
data/playtests/<session>/. This reads a session's telemetry, console and screenshots and writes
  <session>/triage.md    findings, most severe first, each with time, level, position and the
                         nearest screenshots
  <session>/triage.json  the same, for tools
and remembers the console problem lines it has seen (data/playtests/.baseline.json), so a line
that every session prints is "known" and only new ones are raised.

Usage:
    python3 tools/playtriage.py <session-dir> [...]   triage these sessions
    python3 tools/playtriage.py --new                 triage every session not triaged yet
    python3 tools/playtriage.py --inbox               list sessions not triaged yet (no output if none)
    python3 tools/playtriage.py --hook                the same as Claude Code SessionStart context JSON
Options: --dir DIR (default data/playtests).

Only the Python 3 standard library.
"""

import json
import math
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DIR = os.path.join(ROOT, "data", "playtests")
IGNORE_FILE = os.path.join(ROOT, "tools", "playtriage-ignore.txt")
RECORDING_S = 120            # a session written to in the last 2 minutes is still being played
SEV = {"high": 0, "med": 1, "low": 2, "info": 3}
MOVE_KEYS = {"KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"}
PROBLEM = re.compile(r"error|exception|abort|assert|fail|cannot|can't|unable|invalid|missing|overran|lost|warning|!!", re.I)


# ---------------------------------------------------------------------------- loading

def load(sdir):
    def jload(name, default):
        try:
            with open(os.path.join(sdir, name), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default
    events = []
    try:
        with open(os.path.join(sdir, "telemetry.jsonl"), encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    ev = json.loads(line)
                    if isinstance(ev, dict) and isinstance(ev.get("t"), (int, float)):
                        events.append(ev)
                except ValueError:
                    pass
    except OSError:
        pass
    events.sort(key=lambda e: e["t"])
    console = []   # (t, level, text)
    try:
        with open(os.path.join(sdir, "console.txt"), encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t", 2)
                if len(parts) == 3:
                    try:
                        console.append((float(parts[0]), parts[1], parts[2]))
                    except ValueError:
                        pass
    except OSError:
        pass
    shots = []
    for n in sorted(os.listdir(sdir)) if os.path.isdir(sdir) else []:
        m = re.fullmatch(r"shot-(\d+)\.jpg", n)
        if m:
            shots.append((int(m.group(1)) / 10.0, n))
    return jload("meta.json", {}), events, console, shots


def norm(text):
    """A console line with its numbers and quoted names blurred, to group repeats."""
    text = re.sub(r"0x[0-9a-fA-F]+", "#", text)
    text = re.sub(r"\d+(\.\d+)?", "#", text)
    return text.strip()[:300]


def load_ignore():
    pats = []
    try:
        with open(IGNORE_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    pats.append(re.compile(line, re.I))
    except OSError:
        pass
    return pats


# ---------------------------------------------------------------------------- analysis

class Ctx:
    """Where the player was at a time: level and position from the last tel sample before it."""

    def __init__(self, events):
        self.tel = [e for e in events if e.get("type") == "tel"]

    def at(self, t):
        best = None
        for e in self.tel:
            if e["t"] > t + 0.5:
                break
            best = e
        if not best:
            return None, None
        pos = best.get("pos")
        return best.get("world"), [round(v, 1) for v in pos] if isinstance(pos, list) else None


def finding(sev, kind, t, summary, evidence=None, ctx=None, t_end=None):
    world, pos = ctx.at(t) if ctx else (None, None)
    return {"severity": sev, "kind": kind, "t": round(t, 1), "t_end": round(t_end, 1) if t_end is not None else None,
            "world": world, "pos": pos, "summary": summary, "evidence": (evidence or [])[:8]}


def analyse(meta, events, console, baseline, ignore):
    ctx = Ctx(events)
    out = []
    end_t = max([e["t"] for e in events] + [c[0] for c in console] + [0])

    # errors the page saw
    groups = {}
    for e in events:
        if e.get("type") == "error":
            key = (e.get("kind"), norm(str(e.get("msg", ""))))
            groups.setdefault(key, []).append(e)
    for (kind, _), evs in groups.items():
        e = evs[0]
        out.append(finding("high", "error", e["t"], f"{kind}: {str(e.get('msg', ''))[:160]}" + (f" (x{len(evs)})" if len(evs) > 1 else ""),
                           [f"t={x['t']} {x.get('at', '')}" for x in evs], ctx))

    # console problem lines: new ones (not in the baseline) are raised; known ones are only counted
    first_tel = min([e["t"] for e in ctx.tel] + [end_t])
    seen = {}
    for t, level, text in console:
        if not (level in ("error", "warn") or PROBLEM.search(text)):
            continue
        if any(p.search(text) for p in ignore):
            continue
        seen.setdefault(norm(text), []).append((t, level, text))
    new_lines, known = [], 0
    for key, hits in seen.items():
        if key in baseline:
            known += len(hits)
            continue
        t, level, text = hits[0]
        startup = t <= first_tel + 5   # the first seconds of a level are loading too
        sev = "high" if level == "error" and not startup else "med" if not startup else "low"
        new_lines.append(finding(sev, "console", t, ("new at startup: " if startup else "new: ") + text[:200] +
                                 (f" (x{len(hits)})" if len(hits) > 1 else ""), [f"t={h[0]} [{h[1]}] {h[2][:300]}" for h in hits], ctx))
    out += new_lines

    # hitches: frames over 100 ms in play, per level
    hitches = [e for e in events if e.get("type") == "hitch"]
    by_world = {}
    for e in hitches:
        by_world.setdefault(ctx.at(e["t"])[0], []).append(e)
    for world, evs in by_world.items():
        worst = max(e.get("ms", 0) for e in evs)
        sev = "med" if worst > 250 or len(evs) >= 5 else "low"
        f = finding(sev, "hitch", evs[0]["t"], f"{len(evs)} hitch(es) in play, worst {worst:.0f} ms",
                    [f"t={e['t']} {e.get('ms')} ms ({e.get('over50', '?')} frames > 50 ms)" for e in sorted(evs, key=lambda e: -e.get("ms", 0))], ctx)
        f["world"] = world
        out.append(f)

    # slow stretches: median frame work over 20 ms for 5+ seconds in a row while playing
    run = []
    states = [e for e in events if e.get("type") == "state"]
    for e in states + [{"t": 1e9, "type": "state"}]:
        p = (e.get("perf") or {}).get("p50")
        if e.get("play") == 1 and not e.get("hidden") and isinstance(p, (int, float)) and p > 20:
            run.append(e)
            continue
        if len(run) >= 5:
            p50s = sorted(r["perf"]["p50"] for r in run)
            out.append(finding("med", "slow", run[0]["t"], f"{len(run)} s at a median {p50s[len(p50s) // 2]:.1f} ms of engine work per frame",
                               [f"t={r['t']} p50 {r['perf']['p50']} max {r['perf'].get('max')}" for r in run], ctx, run[-1]["t"]))
        run = []

    # deaths: repeated deaths at one spot, and quitting soon after dying
    deaths = [e for e in events if e.get("type") == "death"]
    clusters = []
    for d in deaths:
        pos = d.get("pos") or [0, 0, 0]
        for c in clusters:
            if c["world"] == d.get("world") and math.hypot(pos[0] - c["pos"][0], pos[2] - c["pos"][2]) < 15:
                c["deaths"].append(d)
                break
        else:
            clusters.append({"world": d.get("world"), "pos": pos, "deaths": [d]})
    for c in clusters:
        n = len(c["deaths"])
        d0 = c["deaths"][0]
        f = finding("med" if n >= 2 else "low", "death", d0["t"],
                    f"died {n} times here" if n >= 2 else f"died (weapon {d0.get('weapon')})",
                    [f"t={d['t']} weapon {d.get('weapon')} pos {d.get('pos')}" for d in c["deaths"]], ctx)
        f["world"], f["pos"] = c["world"], [round(v, 1) for v in c["pos"]]
        out.append(f)
    if deaths and end_t - deaths[-1]["t"] < 60:
        out.append(finding("med", "quit", deaths[-1]["t"], f"session ended {end_t - deaths[-1]['t']:.0f} s after a death "
                           f"({len(deaths)} death(s) in the session)", None, ctx, end_t))

    # stuck: pressing movement keys but not moving, while alive and playing
    inputs = {round(e["t"]): e for e in events if e.get("type") == "input"}
    play = {round(e["t"]): e.get("play") == 1 and not e.get("hidden") for e in states}
    tel = ctx.tel
    win = []
    for a, b in zip(tel, tel[1:]):
        pa, pb = a.get("pos"), b.get("pos")
        moving_keys = sum(v for k, v in (inputs.get(round(b["t"]), {}).get("codes") or {}).items() if k in MOVE_KEYS)
        still = pa and pb and math.hypot(pb[0] - pa[0], pb[2] - pa[2]) < 0.3 and a.get("world") == b.get("world")
        if still and (b.get("hp") or 0) > 0 and play.get(round(b["t"]), False):
            win.append((b, moving_keys))
            continue
        if len(win) >= 6 and sum(k for _, k in win) >= 3:
            out.append(finding("med" if len(win) >= 10 else "low", "stuck", win[0][0]["t"],
                               f"{len(win)} s without moving while pressing movement keys {sum(k for _, k in win)} times",
                               None, ctx, win[-1][0]["t"]))
        win = []

    # friction: mouse not captured during play; one key mashed
    unlocked = [e for e in states if e.get("play") == 1 and not e.get("hidden") and e.get("locked") is False]
    if len(unlocked) >= 5:
        out.append(finding("low", "pointer", unlocked[0]["t"], f"{len(unlocked)} s in play without the mouse captured", None, ctx))
    for e in events:
        if e.get("type") != "input":
            continue
        for code, n in (e.get("codes") or {}).items():
            if n >= 6 and code not in MOVE_KEYS:
                out.append(finding("low", "mash", e["t"], f"{code} pressed {n} times in one second (something not responding?)", None, ctx))

    # URL options the page can't have meant: "?a=1?b=2" makes a key "?b" that nothing reads
    for k, v in (meta.get("options") or {}).items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", k):
            out.append(finding("med", "option", 0, f"URL option {k!r}={v!r} is malformed and ignored (a second '?' instead of '&'?)", None, None))

    # mostly idle: in a menu, paused or in a hidden tab most of a long session
    in_play = sum(1 for e in states if e.get("play") == 1 and not e.get("hidden"))
    if end_t > 300 and in_play < 0.25 * end_t:
        hidden = sum(1 for e in states if e.get("hidden"))
        out.append(finding("info", "idle", 0, f"in play {in_play // 60} of {end_t / 60:.0f} min ({hidden // 60} min in a hidden tab): "
                           "left open, or stuck in a menu?", None, None))

    # what the player marked
    for e in events:
        if e.get("type") == "marker":
            k = e.get("kind")
            out.append(finding({"bug": "high", "boring": "med"}.get(k, "info"), "marker", e["t"], f"player marked: {k}", None, ctx))

    out.sort(key=lambda f: (SEV[f["severity"]], f["t"]))
    return out, known, seen


def summary(meta, events, console):
    tel = [e for e in events if e.get("type") == "tel"]
    states = [e for e in events if e.get("type") == "state"]
    end_t = max([e["t"] for e in events] + [0])
    worlds = {}
    for a, b in zip(tel, tel[1:]):
        worlds[a.get("world")] = worlds.get(a.get("world"), 0) + (b["t"] - a["t"])
    p50 = sorted((e.get("perf") or {}).get("p50") for e in states if e.get("play") == 1 and (e.get("perf") or {}).get("p50") is not None)
    in_play = sum(1 for e in states if e.get("play") == 1 and not e.get("hidden"))
    build = next((e.get("wasmModified") for e in events if e.get("type") == "build"), None)
    return {"session": meta.get("session"), "mode": meta.get("mode", "playtest"), "started": meta.get("started"),
            "options": meta.get("options"), "duration_s": round(end_t), "in_play_s": in_play,
            "levels": {k: round(v) for k, v in sorted(worlds.items(), key=lambda kv: -kv[1]) if k},
            "deaths": sum(1 for e in events if e.get("type") == "death"),
            "frame_work_p50_ms": p50[len(p50) // 2] if p50 else None, "build": build, "console_lines": len(console)}


def nearest_shots(shots, t, t_end=None, n=3):
    lo, hi = t - 10, (t_end if t_end is not None else t) + 6
    near = [s for s in shots if lo <= s[0] <= hi]
    if not near and shots:
        near = sorted(shots, key=lambda s: abs(s[0] - t))[:1]
        if abs(near[0][0] - t) > 30:
            near = []
    near.sort(key=lambda s: abs(s[0] - t))
    return sorted(near[:n])


def fmt_t(t):
    return f"{int(t // 60)}:{int(t % 60):02d}"


def triage(sdir, baseline, ignore):
    meta, events, console, shots = load(sdir)
    findings, known, seen = analyse(meta, events, console, baseline, ignore)
    for f in findings:
        f["shots"] = [n for _, n in nearest_shots(shots, f["t"], f.get("t_end"))]
    summ = summary(meta, events, console)
    summ["known_console_problems"] = known
    with open(os.path.join(sdir, "triage.json"), "w", encoding="utf-8") as fh:
        json.dump({"summary": summ, "findings": findings}, fh, indent=1)
    md = [f"# Play session {summ['session']}", "",
          f"{summ['mode']} recording, started {summ['started']}, {fmt_t(summ['duration_s'])} long, {fmt_t(summ['in_play_s'])} in play. "
          f"Options: `{json.dumps(summ['options'])}`. Build: {summ['build']}.", "",
          "Levels: " + (", ".join(f"{k} {fmt_t(v)}" for k, v in summ["levels"].items()) or "none") +
          f". Deaths: {summ['deaths']}. Median engine work per frame in play: {summ['frame_work_p50_ms']} ms. "
          f"Known console problems (in the baseline): {known}.", "", "## Findings", ""]
    if not findings:
        md.append("Nothing found.")
    for i, f in enumerate(findings, 1):
        where = " ".join(x for x in [f["world"] or "", f"at {f['pos']}" if f["pos"] else ""] if x)
        span = f"{fmt_t(f['t'])}" + (f"–{fmt_t(f['t_end'])}" if f.get("t_end") else "")
        md.append(f"{i}. **{f['severity']} {f['kind']}** at {span}{' in ' + where if where else ''}: {f['summary']}")
        for ev in f["evidence"][:5]:
            md.append(f"   - `{ev}`")
        if f["shots"]:
            md.append("   - " + " ".join(f"![{n}]({n})" for n in f["shots"]))
    with open(os.path.join(sdir, "triage.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    # the console problems of this session are known from now on
    for key in seen:
        baseline.setdefault(key, summ["session"])
    return summ, findings


# ---------------------------------------------------------------------------- inbox

def sessions(root):
    try:
        names = sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)) and not n.startswith("."))
    except OSError:
        return []
    return [os.path.join(root, n) for n in names]


def needs_triage(sdir):
    """None if triaged and unchanged since, else 'new' or 'recording'."""
    mtimes = [os.path.getmtime(os.path.join(sdir, n)) for n in ("telemetry.jsonl", "console.txt") if os.path.exists(os.path.join(sdir, n))]
    if not mtimes:
        return None
    last = max(mtimes)
    tj = os.path.join(sdir, "triage.json")
    if os.path.exists(tj) and os.path.getmtime(tj) >= last:
        return None
    return "recording" if time.time() - last < RECORDING_S else "new"


def inbox_lines(root):
    lines = []
    for sdir in sessions(root):
        state = needs_triage(sdir)
        if not state:
            continue
        meta = {}
        try:
            with open(os.path.join(sdir, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            pass
        size = sum(os.path.getsize(os.path.join(sdir, n)) for n in os.listdir(sdir))
        lines.append((state, f"{os.path.basename(sdir)}  {meta.get('mode', 'playtest')}  {size // 1024} KB" +
                      ("  (still recording)" if state == "recording" else "")))
    return lines


def short(path):
    """A path relative to the repo when it is inside it, else absolute."""
    rel = os.path.relpath(os.path.abspath(path), ROOT)
    return os.path.abspath(path) if rel.startswith("..") else rel


def main(argv):
    root = DEFAULT_DIR
    if "--dir" in argv:
        i = argv.index("--dir")
        root = argv[i + 1]
        del argv[i:i + 2]
    if "--inbox" in argv or "--hook" in argv:
        lines = inbox_lines(root)
        if not lines:
            return 0
        rel = short(root)
        text = f"{len(lines)} play session(s) recorded and not triaged yet ({rel}):\n" + "\n".join(l for _, l in lines)
        if "--hook" in argv:
            text += ("\nThe user plays without reporting problems: run `python3 tools/playtriage.py --new`, read the "
                     "triage.md files and the screenshots they link, and raise or fix what they show.")
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
        else:
            print(text)
        return 0
    targets = [a for a in argv if not a.startswith("--")]
    if "--new" in argv:
        targets += [s for s in sessions(root) if needs_triage(s) == "new"]
    if not targets:
        if "--new" in argv:
            waiting = [s for s in sessions(root) if needs_triage(s) == "recording"]
            print("no new play sessions" + (f" ({len(waiting)} still recording)" if waiting else ""))
            return 0
        print(__doc__.strip())
        return 2
    bpath = os.path.join(root, ".baseline.json")
    try:
        with open(bpath, encoding="utf-8") as f:
            baseline = json.load(f)
    except (OSError, ValueError):
        baseline = {}
    ignore = load_ignore()
    for sdir in targets:
        summ, findings = triage(sdir, baseline, ignore)
        counts = {}
        for f in findings:
            counts[f["severity"]] = counts.get(f["severity"], 0) + 1
        print(f"{short(os.path.join(sdir, 'triage.md'))}: {fmt_t(summ['duration_s'])}, "
              + (", ".join(f"{counts[s]} {s}" for s in SEV if s in counts) or "nothing found"))
    os.makedirs(root, exist_ok=True)
    with open(bpath, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
