"""Unit tests for playtriage.py (plain unittest): one synthetic session with every kind of problem."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import playtriage  # noqa: E402


def session(root, name, events, console, options=None):
    d = os.path.join(root, name)
    os.makedirs(d)
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump({"session": name, "mode": "quiet", "started": "2026-11-24T00:00:00Z", "options": options or {}}, f)
    with open(os.path.join(d, "telemetry.jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    with open(os.path.join(d, "console.txt"), "w") as f:
        for t, level, text in console:
            f.write(f"{t}\t{level}\t{text}\n")
    for t in (10.0, 40.0, 41.0):
        open(os.path.join(d, f"shot-{int(t * 10):06d}.jpg"), "wb").close()
    os.utime(os.path.join(d, "telemetry.jsonl"), (0, 0))   # old: not "still recording"
    os.utime(os.path.join(d, "console.txt"), (0, 0))
    return d


def build_events():
    ev = []
    pos = [0.0, 0.0, 0.0]
    for t in range(1, 61):
        if t < 20:
            pos = [float(t), 0.0, 0.0]          # walking
        hp = 0 if t in (40, 50) else 100
        ev.append({"t": t, "type": "tel", "world": "Levels/Test.wld", "hp": hp, "pos": list(pos), "weapon": 2})
        codes = {"KeyW": 1} if 20 <= t < 32 else {}
        if t == 35:
            codes = {"KeyE": 9}
        ev.append({"t": t, "type": "input", "codes": codes, "keys": sum(codes.values())})
        p50 = 30 if 5 <= t < 12 else 2
        ev.append({"t": t, "type": "state", "play": 1, "hidden": False, "locked": True, "perf": {"p50": p50, "max": 40}})
    ev += [{"t": 15, "type": "hitch", "ms": 300, "over50": 2},
           {"t": 40, "type": "death", "world": "Levels/Test.wld", "pos": [19, 0, 0], "weapon": 2},
           {"t": 50, "type": "death", "world": "Levels/Test.wld", "pos": [21, 0, 3], "weapon": 2},
           {"t": 25, "type": "error", "kind": "exception", "msg": "TypeError: x is undefined", "at": "gfx.js:10"},
           {"t": 33, "type": "marker", "kind": "bug"}]
    return ev


class Triage(unittest.TestCase):
    def test_all_findings(self):
        with tempfile.TemporaryDirectory() as root:
            console = [(0.5, "log", "Cannot open file `/Startup.txt'"),
                       (30, "log", "Cannot spawn entity 12"), (31, "log", "Cannot spawn entity 13"),
                       (32, "log", "MPX playing disabled: Cannot load amp11lib"),
                       (33, "log", "everything is fine")]
            d = session(root, "s1", build_events(), console, {"rec": "quiet", "?gyrosens": "1"})
            self.assertEqual(playtriage.needs_triage(d), "new")
            self.assertEqual(playtriage.main(["--dir", root, "--new"]), 0)
            out = json.load(open(os.path.join(d, "triage.json")))
            kinds = {}
            for f in out["findings"]:
                kinds.setdefault(f["kind"], []).append(f)
            self.assertEqual(kinds["error"][0]["severity"], "high")
            self.assertEqual(kinds["marker"][0]["severity"], "high")
            # the two "Cannot spawn entity" lines are one group; amp11lib is ignored; fine lines are not problems
            console_f = [f["summary"] for f in kinds["console"]]
            self.assertEqual(sum("Cannot spawn entity" in s for s in console_f), 1, console_f)
            self.assertTrue(any("x2" in s for s in console_f), console_f)
            self.assertFalse(any("amp11lib" in s or "fine" in s for s in console_f), console_f)
            self.assertTrue(any(s.startswith("new at startup") for s in console_f), console_f)
            self.assertEqual(kinds["hitch"][0]["severity"], "med")
            self.assertEqual(kinds["slow"][0]["t"], 5)
            self.assertTrue(any(f["summary"] == "died 2 times here" for f in kinds["death"]))
            self.assertIn("quit", kinds)
            self.assertEqual(kinds["stuck"][0]["severity"], "med")
            self.assertIn("mash", kinds)
            self.assertIn("option", kinds)
            self.assertEqual(out["summary"]["deaths"], 2)
            # findings carry their nearest screenshots
            self.assertIn("shot-000400.jpg", kinds["death"][0]["shots"])
            self.assertTrue(os.path.exists(os.path.join(d, "triage.md")))
            # triaged: no longer in the inbox; the console lines are now known
            self.assertIsNone(playtriage.needs_triage(d))
            self.assertEqual(playtriage.inbox_lines(root), [])
            d2 = session(root, "s2", build_events(), console)
            playtriage.main(["--dir", root, d2])
            out2 = json.load(open(os.path.join(d2, "triage.json")))
            self.assertNotIn("console", {f["kind"] for f in out2["findings"]})
            self.assertGreater(out2["summary"]["known_console_problems"], 0)

    def test_hook_output(self):
        with tempfile.TemporaryDirectory() as root:
            session(root, "s1", build_events(), [])
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with redirect_stdout(buf):
                playtriage.main(["--dir", root, "--hook"])
            j = json.loads(buf.getvalue())
            self.assertEqual(j["hookSpecificOutput"]["hookEventName"], "SessionStart")
            self.assertIn("s1", j["hookSpecificOutput"]["additionalContext"])
            buf = io.StringIO()
            with redirect_stdout(buf):
                playtriage.main(["--dir", os.path.join(root, "none"), "--hook"])
            self.assertEqual(buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
