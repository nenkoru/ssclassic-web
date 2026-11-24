#!/usr/bin/env python3
"""Stage the data folder of a user-data build: no game data, only what the repo ships.

The same layout as tools/make_full_data.sh steps 1 and 3, without the retail files:
  src/<game>: Controls Data Demos Help Mods Players Scripts VirtualTrees SE1_10b.gro ModEXT.txt
  + empty Levels SaveGame Temp Bin
  + port/data (mod-layer config, capture/bench scripts)
Files are hard links (copies across devices); files that are no longer in the sources are removed,
so the folder can be staged again on every link. The player's own files are added in the browser
(port/web/userdata.js, notes/user-data.md).

    tools/basedata.py --game SamTFE --out <dir>
"""

import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ITEMS = ("Controls", "Data", "Demos", "Help", "Mods", "Players", "Scripts", "VirtualTrees",
              "SE1_10b.gro", "ModEXT.txt")
EMPTY_DIRS = ("Levels", "SaveGame", "Temp", "Bin")


def _walk(src, rel=""):
    """(relpath, abspath) of every file under src (a file or a folder)."""
    if os.path.isfile(src):
        yield rel or os.path.basename(src), src
        return
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            if name == ".DS_Store":
                continue
            p = os.path.join(root, name)
            yield os.path.join(rel, os.path.relpath(p, src)).replace(os.sep, "/"), p


def stage(game, out):
    repo = os.path.join(ROOT, "src", game)
    want = {}
    for item in REPO_ITEMS:
        p = os.path.join(repo, item)
        if os.path.exists(p):
            for rel, src in _walk(p, item if os.path.isdir(p) else ""):
                want[rel] = src
    for rel, src in _walk(os.path.join(ROOT, "port", "data")):
        want[rel] = src   # the port's files on top, as make_full_data.sh copies them last

    os.makedirs(out, exist_ok=True)
    for d in EMPTY_DIRS:
        os.makedirs(os.path.join(out, d), exist_ok=True)
    for rel, src in want.items():
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        st = os.stat(src)
        if os.path.isfile(dst):
            dt = os.stat(dst)
            if (dt.st_ino == st.st_ino and dt.st_dev == st.st_dev) or \
               (dt.st_size == st.st_size and dt.st_mtime_ns == st.st_mtime_ns):
                continue
            os.remove(dst)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    # stale files
    for root, dirs, files in os.walk(out, topdown=False):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), out).replace(os.sep, "/")
            if rel not in want:
                os.remove(os.path.join(root, name))
    return want


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--game", default="SamTFE")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if not os.path.isdir(os.path.join(ROOT, "src", a.game)):
        print(f"basedata: no src/{a.game}", file=sys.stderr)
        return 2
    want = stage(a.game, a.out)
    size = sum(os.path.getsize(p) for p in want.values())
    print(f"basedata: {len(want)} files ({size / 1e6:.1f} MB) -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
