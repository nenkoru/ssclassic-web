#!/usr/bin/env python3
"""Delete the temporary folders the browser tests leave behind (Chrome profiles, captures, bundles).

Every headless test starts Chrome with a fresh --user-data-dir in the system temp folder (about
350 MB each once the game has run) and most never delete it, so the temp folder grows by gigabytes
a day. This removes, directly inside the temp folder only:
  - folders whose name starts with one of PREFIXES,
  - that have not changed for --min-age minutes (default 30),
  - and that no running process uses as its Chrome --user-data-dir.

  tools/cleantmp.py [--min-age MINUTES] [--dry-run]
"""
import argparse
import os
import shutil
import subprocess
import tempfile
import time

PREFIXES = ("se1", "tmp.", "gpp-")


def in_use():
    out = subprocess.run(["ps", "-Ao", "command"], capture_output=True, text=True).stdout
    dirs = set()
    for word in out.split():
        if word.startswith("--user-data-dir="):
            dirs.add(os.path.realpath(word.split("=", 1)[1]))
    return dirs


def newest_mtime(path):
    newest = os.lstat(path).st_mtime
    for root, subdirs, files in os.walk(path):
        for name in subdirs + files:
            try:
                newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
            except OSError:
                pass
    return newest


def size_of(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-age", type=float, default=30, help="minutes without changes (default 30)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    tmp = os.path.realpath(tempfile.gettempdir())
    busy = in_use()
    cutoff = time.time() - a.min_age * 60
    removed = freed = kept = 0
    for name in sorted(os.listdir(tmp)):
        path = os.path.join(tmp, name)
        if not name.startswith(PREFIXES) or os.path.islink(path) or not os.path.isdir(path):
            continue
        real = os.path.realpath(path)
        if os.path.dirname(real) != tmp or any(b == real or b.startswith(real + os.sep) for b in busy):
            kept += 1
            continue
        if newest_mtime(path) > cutoff:
            kept += 1
            continue
        size = size_of(path)
        if not a.dry_run:
            shutil.rmtree(path, ignore_errors=True)
        removed += 1
        freed += size
    verb = "would remove" if a.dry_run else "removed"
    print(f"cleantmp: {verb} {removed} folders ({freed / 2**30:.1f} GB) in {tmp}; kept {kept} (in use or recent)")


if __name__ == "__main__":
    main()
