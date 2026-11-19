"""Unit tests for playtest-report.py (plain unittest, no pytest)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib

report = importlib.import_module("playtest-report")


def mk(t, **kw):
    d = {"type": kw.pop("type", "tel"), "t": t}
    d.update(kw)
    return d

def hud(t, time, kills=0, alive=5, level=1, state="run", **kw):
    h = {
        "type": "hud",
        "time": time,
        "run": 1200,
        "level": level,
        "xp": 0,
        "next": 5,
        "kills": kills,
        "score": 0,
        "combo": 0,
        "gold": 0,
        "alive": alive,
        "gems": 0,
        "guns": [],
        "abilities": [],
        "passives": [],
        "boss": None,
        "powers": [],
        "state": state,
        "pos": [0, 0, 0],
        "yaw": 0,
    }
    h.update(kw)
    return mk(t, type="hud", hud=h)


def tel(t, gt, hp=None, pos=None, weapon=2, ammo=None, **kw):
    d = mk(t, type="tel", gt=gt, hp=hp, pos=pos, weapon=weapon,
           ammo=ammo if ammo is not None else [0, 0, 0, 0, 0, 0])
    d.update(kw)
    return d


def state_ev(t, play=1, hidden=False, perf=None, device="mouse"):
    return mk(t, type="state", play=play, locked=False, hidden=hidden,
              fullscreen=False, perf=perf, device=device)


def input_ev(t, keys=0, clicks=0, mouse=0, wheel=0, device="mouse"):
    return mk(t, type="input", keys=keys, codes={}, mouse=mouse, clicks=clicks,
              wheel=wheel, device=device)


def mod(t, mtype, **kw):
    msg = {"type": mtype}
    msg.update(kw)
    return mk(t, type="mod", msg=msg)


class TestDowntime(unittest.TestCase):
    def test_detects_kill_free_window(self):
        events = [
            mk(0, type="start"),
            hud(1, 0, kills=10, alive=5),
            hud(2, 1, kills=10, alive=5),
            # no kills from run-time 1 to 20
            hud(21, 20, kills=11, alive=5),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(len(summary["downtime"]), 1)
        d = summary["downtime"][0]
        self.assertAlmostEqual(d["from"], 1, delta=1.0)
        self.assertAlmostEqual(d["to"], 20, delta=1.0)

    def test_dense_samples_kill_free_window(self):
        # real recordings have a HUD sample every 0.5 s; a 30 s stretch without kills must show
        events = [mk(0, type="start")]
        kills = 0
        for i in range(0, 120):
            rt = i * 0.5
            if rt < 10 and i % 4 == 0:
                kills += 1          # kills up to 10 s
            if rt >= 40 and i % 4 == 0:
                kills += 1          # and again from 40 s
            events.append(hud(rt + 1, rt, kills=kills))
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(len(summary["downtime"]), 1, summary["downtime"])
        d = summary["downtime"][0]
        self.assertGreaterEqual(d["to"] - d["from"], 28)

    def test_short_gap_not_reported(self):
        events = [
            mk(0, type="start"),
            hud(1, 0, kills=10),
            hud(6, 5, kills=11),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["downtime"], [])


class TestDamageSpikes(unittest.TestCase):
    def test_top5_biggest_drops(self):
        events = [
            mk(0, type="start"),
            tel(1, 0, hp=100),
            tel(2, 1, hp=80),   # drop 20
            tel(3, 2, hp=95),
            tel(4, 3, hp=55),   # drop 40
            tel(5, 4, hp=60),
            tel(6, 5, hp=30),   # drop 30
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(len(summary["damage_spikes"]), 3)
        self.assertEqual(summary["damage_spikes"][0]["hp_before"], 95.0)
        self.assertEqual(summary["damage_spikes"][0]["hp_after"], 55.0)
        # sorted by drop size
        drops = [b - a for b, a in
                 [(s["hp_before"], s["hp_after"]) for s in summary["damage_spikes"]]]
        self.assertEqual(drops, sorted(drops, reverse=True))

    def test_drops_over_3s_ignored(self):
        events = [
            mk(0, type="start"),
            tel(1, 0, hp=100),
            tel(5, 4, hp=40),  # 4 s apart
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["damage_spikes"], [])


class TestLevelUps(unittest.TestCase):
    def test_gaps_and_choose_time(self):
        events = [
            mk(0, type="start"),
            hud(1, 0, level=1),
            mod(10, "offer", level=2, cards=[
                {"id": "a", "name": "CardA", "cat": "gun", "rank": 1, "desc": "", "evo": ""},
                {"id": "b", "name": "CardB", "cat": "gun", "rank": 1, "desc": "", "evo": ""},
            ]),
            mk(12.5, type="answer", v=1),
            mod(30, "offer", level=3, cards=[
                {"id": "c", "name": "CardC", "cat": "gun", "rank": 1, "desc": "", "evo": ""},
            ]),
            mk(30.1, type="answer", v=11),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(len(summary["levelups"]), 2)
        lu0, lu1 = summary["levelups"]
        self.assertEqual(lu0["picked"], "CardB")
        self.assertAlmostEqual(lu0["choose_s"], 2.5, delta=0.05)
        self.assertEqual(lu1["picked"], "skip")
        self.assertAlmostEqual(lu1["choose_s"], 0.1, delta=0.05)
        self.assertEqual(len(summary["levelup_gaps_s"]), 1)
        self.assertAlmostEqual(summary["levelup_gaps_s"][0], 20.0, delta=0.5)

    def test_reroll(self):
        events = [
            mk(0, type="start"),
            mod(10, "offer", level=2, cards=[
                {"id": "a", "name": "CardA", "cat": "gun", "rank": 1, "desc": "", "evo": ""},
            ]),
            mk(11, type="answer", v=10),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["levelups"][0]["picked"], "reroll")


class TestCampaign(unittest.TestCase):
    def test_no_hud_gives_campaign_extras(self):
        events = [
            mk(0, type="start"),
            tel(1, 0, hp=100, pos=[0, 0, 0], weapon=2, ammo=[0, 0, 5, 0, 0, 0]),
            tel(2, 1, hp=100, pos=[10, 0, 0], weapon=2, ammo=[0, 0, 0, 0, 0, 0]),
            tel(3, 2, hp=100, pos=[20, 0, 0], weapon=5, ammo=[0, 0, 3, 0, 0, 0]),
            state_ev(1, play=1),
            state_ev(2, play=1),
            state_ev(3, play=1),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["mode"], "campaign")
        self.assertEqual(summary["levelups"], [])
        self.assertEqual(summary["kills_per_min"], [])
        self.assertIn("distance_per_min", summary)
        self.assertGreater(summary["distance_per_min"], 0)
        self.assertEqual(summary["weapon_switches"], 1)
        # ammo slot of weapon 5 went 3 -> 0
        self.assertEqual(summary["ammo_out_events"], 1)


class TestUnknownTypes(unittest.TestCase):
    def test_unknown_events_ignored(self):
        events = [
            mk(0, type="start"),
            mk(1, type="quantum_flux"),
            mk(2, type="totally_new_thing", foo="bar"),
            hud(3, 0, kills=3),
            tel(3, 0, hp=100),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["mode"], "survivors")
        self.assertEqual(sum(summary["kills_per_min"]), 3)
        self.assertEqual(summary["duration_s"], 3.0)


class TestLoadAndWrite(unittest.TestCase):
    def test_load_roundtrip_and_write(self):
        with tempfile.TemporaryDirectory() as td:
            sess = os.path.join(td, "sess1")
            os.makedirs(sess)
            events = [
                mk(0, type="start"),
                hud(1, 0, kills=2),
                tel(1, 0, hp=100),
                state_ev(1, play=1, perf={"frames": 60, "p50": 1.0, "max": 2.0}),
                input_ev(1, keys=2, clicks=1),
            ]
            with open(os.path.join(sess, "telemetry.jsonl"), "w") as f:
                for e in events:
                    f.write(json.dumps(e) + "\n")
            with open(os.path.join(sess, "meta.json"), "w") as f:
                json.dump({"session": "sess1", "options": {"mode": "survivors"}}, f)
            with open(os.path.join(sess, "survey.json"), "w") as f:
                json.dump({"why": "x", "at": 5, "answers": {"fun": "4", "other": "bot"}}, f)

            evs, meta, survey = report.load(sess)
            self.assertEqual(len(evs), 5)
            self.assertEqual(meta["session"], "sess1")
            self.assertEqual(survey["answers"]["fun"], "4")

            out = os.path.join(td, "out")
            summary = report.process_session(sess, out)
            self.assertIsNotNone(summary)
            self.assertTrue(summary["bot"])
            for name in ("summary.json", "report.md", "timeline.png"):
                p = os.path.join(out, "sess1", name)
                self.assertTrue(os.path.isfile(p) and os.path.getsize(p) > 0, name)

            # compare.md with two sessions (via main)
            sess2 = os.path.join(td, "sess2")
            os.makedirs(sess2)
            with open(os.path.join(sess2, "telemetry.jsonl"), "w") as f:
                for e in events:
                    f.write(json.dumps(e) + "\n")
            with open(os.path.join(sess2, "meta.json"), "w") as f:
                json.dump({"session": "sess2"}, f)
            rc = report.main([sess, sess2, "--out", out])
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.isfile(os.path.join(out, "compare.md")))


class TestDeaths(unittest.TestCase):
    def test_hp_to_null_is_death(self):
        events = [
            mk(0, type="start"),
            tel(1, 0, hp=100),
            tel(2, 1, hp=7),
            tel(3, 2, hp=None),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertEqual(summary["deaths"], [3.0])

    def test_end_victory_false_is_death(self):
        events = [
            mk(0, type="start"),
            tel(1, 0, hp=100),
            mod(5, "end", victory=False, time=5, level=1, kills=1, score=0, gold=0),
        ]
        summary, _ = report.analyse(events, {}, None)
        self.assertIn(5.0, summary["deaths"])
        self.assertEqual(summary["result"]["victory"], False)


if __name__ == "__main__":
    unittest.main()
