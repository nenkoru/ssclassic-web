#!/usr/bin/env python3
"""Tests for tools/devserver.py HTTP Range support."""
import functools
import http.server
import os
import random
import socket
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import devserver

SIZE = 3_000_000

# talk to the local server directly, not through a system or env HTTP proxy
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class RangeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.root = Path(cls.data.name)
        cls.blob = random.randbytes(SIZE)
        (cls.root / "big.bin").write_bytes(cls.blob)
        cls.port = free_port()
        cls.handler_cls = type("TestHandler", (devserver.Handler,), {
            "shots_dir": str(cls.root / "shots"),
            "playtests_dir": str(cls.root / "playtests"),
        })
        handler = functools.partial(cls.handler_cls, directory=str(cls.root))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", cls.port), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.data.cleanup()

    def get(self, range_header=None):
        req = urllib.request.Request(self.base + "/big.bin")
        if range_header is not None:
            req.add_header("Range", range_header)
        try:
            return _OPENER.open(req)
        except urllib.error.HTTPError as e:
            return e

    def test_full_get(self):
        r = self.get()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers.get("Accept-Ranges"), "bytes")
        self.assertEqual(len(r.read()), SIZE)

    def test_range_0_99(self):
        r = self.get("bytes=0-99")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes 0-99/{SIZE}")
        self.assertEqual(r.read(), self.blob[:100])

    def test_range_mib(self):
        r = self.get("bytes=1048576-2097151")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes 1048576-2097151/{SIZE}")
        self.assertEqual(r.read(), self.blob[1048576:2097152])

    def test_range_open_end(self):
        r = self.get("bytes=2999990-")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes 2999990-{SIZE - 1}/{SIZE}")
        self.assertEqual(r.read(), self.blob[2999990:])

    def test_range_suffix(self):
        r = self.get("bytes=-5")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes {SIZE - 5}-{SIZE - 1}/{SIZE}")
        self.assertEqual(r.read(), self.blob[-5:])

    def test_range_clamped(self):
        r = self.get("bytes=2999999-5000000")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes 2999999-{SIZE - 1}/{SIZE}")
        self.assertEqual(r.read(), self.blob[2999999:])

    def test_range_unsatisfiable(self):
        r = self.get("bytes=3000000-3000010")
        self.assertEqual(r.status, 416)
        self.assertEqual(r.headers.get("Content-Range"), f"bytes */{SIZE}")
        self.assertEqual(r.read(), b"")

    def test_multi_range_ignored(self):
        r = self.get("bytes=0-99,100-199")
        self.assertEqual(r.status, 200)
        self.assertEqual(len(r.read()), SIZE)

    def test_non_bytes_unit_ignored(self):
        r = self.get("items=0-99")
        self.assertEqual(r.status, 200)
        self.assertEqual(len(r.read()), SIZE)

    def test_coop_on_206(self):
        r = self.get("bytes=0-99")
        self.assertEqual(r.status, 206)
        self.assertEqual(r.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
        self.assertEqual(r.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
        self.assertEqual(r.headers.get("Document-Policy"), "js-profiling")
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")


if __name__ == "__main__":
    unittest.main()
