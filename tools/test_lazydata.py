#!/usr/bin/env python3
"""Tests for tools/lazydata.py. Run: python3 tools/test_lazydata.py"""

import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lazydata  # noqa: E402

T = 100  # threshold in bytes


def make(data, rel, size, content=None, mtime=None):
    p = os.path.join(data, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(content if content is not None else os.urandom(size))
    if mtime is not None:
        os.utime(p, ns=(mtime, mtime))
    return p


def snap(data):
    out = {}
    for root, dirs, files in os.walk(data):
        for n in files:
            p = os.path.join(root, n)
            st = os.lstat(p)
            out[os.path.relpath(p, data)] = (st.st_size, st.st_mtime_ns)
    return out


class LazydataTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = os.path.join(self.tmp.name, "data")
        self.out = os.path.join(self.tmp.name, "out")
        os.makedirs(self.data)

    def stage(self, threshold=T):
        return lazydata.stage(self.data, self.out, threshold)

    def test_classification(self):
        make(self.data, "big.gro", 200)
        make(self.data, "small.txt", 10)
        make(self.data, "Nav/big.nav", 200)
        make(self.data, "se1mod/big.mod", 200)
        res = self.stage()
        lazy = {rel for rel, _, _ in res["lazy"]}
        boot = set(res["boot"])
        self.assertEqual(lazy, {"big.gro"})
        self.assertEqual(boot, {"small.txt", "Nav/big.nav", "se1mod/big.mod"})

    def test_placeholder(self):
        mtime = 1_700_000_000 * 10**9
        make(self.data, "big.gro", 200, mtime=mtime)
        self.stage()
        ph = os.path.join(self.out, "data-boot", "big.gro")
        st = os.stat(ph)
        self.assertEqual(st.st_size, 0)
        self.assertEqual(st.st_mtime_ns, mtime)

    def test_hard_links(self):
        make(self.data, "big.gro", 200)
        make(self.data, "small.txt", 10)
        self.stage()
        for d, rel in (("data-boot", "small.txt"), ("gamedata", "big.gro")):
            src = os.path.join(self.data, rel)
            dst = os.path.join(self.out, d, rel)
            self.assertEqual(os.stat(src).st_ino, os.stat(dst).st_ino, (d, rel))

    def test_manifest_format(self):
        p1 = make(self.data, "a b.gro", 200)
        p2 = make(self.data, "zz.gro", 300)
        res = self.stage()
        for mpath in (os.path.join(self.out, "data-boot", "SE1Lazy", "manifest.txt"),
                      os.path.join(self.out, "gamedata", "manifest.txt")):
            with open(mpath) as f:
                text = f.read()
            self.assertTrue(text.endswith("\n"))
            lines = text.split("\n")
            self.assertEqual(lines[0], "dataset " + res["dataset"])
            rows = [l for l in lines[1:] if l]
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0].split(" ", 2)[2], "a b.gro")
            self.assertEqual(rows[1].split(" ", 2)[2], "zz.gro")
            for row, (rel, size, key) in zip(rows, res["lazy"]):
                parts = row.split(" ", 2)
                self.assertEqual(parts[1], str(size))
                self.assertEqual(parts[2], rel)
                st = os.stat(os.path.join(self.data, rel))
                expect = hashlib.sha1(
                    f"{rel}\0{size}\0{st.st_mtime_ns}".encode()
                ).hexdigest()[:16]
                self.assertEqual(parts[0], expect)
                self.assertEqual(key, expect)
            joined = "\n".join(rows)
            self.assertEqual(
                hashlib.sha1(joined.encode()).hexdigest()[:16], res["dataset"]
            )

    def test_idempotent_rerun(self):
        make(self.data, "big.gro", 200)
        make(self.data, "small.txt", 10)
        self.stage()
        ino = {
            os.path.join(self.out, d, rel): os.stat(os.path.join(self.out, d, rel)).st_ino
            for d, rel in (("data-boot", "small.txt"), ("gamedata", "big.gro"))
        }
        man = os.path.join(self.out, "gamedata", "manifest.txt")
        man_st = os.stat(man)
        self.stage()
        for p, i in ino.items():
            self.assertEqual(os.stat(p).st_ino, i)
        man_st2 = os.stat(man)
        self.assertEqual((man_st.st_mtime_ns, man_st.st_size),
                         (man_st2.st_mtime_ns, man_st2.st_size))

    def test_stale_removal(self):
        make(self.data, "gone.gro", 200)
        p = make(self.data, "shrink.gro", 200)
        make(self.data, "keep.gro", 200)
        self.stage()
        os.remove(os.path.join(self.data, "gone.gro"))
        with open(p, "wb") as f:
            f.write(b"x" * 10)  # now below threshold -> boot
        self.stage()
        self.assertFalse(os.path.exists(os.path.join(self.out, "gamedata", "gone.gro")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "data-boot", "gone.gro")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "gamedata", "shrink.gro")))
        self.assertTrue(os.path.exists(os.path.join(self.out, "data-boot", "shrink.gro")))
        self.assertEqual(
            os.stat(os.path.join(self.out, "data-boot", "shrink.gro")).st_size, 10
        )
        self.assertTrue(os.path.exists(os.path.join(self.out, "gamedata", "keep.gro")))
        man = os.path.join(self.out, "gamedata", "manifest.txt")
        with open(man) as f:
            rows = [l for l in f.read().split("\n") if l and not l.startswith("dataset")]
        self.assertEqual(len(rows), 1)
        self.assertIn("keep.gro", rows[0])

    def test_source_untouched(self):
        make(self.data, "big.gro", 200)
        make(self.data, "small.txt", 10)
        before = snap(self.data)
        self.stage()
        self.stage()
        self.assertEqual(before, snap(self.data))


if __name__ == "__main__":
    unittest.main()
