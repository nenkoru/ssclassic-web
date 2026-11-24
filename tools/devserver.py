#!/usr/bin/env python3
"""Static dev server for the wasm build.

Adds the headers plain `python -m http.server` can't:
  Document-Policy: js-profiling   -> enables the JS Self-Profiling API (wasm frame sampling)
  COOP/COEP (default; --no-isolate turns them off) -> SharedArrayBuffer for the threaded build
and accepts visual-regression frames:
  POST /__shots/<label>/<name>_<W>x<H>.rgba  -> data/shots/<label>/<name>_<W>x<H>.rgba (+ .png)
  (bottom-up RGBA from glReadPixels; PNG written flipped upright when Pillow is available)
and playtest recordings (port/web/playtest.js, ?rec=1):
  POST /__playtest/<session>/<file>[?append=1]  -> data/playtests/<session>/<file> (written or appended)
and single-range HTTP Range requests for regular files (the game fetches 1 MiB byte ranges):
  GET/HEAD with Range: bytes=A-B | bytes=A- | bytes=-N  -> 206 with Content-Range
Usage: tools/devserver.py [--port 8090] [--no-isolate] [--shots-dir data/shots] [--playtests-dir data/playtests] <dir>
"""
import argparse
import email.utils
import functools
import http.server
import os
import re
import urllib.parse


class _RangeFile:
    """File-like view limited to a byte range; read()s at most 1 MiB at a time."""

    def __init__(self, f, length):
        self._f = f
        self._remaining = length

    def read(self, size=-1):
        if self._remaining <= 0:
            return b""
        n = min(size, self._remaining) if size is not None and size >= 0 else self._remaining
        data = self._f.read(min(n, 1 << 20))
        self._remaining -= len(data)
        return data

    def close(self):
        self._f.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = True
    shots_dir = "data/shots"
    playtests_dir = "data/playtests"
    _range_re = re.compile(r"(\d*)-(\d*)")

    def end_headers(self):
        self.send_header("Document-Policy", "js-profiling")
        self.send_header("Cache-Control", "no-store")
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        if getattr(self, "_accept_ranges", False):
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        self._accept_ranges = os.path.isfile(path)
        m = re.fullmatch(r"bytes=([^,]+)", self.headers.get("Range", ""))
        if m and self._accept_ranges:
            try:
                size = os.path.getsize(path)
                spec = self._range_re.fullmatch(m.group(1))
                if spec:
                    a, b = spec.group(1), spec.group(2)
                    if not a and not b:
                        raise ValueError
                    if not a:
                        # suffix form: the last N bytes
                        start, end = max(size - int(b), 0), size - 1
                    else:
                        start = int(a)
                        end = size - 1 if not b else min(int(b), size - 1)
                    if start >= size or start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return None
                    f = open(path, "rb")
                    f.seek(start)
                    self.send_response(206)
                    self.send_header("Content-Type", self.guess_type(path))
                    self.send_header("Last-Modified",
                                     email.utils.formatdate(os.stat(path).st_mtime, usegmt=True))
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.end_headers()
                    return _RangeFile(f, end - start + 1)
            except (ValueError, OverflowError, OSError):
                pass
        return super().send_head()

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path.startswith("/__playtest/"):
            return self.playtest(url)
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

    def playtest(self, url):
        # one session folder per recording; names are restricted so nothing escapes the folder
        m = re.fullmatch(r"/__playtest/([A-Za-z0-9_-]{1,64})/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,63})", urllib.parse.unquote(url.path))
        n = int(self.headers.get("Content-Length", 0))
        if not m or ".." in m.group(2):
            self.send_error(404)
            return
        if n > 64 << 20:
            self.send_error(413, "chunk too big")
            return
        data = self.rfile.read(n)
        out = os.path.join(self.playtests_dir, m.group(1))
        os.makedirs(out, exist_ok=True)
        append = urllib.parse.parse_qs(url.query).get("append") == ["1"]
        with open(os.path.join(out, m.group(2)), "ab" if append else "wb") as f:
            f.write(data)
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
    ap.add_argument("--playtests-dir", default="data/playtests")
    a = ap.parse_args()
    Handler.isolate = not a.no_isolate
    Handler.shots_dir = os.path.abspath(a.shots_dir)
    Handler.playtests_dir = os.path.abspath(a.playtests_dir)
    h = functools.partial(Handler, directory=a.dir)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), h).serve_forever()


if __name__ == "__main__":
    main()
