#!/usr/bin/env python3
"""Static dev server for the wasm build.

Adds the headers plain `python -m http.server` can't:
  Document-Policy: js-profiling   -> enables the JS Self-Profiling API (wasm frame sampling)
  COOP/COEP (default; --no-isolate turns them off) -> SharedArrayBuffer for the threaded build
and accepts visual-regression frames:
  POST /__shots/<label>/<name>_<W>x<H>.rgba  -> data/shots/<label>/<name>_<W>x<H>.rgba (+ .png)
  (bottom-up RGBA from glReadPixels; PNG written flipped upright when Pillow is available)
Usage: tools/devserver.py [--port 8090] [--no-isolate] [--shots-dir data/shots] <dir>
"""
import argparse
import functools
import http.server
import os
import re
import urllib.parse


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = True
    shots_dir = "data/shots"

    def end_headers(self):
        self.send_header("Document-Policy", "js-profiling")
        self.send_header("Cache-Control", "no-store")
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_POST(self):
        m = re.fullmatch(r"/__shots/([A-Za-z0-9_.-]+)/(t\d+_(\d+)x(\d+)\.rgba)", urllib.parse.unquote(self.path))
        if not m:
            self.send_error(404)
            return
        label, name, w, h = m.group(1), m.group(2), int(m.group(3)), int(m.group(4))
        n = int(self.headers.get("Content-Length", 0))
        if n != w * h * 4 or n > 64 << 20:
            self.send_error(400, "size mismatch")
            return
        data = self.rfile.read(n)
        out = os.path.join(self.shots_dir, label)
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        try:
            from PIL import Image
            Image.frombytes("RGBA", (w, h), data).transpose(Image.FLIP_TOP_BOTTOM).save(
                os.path.join(out, name[:-5] + ".png"))
        except ImportError:
            pass
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--isolate", action="store_true", help="(default; kept for old command lines)")
    ap.add_argument("--no-isolate", action="store_true", help="no COOP/COEP (e.g. to test coi-sw.js)")
    ap.add_argument("--shots-dir", default="data/shots")
    a = ap.parse_args()
    Handler.isolate = not a.no_isolate
    Handler.shots_dir = os.path.abspath(a.shots_dir)
    h = functools.partial(Handler, directory=a.dir)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), h).serve_forever()


if __name__ == "__main__":
    main()
