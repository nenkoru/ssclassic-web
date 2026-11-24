#!/usr/bin/env python3
"""Freeze a build's served files for perf comparisons (tools/perfbench.mjs) and serve them.

    tools/perfsnap.py <build dir> <name> [--port N]

Copies serioussam.{html,js,wasm,data}, coi-sw.js and gamedata/ to data/perf/<name>/ (replacing an
older snapshot of that name); with --port it also starts tools/devserver.py on it in the background
(log in data/perf/<name>.log) and prints the URL. A snapshot keeps a baseline still while the
build dir moves on.
"""
import argparse, os, shutil, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("build"); ap.add_argument("name"); ap.add_argument("--port", type=int)
    a = ap.parse_args()
    src = os.path.join(ROOT, a.build) if not os.path.isabs(a.build) else a.build
    dst = os.path.join(ROOT, "data", "perf", a.name)
    if not os.path.isfile(os.path.join(src, "serioussam.wasm")):
        print(f"perfsnap: {src} has no serioussam.wasm", file=sys.stderr); return 2
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    for f in ("serioussam.html", "serioussam.js", "serioussam.wasm", "serioussam.data", "coi-sw.js"):
        if os.path.isfile(os.path.join(src, f)):
            shutil.copy2(os.path.join(src, f), dst)
    if os.path.isdir(os.path.join(src, "gamedata")):
        shutil.copytree(os.path.join(src, "gamedata"), os.path.join(dst, "gamedata"))
    print(f"perfsnap: {a.build} -> data/perf/{a.name}")
    if a.port:
        log = open(os.path.join(ROOT, "data", "perf", a.name + ".log"), "w")
        subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "devserver.py"), "--port", str(a.port), dst],
                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        url = f"http://127.0.0.1:{a.port}/serioussam.html"
        for _ in range(50):
            try:
                urllib.request.urlopen(url, timeout=1); break
            except Exception:
                time.sleep(0.2)
        print(f"{a.name}={url}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
