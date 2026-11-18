#!/usr/bin/env python3
"""Compare two visual-regression capture sets (tools/bench.mjs --shots <label>).

  tools/shotdiff.py <ref-label> <new-label> [--shots-dir data/shots]
                    [--max-mean 1.5] [--max-changed 1.0] [--pixel-threshold 24]

Per frame: mean absolute RGB difference (0..255), and the share of pixels whose largest channel
difference exceeds --pixel-threshold. A frame fails when mean > --max-mean or changed% >
--max-changed. Same-build runs measure <= 0.6 mean / 0.3% (flare fade). Heat maps of failing (and all, with --all-heatmaps) frames go to
<shots-dir>/diff_<ref>_vs_<new>/. Exit code 1 if any frame fails or is missing.

Captures are game frames made from the user's own game data: they stay local (data/ is ignored).
"""
import argparse
import os
import sys

from PIL import Image, ImageChops, ImageStat


def load(path):
    name = os.path.basename(path)
    w, h = map(int, name.rsplit("_", 1)[1][:-5].split("x"))
    with open(path, "rb") as f:
        return Image.frombytes("RGBA", (w, h), f.read()).convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("new")
    ap.add_argument("--shots-dir", default="data/shots")
    ap.add_argument("--max-mean", type=float, default=1.5)
    ap.add_argument("--max-changed", type=float, default=1.0, help="percent of pixels")
    ap.add_argument("--pixel-threshold", type=int, default=24)
    ap.add_argument("--all-heatmaps", action="store_true")
    a = ap.parse_args()

    rdir, ndir = os.path.join(a.shots_dir, a.ref), os.path.join(a.shots_dir, a.new)
    out = os.path.join(a.shots_dir, f"diff_{a.ref}_vs_{a.new}")
    refs = sorted(f for f in os.listdir(rdir) if f.endswith(".rgba"))
    if not refs:
        print(f"no reference frames in {rdir}")
        return 1
    failed = 0
    print(f"{'frame':28} {'mean':>6} {'changed%':>9}  result")
    for f in refs:
        npath = os.path.join(ndir, f)
        if not os.path.exists(npath):
            print(f"{f:28} {'-':>6} {'-':>9}  MISSING")
            failed += 1
            continue
        r, n = load(os.path.join(rdir, f)), load(npath)
        d = ImageChops.difference(r, n)
        mean = sum(ImageStat.Stat(d).mean) / 3.0
        # per-pixel max channel difference above threshold -> 255, combined over channels
        mask = None
        for ch in d.split():
            m = ch.point(lambda v: 255 if v > a.pixel_threshold else 0)
            mask = m if mask is None else ImageChops.lighter(mask, m)
        changed = 100.0 * mask.histogram()[255] / (d.width * d.height)
        bad = mean > a.max_mean or changed > a.max_changed
        failed += bad
        print(f"{f:28} {mean:6.2f} {changed:9.3f}  {'FAIL' if bad else 'ok'}")
        if bad or a.all_heatmaps:
            os.makedirs(out, exist_ok=True)
            # amplified difference, upright (captures are bottom-up)
            heat = d.point(lambda v: min(255, v * 8)).transpose(Image.FLIP_TOP_BOTTOM)
            heat.save(os.path.join(out, f[:-5] + "_diff.png"))
    print(f"{len(refs) - failed}/{len(refs)} frames ok" + (f"; heat maps in {out}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
