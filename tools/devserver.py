#!/usr/bin/env python3
"""Static dev server for the wasm build.

Adds the headers plain `python -m http.server` can't:
  Document-Policy: js-profiling   -> enables the JS Self-Profiling API (wasm frame sampling)
  --isolate                       -> COOP/COEP for SharedArrayBuffer (threads builds)
Usage: tools/devserver.py [--port 8090] [--isolate] <dir>
"""
import argparse
import functools
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = False

    def end_headers(self):
        self.send_header("Document-Policy", "js-profiling")
        self.send_header("Cache-Control", "no-store")
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--isolate", action="store_true")
    a = ap.parse_args()
    Handler.isolate = a.isolate
    h = functools.partial(Handler, directory=a.dir)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), h).serve_forever()


if __name__ == "__main__":
    main()
