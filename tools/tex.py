#!/usr/bin/env python3
"""Serious Engine 1 texture (.tex) codec.

The format is defined by CTextureData::Read_t / Write_t in
src/SamTFE/Sources/Engine/Graphics/Texture.cpp. A file is:

  "TVER" int32 version (3 or 4)
  then chunks until EOF, each a 4-byte id:
    TDAT  uint32 flags, int32 mexWidth, mexHeight, ctFineMips,
          [v3: int32 ctMipLevels], int32 firstMipLevel, [v3: int32 frameSize], int32 ctFrames
    FRMS  frames. v4: only the finest mip of each frame, RGBA8 if flags&ALPHACHANNEL else RGB8
          (the engine builds the mip chain at load time). v3: the whole mip chain, RGBA8.
    FXDT  effect texture (water/fire): uint32 effect type, [v4: int32 bufW, bufH],
          [v3: 64 bytes skipped], int32 ctSources, per source: uint32 type, 64 bytes props,
          int32 ctPixels, ctPixels*8 bytes
    FXB2  saved effect buffers: 2 * bufW*bufH bytes (water: 2 * bufW*(bufH+2)*2 bytes)
    FXBF  old effect buffers (skipped by the engine)
    ANIM  "ADAT" int32 ctAnims, per anim: char[32] name, float secsPerFrame,
          int32 ctFrames, ctFrames*int32 indices
    BAST  base texture filename for an effect: "DFNM" int32 len + chars
    DTLT  detail texture filename (ignored by the engine): "DFNM" int32 len + chars

Pixel size = mex size >> firstMipLevel. The mex size is what the world and the models map
against, so an HD texture keeps mexWidth/mexHeight and lowers firstMipLevel instead.

`TexFile.parse` keeps every chunk; `TexFile.build` writes them back in the same order, so a
parse/build round trip is byte-identical. `with_frames` swaps in new pixels (and a new first
mip level) and always writes version 4 frames (finest mip only), the way the engine's own
Write_t does.
"""
import io
import struct
import zipfile

import numpy as np

TEX_ALPHACHANNEL = 1 << 0
TEX_32BIT = 1 << 1
WATER_EFFECTS = {0, 1, 2, 3}  # _ategtTextureEffectGlobalPresets entries that use InitializeWater


class TexError(Exception):
    pass


def mip_offset(levels, w, h):
    """Texels in the first `levels` mips of a w x h chain (engine GetMipmapOffset)."""
    n = 0
    for _ in range(levels):
        n += w * h
        if w == 1 and h == 1:
            break
        w, h = max(1, w >> 1), max(1, h >> 1)
    return n


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def take(self, n):
        if self.p + n > len(self.d):
            raise TexError(f"truncated at {self.p} (+{n} of {len(self.d)})")
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def i32(self):
        return struct.unpack("<i", self.take(4))[0]

    def u32(self):
        return struct.unpack("<I", self.take(4))[0]

    def f32(self):
        return struct.unpack("<f", self.take(4))[0]

    def cid(self):
        return self.take(4).decode("latin-1")

    def fname(self):
        tag = self.cid()
        if tag != "DFNM":
            raise TexError(f"expected DFNM, got {tag!r}")
        n = self.i32()
        return self.take(n).decode("latin-1")

    def eof(self):
        return self.p >= len(self.d)


class TexFile:
    """A parsed .tex. `chunks` is a list of (id, raw bytes after the id) in file order."""

    def __init__(self):
        self.version = 4
        self.chunks = []
        self.flags = 0
        self.mex_w = self.mex_h = 0
        self.fine_mips = 0
        self.mip_levels = None  # v3 only
        self.first_mip = 0
        self.frame_size = None  # v3 only (bytes, whole mip chain)
        self.ct_frames = 0
        self.frames_raw = None  # bytes of FRMS
        self.effect = None  # dict for FXDT
        self.anims = []
        self.base_texture = None
        self.detail_texture = None

    # ---- derived
    @property
    def pix_w(self):
        return self.mex_w >> self.first_mip

    @property
    def pix_h(self):
        return self.mex_h >> self.first_mip

    @property
    def has_alpha(self):
        return bool(self.flags & TEX_ALPHACHANNEL)

    @property
    def is_effect(self):
        return self.effect is not None

    @property
    def is_animated(self):
        return self.ct_frames > 1

    # ---- parsing
    @classmethod
    def parse(cls, data):
        t = cls()
        r = Reader(data)
        if r.cid() != "TVER":
            raise TexError("no TVER")
        t.version = r.i32()
        if t.version not in (3, 4):
            raise TexError(f"version {t.version}")
        while not r.eof():
            cid = r.cid()
            start = r.p
            if cid == "    ":
                t.chunks.append((cid, r.d[start:]))
                break
            if cid == "TDAT":
                t.flags = r.u32()
                t.mex_w, t.mex_h, t.fine_mips = r.i32(), r.i32(), r.i32()
                if t.version != 4:
                    t.mip_levels = r.i32()
                t.first_mip = r.i32()
                if t.version != 4:
                    t.frame_size = r.i32()
                t.ct_frames = r.i32()
            elif cid == "FRMS":
                r.take(t._frms_size())
                t.frames_raw = r.d[start:r.p]
            elif cid == "ANIM":
                if r.cid() != "ADAT":
                    raise TexError("ANIM without ADAT")
                for _ in range(r.i32()):
                    name = r.take(32).split(b"\0")[0].decode("latin-1")
                    spf = r.f32()
                    n = r.i32()
                    t.anims.append((name, spf, list(struct.unpack(f"<{n}i", r.take(4 * n)))))
            elif cid == "BAST":
                t.base_texture = r.fname()
            elif cid == "DTLT":
                t.detail_texture = r.fname()
            elif cid == "FXDT":
                e = {"type": r.u32()}
                if t.version == 4:
                    e["buf_w"], e["buf_h"] = r.i32(), r.i32()
                else:
                    r.take(64)
                srcs = []
                for _ in range(r.i32()):
                    st = r.u32()
                    r.take(64)
                    r.take(8 * r.i32())
                    srcs.append(st)
                e["sources"] = srcs
                t.effect = e
            elif cid == "FXB2":
                e = t.effect
                if e is None or "buf_w" not in e:
                    raise TexError("FXB2 before FXDT")
                n = e["buf_w"] * e["buf_h"]
                if e["type"] in WATER_EFFECTS:
                    n = e["buf_w"] * (e["buf_h"] + 2) * 2
                r.take(2 * n)
            elif cid == "FXBF":
                # old effect buffers, skipped by the engine (sizes as in its Read_t)
                if t.version != 4:
                    r.take(2 * t.pix_w * t.pix_h * 2)
                else:
                    e = t.effect
                    n = e["buf_w"] * e["buf_h"]
                    if e["type"] in WATER_EFFECTS:
                        n = e["buf_w"] * (e["buf_h"] + 2) * 2 * 2
                    r.take(2 * n)
            else:
                raise TexError(f"unknown chunk {cid!r} at {start - 4}")
            t.chunks.append((cid, r.d[start:r.p]))
        return t

    def _frms_size(self):
        if self.version == 3:
            return self.frame_size * self.ct_frames
        bpp = 4 if self.has_alpha else 3
        return self.pix_w * self.pix_h * bpp * self.ct_frames

    # ---- pixels
    def frames(self):
        """Finest mip of every frame as uint8 arrays (ct, h, w, 4), RGBA. Opaque files get A=255."""
        if self.frames_raw is None:
            return None
        w, h, n = self.pix_w, self.pix_h, self.ct_frames
        buf = np.frombuffer(self.frames_raw, np.uint8)
        if self.version == 3:
            # v3: whole mip chains of 16-bit texels, RGBA4444 with alpha, RGB555(1) without;
            # unpacked the way the engine's Convert() does
            per = self.frame_size // 2
            uw = np.frombuffer(self.frames_raw, "<u2")
            px = np.stack([uw[i * per:i * per + w * h].reshape(h, w) for i in range(n)]).astype(np.uint16)
            out = np.empty((n, h, w, 4), np.uint8)
            if self.has_alpha:
                for c, sh in enumerate((12, 8, 4, 0)):
                    v = ((px >> sh) & 0xF).astype(np.uint8)
                    out[..., c] = (v << 4) | v
            else:
                r = ((px & 0xF800) >> 8).astype(np.uint8)
                g = ((px & 0x07C0) >> 3).astype(np.uint8)
                b = ((px & 0x003E) << 2).astype(np.uint8)
                out[..., 0], out[..., 1], out[..., 2] = r | (r >> 5), g | (g >> 5), b | (b >> 5)
                out[..., 3] = 255
            return out
        if self.has_alpha:
            return buf.reshape(n, h, w, 4).copy()
        rgb = buf.reshape(n, h, w, 3)
        out = np.empty((n, h, w, 4), np.uint8)
        out[..., :3] = rgb
        out[..., 3] = 255
        return out

    def with_frames(self, frames, first_mip, alpha=None):
        """A new v4 file with these frames (ct, h, w, 4) uint8 at first mip level `first_mip`.

        mexWidth/mexHeight stay, so world and model mapping are unchanged: the frame size must be
        mex >> first_mip. Chunks other than TDAT/FRMS are copied unchanged.
        """
        frames = np.ascontiguousarray(frames, np.uint8)
        n, h, w, _ = frames.shape
        if n != self.ct_frames:
            raise TexError("frame count differs")
        if (self.mex_w >> first_mip, self.mex_h >> first_mip) != (w, h) or first_mip < 0:
            raise TexError(f"{w}x{h} does not match mex {self.mex_w}x{self.mex_h} >> {first_mip}")
        if alpha is None:
            alpha = self.has_alpha
        flags = (self.flags & (TEX_ALPHACHANNEL | TEX_32BIT))
        flags = flags | TEX_ALPHACHANNEL if alpha else flags & ~TEX_ALPHACHANNEL
        # fine mips: the engine filters mips below this count; keep the same coarse cutoff
        # in absolute mex terms (fine_mips counts from the finest stored mip)
        fine = self.fine_mips + (self.first_mip - first_mip)
        tdat = struct.pack("<Iiiiii", flags, self.mex_w, self.mex_h, max(1, fine), first_mip, n)
        frms = (frames if alpha else frames[..., :3]).tobytes()
        out = []
        for cid, raw in self.chunks:
            if cid == "TDAT":
                out.append(("TDAT", tdat))
            elif cid == "FRMS":
                out.append(("FRMS", frms))
            else:
                out.append((cid, raw))
        t = TexFile()
        t.version = 4
        t.chunks = out
        return TexFile.parse(t.build())

    def build(self):
        b = io.BytesIO()
        b.write(b"TVER")
        b.write(struct.pack("<i", self.version))
        for cid, raw in self.chunks:
            b.write(cid.encode("latin-1"))
            b.write(raw)
        return b.getvalue()


def read_tex(path_or_bytes):
    if isinstance(path_or_bytes, (bytes, bytearray)):
        return TexFile.parse(bytes(path_or_bytes))
    with open(path_or_bytes, "rb") as f:
        return TexFile.parse(f.read())


def make_mips(rgba):
    """Engine-style box-filtered mip chain of one frame (h, w, 4) uint8, finest first.

    v4 files don't store mips (the engine's MakeMipmaps builds them at load time), so this is
    only for previews and for estimating memory.
    """
    mips = [rgba]
    cur = rgba.astype(np.uint16)
    while cur.shape[0] > 1 or cur.shape[1] > 1:
        h, w = cur.shape[:2]
        if h > 1:
            cur = (cur[0::2] + cur[1::2] + 1) >> 1
        if w > 1:
            cur = (cur[:, 0::2] + cur[:, 1::2] + 1) >> 1
        mips.append(cur.astype(np.uint8))
    return mips


# ---- archives

def gro_files(data_dir):
    """Retail archives in the engine's priority order: later entries override earlier ones.

    The engine (Base/Unzip.cpp, UNZIPAddArchive + qsort by name, later wins) sorts *.gro by
    name; see notes/hd-textures.md.
    """
    import glob
    import os
    return sorted(glob.glob(os.path.join(data_dir, "*.gro")), key=lambda p: os.path.basename(p).lower())


def iter_textures(data_dir, include_loose=True):
    """Yield (name, bytes, source) for every .tex the engine would see (later archives win)."""
    import os
    seen = {}
    for gro in gro_files(data_dir):
        with zipfile.ZipFile(gro) as z:
            for info in z.infolist():
                if info.filename.lower().endswith(".tex"):
                    seen[info.filename.replace("\\", "/").lower()] = (gro, info.filename)
    if include_loose:
        for root, _, files in os.walk(data_dir):
            for f in files:
                if f.lower().endswith(".tex"):
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, data_dir).replace("\\", "/")
                    seen.setdefault(rel.lower(), (None, full))
    zips = {}
    try:
        for key in sorted(seen):
            gro, name = seen[key]
            if gro is None:
                with open(name, "rb") as f:
                    yield os.path.relpath(name, data_dir).replace("\\", "/"), f.read(), "loose"
                continue
            z = zips.get(gro) or zips.setdefault(gro, zipfile.ZipFile(gro))
            yield name.replace("\\", "/"), z.read(name), os.path.basename(gro)
    finally:
        for z in zips.values():
            z.close()


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        t = read_tex(p)
        print(p, f"v{t.version}", f"{t.pix_w}x{t.pix_h}", f"mex {t.mex_w}x{t.mex_h}",
              f"first {t.first_mip}", f"frames {t.ct_frames}", "alpha" if t.has_alpha else "",
              "effect" if t.is_effect else "", t.base_texture or "", [c for c, _ in t.chunks])
