#!/usr/bin/env python3
"""Round-trip test for tools/tex.py over every .tex in a retail data folder.

  python3 tools/test_tex.py [data dir]     (default data/tfe-full-web; skipped if missing)

For each texture the engine would load (later .gro archives override earlier ones):
  1. parse -> build must give back the same bytes (byte-identical round trip);
  2. frames -> with_frames (same pixels, same first mip) -> frames must give the same pixels and
     an identical TDAT/FRMS for v4 files (semantic round trip of the pixel path, which is the
     one hdtex.py uses to write HD textures);
  3. with_frames at a 2x size (first mip - 1) must parse and keep the mex size.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tex import TexFile, iter_textures  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    data = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data/tfe-full-web")
    if not os.path.isdir(data):
        print(f"skip: no data folder {data}")
        return 0
    n = byte_ok = px_ok = up_ok = 0
    fails = []
    for name, raw, _ in iter_textures(data):
        n += 1
        try:
            t = TexFile.parse(raw)
            if t.build() != raw:
                raise AssertionError("bytes differ after parse/build")
            byte_ok += 1
            fr = t.frames()
            if fr is None:  # effect texture: no stored frames
                px_ok += 1
                up_ok += 1
                continue
            t2 = t.with_frames(fr, t.first_mip)
            if not np.array_equal(t2.frames(), fr):
                raise AssertionError("pixels differ after with_frames")
            if t.version == 4 and t2.build() != raw and dict(t2.chunks) != dict(t.chunks):
                raise AssertionError("v4 rewrite differs")
            px_ok += 1
            if t.first_mip >= 1:
                big = np.repeat(np.repeat(fr, 2, axis=1), 2, axis=2)
                t3 = t.with_frames(big, t.first_mip - 1)
                if (t3.mex_w, t3.mex_h, t3.pix_w, t3.pix_h) != (t.mex_w, t.mex_h, 2 * t.pix_w, 2 * t.pix_h):
                    raise AssertionError("2x rewrite changed the mex size")
            up_ok += 1
        except Exception as e:  # noqa: BLE001
            fails.append((name, repr(e)))
    print(f"{n} textures: byte-identical {byte_ok}, pixel round trip {px_ok}, 2x rewrite {up_ok}")
    for f in fails[:20]:
        print("FAIL", *f)
    return 1 if fails or n == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
