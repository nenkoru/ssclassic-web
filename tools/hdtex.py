#!/usr/bin/env python3
"""HD textures for the full build: AI-upscale the retail .tex files offline, pack an override archive.

See notes/hd-textures.md. Everything it makes lives under data/ (retail-derived: never commit it).

  python3 tools/hdtex.py inventory                 textures by category, pixel area, per-level budget
  python3 tools/hdtex.py samples                   the fixed comparison set as PNGs (data/hdtex/samples)
  data/hdtex/venv/bin/python tools/hdtex.py compare [--methods a,b,...]
                                                   run candidate methods on the samples, contact sheets
                                                   (data/hdtex/compare)
  data/hdtex/venv/bin/python tools/hdtex.py build [--only RE] [--limit N]
                                                   upscale world/model/sky textures (cached), write
                                                   data/hdtex/out/ZZ_HD_Textures.gro and ZZ_HD_Maps.gro
  python3 tools/hdtex.py mkdata                    data/tfe-hd-web: hard-link copy of data/tfe-full-web
                                                   + the HD archives + raised texture size cap

Common options: --data (retail data folder, default data/tfe-full-web), --work (default data/hdtex).
The data root defaults to <repo>/data; SE1_DATA_ROOT overrides it (worktrees have no data/).
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tex import TexFile, iter_textures  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ROOT = os.environ.get("SE1_DATA_ROOT", os.path.join(ROOT, "data"))
PIPELINE_VERSION = 1

# The archive must sort after every retail .gro: the engine reads archive directories in reverse
# name order (Base/Unzip.cpp, qsort_ArchiveCTFileName_reverse) and takes the first match, so the
# alphabetically last archive wins. "ZZ_" beats "SE1_10b.gro" and "1_*.gro".
ARCHIVE = "ZZ_HD_Textures.gro"
MAPS_ARCHIVE = "ZZ_HD_Maps.gro"

# ---------------------------------------------------------------- categories

UI_PREFIXES = ("fonts/", "textures/interface/", "texturesmp/interface/", "textures/computer/",
               "texturesmp/computer/", "textures/logo/", "textures/editor/", "models/editor/", "help/",
               "demos/", "mods/", "textures/general/pointer", "textures/general/grid")
FX_PREFIXES = ("textures/effects/", "models/effects/", "models/reflectiontextures/",
               "models/speculartextures/", "models/bumptextures/")
OTHER_PREFIXES = ("textures/test/", "models/ihvtest/")


def classify(name, t, bases):
    n = name.lower().replace("\\", "/")
    b = os.path.basename(n)
    if n.startswith(UI_PREFIXES) or b.endswith("tbn.tex"):
        return "ui"
    if t.is_effect or n in bases or t.ct_frames > 1 or n.startswith(FX_PREFIXES) or "flare" in b:
        return "effect"
    if n.startswith("textures/background/") or (n.startswith("textures/levels/") and re.search(r"/frame\d+\.tex$", n)):
        return "sky"
    if n.startswith(OTHER_PREFIXES):
        return "other"
    if n.startswith("models/"):
        return "model"
    if n.startswith(("textures/", "worlds/")):
        return "world"
    return "other"


def index(data):
    """[{name, raw, tex, cat}] for every texture the engine sees."""
    items = []
    for name, raw, src in iter_textures(data):
        items.append({"name": name, "raw": raw, "tex": TexFile.parse(raw), "src": src})
    bases = {i["tex"].base_texture.lower().replace("\\", "/") for i in items if i["tex"].base_texture}
    for i in items:
        i["cat"] = classify(i["name"], i["tex"], bases)
    return items


# ---------------------------------------------------------------- plan: what each category becomes

# target: scale relative to the retail size, capped by max dimension (power of two steps; the mex
# size never changes, so the scale is also capped by 2**first_mip).
PLAN = {
    "world": dict(scale=4, max_dim=1024, wrap=True),
    "model": dict(scale=4, max_dim=1024, wrap=False),
    "sky": dict(scale=2, max_dim=1024, wrap=False),
}
MIN_DIM = 16  # tiny gradients and dots gain nothing


def target_scale(t, cat, plan=PLAN):
    p = plan.get(cat)
    if not p or t.frames_raw is None or max(t.pix_w, t.pix_h) < MIN_DIM:
        return 1
    s = 1
    while (s * 2 <= p["scale"] and s * 2 <= (1 << t.first_mip)
           and max(t.pix_w, t.pix_h) * s * 2 <= p["max_dim"]):
        s *= 2
    return s


def tex_bytes(w, h):
    """RGBA8 with the full mip chain: what the engine keeps in the heap and uploads to the GPU."""
    return w * h * 4 * 4 // 3


# ---------------------------------------------------------------- levels

def level_textures(data, items):
    """{level: set(texture names)} from the filename dictionaries in the .wld files."""
    by_lower = {i["name"].lower(): i["name"] for i in items}
    out = {}
    lv = os.path.join(data, "Levels")
    for f in sorted(os.listdir(lv)) if os.path.isdir(lv) else []:
        if not f.lower().endswith(".wld"):
            continue
        with open(os.path.join(lv, f), "rb") as fh:
            raw = fh.read()
        names = set()
        for m in re.finditer(rb"[A-Za-z0-9_ \\/.\-]+?\.tex", raw, re.I):
            s = m.group(0).decode("latin-1").replace("\\", "/").strip().lower()
            # dictionary strings are length-prefixed; take the longest suffix that is a texture
            for k in range(len(s)):
                if s[k:] in by_lower:
                    names.add(by_lower[s[k:]])
                    break
        out[f[:-4]] = names
    return out


def cmd_inventory(a):
    items = index(a.data)
    cats = {}
    for i in items:
        t = i["tex"]
        c = cats.setdefault(i["cat"], dict(n=0, px=0, px_hd=0, alpha=0, frames=0))
        c["n"] += 1
        px = t.pix_w * t.pix_h * max(1, t.ct_frames) if t.frames_raw is not None else 0
        s = target_scale(t, i["cat"])
        c["px"] += px
        c["px_hd"] += px * s * s
        c["alpha"] += t.has_alpha
    print(f"{len(items)} textures in {a.data}\n")
    print(f"{'category':10} {'count':>6} {'alpha':>6} {'Mpx 1x':>8} {'Mpx plan':>9}")
    for k in ("world", "model", "sky", "effect", "ui", "other"):
        c = cats.get(k, dict(n=0, px=0, px_hd=0, alpha=0))
        print(f"{k:10} {c['n']:6} {c['alpha']:6} {c['px'] / 1e6:8.2f} {c['px_hd'] / 1e6:9.2f}")
    # per-level working set
    lv = level_textures(a.data, items)
    by_name = {i["name"]: i for i in items}
    common = [i for i in items if i["cat"] == "model" and i["name"].lower().startswith(("models/weapons/", "models/items/", "models/player/"))]
    print("\nper-level texture memory (RGBA8 + mips, MB; brush/model textures named in the .wld"
          " + weapons/items/player skins; enemy skins come from entity code and are not counted):")
    print(f"{'level':32} {'tex':>4} {'1x':>7} {'2x':>7} {'4x≤1024':>8} {'plan':>7}")
    rows = []
    for lvl, names in lv.items():
        sel = {by_name[n]["name"]: by_name[n] for n in names} | {i["name"]: i for i in common}
        b1 = b2 = b4 = bp = 0
        for i in sel.values():
            t = i["tex"]
            if t.frames_raw is None:
                continue
            w, h, n = t.pix_w, t.pix_h, max(1, t.ct_frames)
            up = i["cat"] in PLAN
            b1 += tex_bytes(w, h) * n
            s2 = min(2, 1 << t.first_mip) if up else 1
            s4 = 1
            while up and s4 < 4 and s4 * 2 <= (1 << t.first_mip) and max(w, h) * s4 * 2 <= 1024:
                s4 *= 2
            sp = target_scale(t, i["cat"])
            b2 += tex_bytes(w * s2, h * s2) * n
            b4 += tex_bytes(w * s4, h * s4) * n
            bp += tex_bytes(w * sp, h * sp) * n
        rows.append((lvl, len(sel), b1, b2, b4, bp))
        print(f"{lvl:32} {len(sel):4} {b1 / 2**20:7.0f} {b2 / 2**20:7.0f} {b4 / 2**20:8.0f} {bp / 2**20:7.0f}")
    os.makedirs(a.work, exist_ok=True)
    with open(os.path.join(a.work, "inventory.json"), "w") as f:
        json.dump({"categories": cats, "levels": rows,
                   "textures": [{"name": i["name"], "cat": i["cat"], "w": i["tex"].pix_w, "h": i["tex"].pix_h,
                                 "first_mip": i["tex"].first_mip, "frames": i["tex"].ct_frames,
                                 "alpha": i["tex"].has_alpha, "src": i["src"]} for i in items]}, f, indent=1)
    print(f"\nwrote {os.path.join(a.work, 'inventory.json')}")


# ---------------------------------------------------------------- image helpers

def to_png(path, rgba):
    from PIL import Image
    Image.fromarray(rgba).save(path)


def from_png(path):
    from PIL import Image
    return np.asarray(Image.open(path).convert("RGBA"))


def resize(img, w, h, filt="lanczos"):
    """Resize float or uint8 (h, w, c) with PIL per channel (float precision)."""
    from PIL import Image
    f = {"lanczos": Image.LANCZOS, "bicubic": Image.BICUBIC, "box": Image.BOX, "nearest": Image.NEAREST}[filt]
    src = img.astype(np.float32)
    ch = [np.asarray(Image.fromarray(src[..., c], mode="F").resize((w, h), f)) for c in range(src.shape[2])]
    out = np.stack(ch, -1)
    return out.clip(0, 255).round().astype(np.uint8) if img.dtype == np.uint8 else out


def lowpass(img, wrap, f=8):
    """Blur float (h, w, 3) 0..1 by a box downsample by f and a bicubic upsample (wrap-aware)."""
    h, w = img.shape[:2]
    pad = 2 * f
    p = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode="wrap" if wrap else "reflect")
    ph, pw = p.shape[:2]
    small = resize(p, max(1, pw // f), max(1, ph // f), "box")
    big = resize(small, pw, ph, "bicubic")
    return big[pad:pad + h, pad:pad + w]


def push_pull_fill(rgb, a):
    """Fill colours under transparent texels from their opaque neighbours (no dark halos)."""
    w8 = (a > 127).astype(np.float32)[..., None]
    if w8.all() or not w8.any():
        return rgb
    levels = [(rgb * w8, w8)]
    while min(levels[-1][0].shape[:2]) > 1:
        c, w = levels[-1]
        h2, w2 = c.shape[0] // 2 * 2, c.shape[1] // 2 * 2
        c, w = c[:h2, :w2], w[:h2, :w2]
        cs = c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]
        ws = w[0::2, 0::2] + w[1::2, 0::2] + w[0::2, 1::2] + w[1::2, 1::2]
        levels.append((cs, ws))
    fill = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)
    for c, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        up = np.pad(up, ((0, c.shape[0] - up.shape[0]), (0, c.shape[1] - up.shape[1]), (0, 0)), mode="edge")
        fill = np.where(w > 0, c / np.maximum(w, 1e-6), up)
    return np.where(w8 > 0, rgb, fill)


def alpha_kind(a):
    """'none', 'test' (alpha-tested: nearly all texels fully in or out) or 'blend'."""
    if a.min() >= 250:
        return "none"
    mid = ((a > 8) & (a < 247)).mean()
    return "test" if mid < 0.03 else "blend"


# ---------------------------------------------------------------- methods

SR_MODELS = {
    "pbrify": "4x-PBRify-UpscalerV4",
    "pbrify_span": "4x-PBRify_UpscalerSPANV4",
    "texdat2": "4xTextureDAT2_otf",
    "ultrasharp2": "4x-UltraSharpV2",
    "hatl": "4xNomos8kSCHAT-L",
    "swinir": "4x-SwinIR-L-realSR-GAN",
    "siax": "4x_NMKD-Siax_200k",
    "ultrasharp": "4x-UltraSharp",
}

PROMPTS = {
    "world": "seamless game texture, {hint}, sharp fine detail, high resolution, even lighting, flat orthographic",
    "model": "game character texture atlas, {hint}, sharp fine detail, high resolution, painted",
    "sky": "sky panorama, {hint}, high resolution, smooth clouds",
}


def hint_for(name):
    n = name.lower()
    for k, v in (("sand", "desert sand"), ("floor", "stone floor tiles"), ("brick", "sandstone bricks"),
                 ("wall", "ancient egyptian sandstone wall"), ("pillar", "carved egyptian hieroglyphs"),
                 ("column", "carved stone column"), ("glyph", "carved egyptian hieroglyphs"), ("metal", "metal plates"),
                 ("wood", "wood planks"), ("palm", "palm leaves"), ("background", "clouds and desert"),
                 ("weapons", "worn gunmetal and wood"), ("enemies", "creature skin and armour"), ("rock", "rock")):
        if k in n:
            return v
    return "ancient egyptian stone"


def method_key(method):
    return f"v{PIPELINE_VERSION}-{method}"


def upscale(rgba, method, wrap, name="", cat="world", ml=None, models=None, log=None):
    """rgba (h, w, 4) uint8 -> 4x (h*4, w*4, 4) uint8 with the given method.

    method: 'bicubic' | '<sr>' (SR_MODELS key) | 'sd15' (diffusion on a bicubic start) |
            '<sr>+sd15' (SR then a diffusion detail pass).
    Wrap-pads tileable textures before the SR models and crops after; the diffusion pass uses
    circular convolutions instead. Alpha goes its own way (see upscale_alpha).
    """
    h, w = rgba.shape[:2]
    a = rgba[..., 3]
    ak = alpha_kind(a)
    rgb = rgba[..., :3].astype(np.float32)
    if ak != "none":
        rgb = push_pull_fill(rgb, a)
    rgb = rgb / 255
    sr, _, dif = method.partition("+")
    if sr == "sd15":
        sr, dif = "bicubic", sr
    pad = 16 if sr != "bicubic" else 4
    mode = "wrap" if wrap else "reflect"
    if sr == "bicubic":
        p = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode=mode)
        up = resize(p * 255, p.shape[1] * 4, p.shape[0] * 4, "bicubic") / 255
    else:
        p = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode=mode)
        up = ml.run_sr(ml.model_path(models, SR_MODELS[sr]), p)
        s = up.shape[0] // p.shape[0]
        if s != 4:
            up = resize(up * 255, p.shape[1] * 4, p.shape[0] * 4, "lanczos") / 255
    up = up[pad * 4:pad * 4 + h * 4, pad * 4:pad * 4 + w * 4].clip(0, 1)
    if dif:
        prompt = PROMPTS.get(cat, PROMPTS["world"]).format(hint=hint_for(name))
        strength = 0.3 if sr != "bicubic" else 0.45
        start = up
        up = ml.run_sd(dif, up, prompt, strength=strength, seamless=wrap)
        # keep the palette and the shading: diffusion may shift colours, so take the low
        # frequencies (blur radius ~ one source texel x4) from the start and only the detail from SD
        up = (up + lowpass(start, wrap) - lowpass(up, wrap)).clip(0, 1)
    out = np.empty((h * 4, w * 4, 4), np.uint8)
    out[..., :3] = (up * 255 + 0.5).clip(0, 255).astype(np.uint8)
    out[..., 3] = upscale_alpha(a, ak, wrap)
    return out


def upscale_alpha(a, kind, wrap):
    """Alpha on its own: bicubic for smooth alpha; alpha-tested edges stay crisp (threshold at
    the engine's own 50% cut after a smooth upscale, so the outline is smooth but binary)."""
    h, w = a.shape
    if kind == "none":
        return np.full((h * 4, w * 4), 255, np.uint8)
    pad = 4
    p = np.pad(a.astype(np.float32), pad, mode="wrap" if wrap else "edge")[..., None]
    up = resize(p, p.shape[1] * 4, p.shape[0] * 4, "bicubic")[..., 0]
    up = up[pad * 4:pad * 4 + h * 4, pad * 4:pad * 4 + w * 4]
    if kind == "test":
        return np.where(up >= 128, 255, 0).astype(np.uint8)
    return up.clip(0, 255).round().astype(np.uint8)


def finish(up4, s, src_has_alpha_kind):
    """4x master -> the final scale s (1, 2 or 4): box-filtered downsample (supersampled result)."""
    h4, w4 = up4.shape[:2]
    if s == 4:
        return up4
    w, h = w4 * s // 4, h4 * s // 4
    rgb = resize(up4[..., :3], w, h, "box")
    a = up4[..., 3:].astype(np.float32)
    a = resize(a, w, h, "box")
    if src_has_alpha_kind == "test":
        a = np.where(a >= 128, 255, 0)
    out = np.concatenate([rgb, np.asarray(a).clip(0, 255).astype(np.uint8)], -1)
    return out


# ---------------------------------------------------------------- samples & comparison

SAMPLES = [
    ("stone_wall", "Textures/Levels/Hatshepsut/Wall01.tex"),
    ("brick", "Textures/Levels/Hatshepsut/Brick03.tex"),
    ("floor", "Textures/Levels/Hatshepsut/Floor1.tex"),
    ("hieroglyphs", "Textures/Levels/Hatshepsut/Pillar01.tex"),
    ("sand", "Textures/Levels/Dunes/Floor01.tex"),
    ("house_wall", "Textures/Levels/ThebesSuburbs/HouseWall01_1.tex"),
    ("metal", "Textures/Levels/GreatPyramid/MetalFloor01.tex"),
    ("wood", "Textures/General/Wood/Wood01.tex"),
    ("monster_skin", "Models/Enemies/Werebull/Werebull.tex"),
    ("weapon_skin", "Models/Weapons/SingleShotgun/Handle.tex"),
    ("plant_alpha", "Models/Plants/Palm10/Palm.tex"),
    ("grate_alpha", "Textures/Levels/GreatPyramid/LiftRoad.tex"),
    ("sky", "Textures/Background/Hatshepsut/Frame0001.tex"),
]


def sample_items(a):
    want = {n.lower(): k for k, n in SAMPLES}
    out = {}
    for i in index(a.data):
        k = want.get(i["name"].lower())
        if k:
            out[k] = i
    return [(k, out[k]) for k, _ in SAMPLES if k in out]


def cmd_samples(a):
    d = os.path.join(a.work, "samples")
    os.makedirs(d, exist_ok=True)
    for k, i in sample_items(a):
        to_png(os.path.join(d, k + ".png"), i["tex"].frames()[0])
        print(k, i["name"], f"{i['tex'].pix_w}x{i['tex'].pix_h}", i["cat"])


def label(img, text):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.fromarray(img).convert("RGB")
    dr = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    dr.rectangle([0, 0, im.width, 24], fill=(0, 0, 0))
    dr.text((6, 3), text, fill=(255, 255, 255), font=font)
    return np.asarray(im)


def on_checker(rgba):
    h, w = rgba.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    chk = np.where(((yy // 16) + (xx // 16)) % 2, 200, 120).astype(np.float32)[..., None]
    al = rgba[..., 3:4].astype(np.float32) / 255
    return (rgba[..., :3] * al + chk * (1 - al)).astype(np.uint8)


def crop_box(h, w, size=96):
    cs = min(size, h, w)
    return (h - cs) // 2, (w - cs) // 2, cs


def cmd_compare(a):
    import hdtex_ml as ml
    methods = a.methods.split(",")
    items = sample_items(a)
    if a.only:
        items = [(k, i) for k, i in items if re.search(a.only, k)]
    cdir = os.path.join(a.work, "compare")
    timing = {}
    tpath = os.path.join(cdir, "timing.json")
    if os.path.isfile(tpath):
        timing = json.load(open(tpath))
    for m in methods:
        md = os.path.join(cdir, m)
        os.makedirs(md, exist_ok=True)
        ml.free_models()  # one candidate's models in memory at a time
        for k, i in items:
            out = os.path.join(md, k + ".png")
            if os.path.isfile(out) and not a.force:
                continue
            ml.wait_for_memory()
            t0 = time.time()
            try:
                up = upscale(i["tex"].frames()[0], m, PLAN.get(i["cat"], {}).get("wrap", False), i["name"], i["cat"],
                             ml=ml, models=a.models)
            except Exception as e:  # noqa: BLE001
                print(f"  {m} {k}: FAILED {e!r}")
                continue
            dt = time.time() - t0
            timing.setdefault(m, {})[k] = round(dt, 2)
            to_png(out, up)
            print(f"  {m:18} {k:14} {i['tex'].pix_w}x{i['tex'].pix_h} -> {up.shape[1]}x{up.shape[0]}  {dt:6.1f} s", flush=True)
            json.dump(timing, open(tpath, "w"), indent=1)
    ml.free_models()
    rss, gpu = ml.peak_mem()
    print(f"peak RSS {rss / 2**30:.2f} GB, peak MPS allocation {gpu / 2**30:.2f} GB")
    make_sheets(a, items, methods)


def make_sheets(a, items, methods):
    """One sheet per sample: the same central crop, 4x zoom; original (nearest and bilinear as the
    game shows it) then every method. Plus a tiling check (2x2 repeat) for wrap textures."""
    cdir = os.path.join(a.work, "compare")
    allm = ["nearest", "bilinear"] + methods
    for k, i in items:
        src = i["tex"].frames()[0]
        h, w = src.shape[:2]
        y, x, cs = crop_box(h, w, a.crop)
        tiles = []
        for m in allm:
            if m == "nearest":
                big = np.repeat(np.repeat(src, 4, 0), 4, 1)
            elif m == "bilinear":
                big = resize(src, w * 4, h * 4, "bicubic")
            else:
                p = os.path.join(cdir, m, k + ".png")
                if not os.path.isfile(p):
                    continue
                big = from_png(p)
            c = big[y * 4:(y + cs) * 4, x * 4:(x + cs) * 4]
            tiles.append(label(on_checker(c), m))
        cols = min(4, len(tiles))
        rows = (len(tiles) + cols - 1) // cols
        th, tw = tiles[0].shape[:2]
        sheet = np.full((rows * (th + 6), cols * (tw + 6), 3), 30, np.uint8)
        for n, t in enumerate(tiles):
            r, c = divmod(n, cols)
            sheet[r * (th + 6):r * (th + 6) + th, c * (tw + 6):c * (tw + 6) + tw] = t
        to_png(os.path.join(cdir, f"sheet_{k}.png"), sheet)
    print(f"sheets in {cdir}")


# ---------------------------------------------------------------- build

def cmd_build(a):
    import hdtex_ml as ml
    items = index(a.data)
    todo = [i for i in items if target_scale(i["tex"], i["cat"]) > 1]
    if a.only:
        todo = [i for i in todo if re.search(a.only, i["name"], re.I)]
    if a.levels:
        lv = level_textures(a.data, items)
        want = set()
        for l in a.levels.split(","):
            want |= {n for k, v in lv.items() if l.lower() in k.lower() for n in v}
        common = ("models/weapons/", "models/items/", "models/player/", "models/enemies/")
        todo = [i for i in todo if i["name"] in want or i["name"].lower().startswith(common)]
    if a.limit:
        todo = todo[:a.limit]
    method = {"world": a.world, "model": a.model, "sky": a.sky}
    cache = os.path.join(a.work, "cache")
    print(f"{len(todo)} textures to make (of {len(items)}); methods {method}")
    t_all = time.time()
    made = 0
    for n, i in enumerate(todo):
        t = i["tex"]
        m = method[i["cat"]]
        key = hashlib.sha1(i["raw"]).hexdigest()[:16]
        mdir = os.path.join(cache, method_key(m))
        os.makedirs(mdir, exist_ok=True)
        cp = os.path.join(mdir, key + ".png")
        if os.path.isfile(cp) and not a.force:
            continue
        if made % 10 == 0:
            ml.wait_for_memory()
        t0 = time.time()
        frames = t.frames()
        ups = [upscale(f, m, PLAN[i["cat"]]["wrap"], i["name"], i["cat"], ml=ml, models=a.models) for f in frames]
        to_png(cp, np.concatenate(ups, 0))
        made += 1
        dt = time.time() - t0
        el = time.time() - t_all
        print(f"[{n + 1}/{len(todo)}] {m:14} {i['name']} {t.pix_w}x{t.pix_h} {dt:5.1f} s"
              f"  (elapsed {el / 60:.1f} min)", flush=True)
        if a.maps:
            make_maps(i, cp, a, ml)
    if a.maps:
        ml.free_models()  # the colour models out, the map models in
        for i in todo:
            mdir = os.path.join(cache, method_key(method[i["cat"]]))
            make_maps(i, os.path.join(mdir, hashlib.sha1(i["raw"]).hexdigest()[:16] + ".png"), a, ml)
    rss, gpu = ml.peak_mem()
    print(f"made {made} new 4x masters in {(time.time() - t_all) / 60:.1f} min; "
          f"peak RSS {rss / 2**30:.2f} GB, peak MPS allocation {gpu / 2**30:.2f} GB")
    pack(a, items, method)


def make_maps(i, master_png, a, ml):
    """Normal (RGB) + height (A) from the HD colour with the 1x PBRify models, cached by master."""
    if i["cat"] not in ("world", "model") or not os.path.isfile(master_png):
        return
    mp = master_png[:-4] + "_nh.png"
    if os.path.isfile(mp) and not a.force:
        return
    col = from_png(master_png)
    t = i["tex"]
    fh = col.shape[0] // max(1, t.ct_frames)
    col = col[:fh, :, :3].astype(np.float32) / 255
    # the maps don't need 4x: work at the shipped colour size (max 1024)
    s = target_scale(t, i["cat"])
    w, h = t.pix_w * s, t.pix_h * s
    if (w, h) != (col.shape[1], col.shape[0]):
        col = resize(col * 255, w, h, "box") / 255
    wrap = PLAN[i["cat"]]["wrap"]
    pad = 16
    p = np.pad(col, ((pad, pad), (pad, pad), (0, 0)), mode="wrap" if wrap else "reflect")
    nrm = ml.run_sr(ml.model_path(a.models, "1x-PBRify_NormalV3"), p, tile=256)[pad:pad + h, pad:pad + w]
    hgt = ml.run_sr(ml.model_path(a.models, "1x-PBRify_Height"), p, tile=256)[pad:pad + h, pad:pad + w]
    out = np.empty((h, w, 4), np.uint8)
    out[..., :3] = (nrm * 255 + 0.5).clip(0, 255).astype(np.uint8)
    out[..., 3] = (hgt.mean(-1) * 255 + 0.5).clip(0, 255).astype(np.uint8)
    to_png(mp, out)


def pack(a, items, method):
    """Write the override archive(s) from the cache: one .tex per upscaled texture."""
    outd = os.path.join(a.work, "out")
    os.makedirs(outd, exist_ok=True)
    cache = os.path.join(a.work, "cache")
    arc = os.path.join(outd, ARCHIVE)
    marc = os.path.join(outd, MAPS_ARCHIVE)
    n = nm = 0
    px1 = pxh = 0
    with zipfile.ZipFile(arc + ".tmp", "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z, \
            zipfile.ZipFile(marc + ".tmp", "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zm:
        for i in items:
            t = i["tex"]
            s = target_scale(t, i["cat"])
            if s == 1:
                continue
            key = hashlib.sha1(i["raw"]).hexdigest()[:16]
            cp = os.path.join(cache, method_key(method[i["cat"]]), key + ".png")
            if not os.path.isfile(cp):
                continue
            up4 = from_png(cp)
            fh = up4.shape[0] // t.ct_frames
            ak = "none"
            if t.has_alpha:
                ak = alpha_kind(t.frames()[0][..., 3])
            frames = np.stack([finish(up4[f * fh:(f + 1) * fh], s, ak) for f in range(t.ct_frames)])
            fm = t.first_mip - (s.bit_length() - 1)
            alpha = t.has_alpha and ak != "none"
            hd = t.with_frames(frames, fm, alpha=alpha)
            z.writestr(i["name"], hd.build())
            n += 1
            px1 += t.pix_w * t.pix_h
            pxh += hd.pix_w * hd.pix_h
            mp = cp[:-4] + "_nh.png"
            if os.path.isfile(mp):
                nh = from_png(mp)[None]
                nt = t.with_frames(np.repeat(nh, t.ct_frames, 0) if t.ct_frames > 1 else nh, fm, alpha=True)
                zm.writestr(i["name"][:-4] + "_nh.tex", nt.build())
                nm += 1
    os.replace(arc + ".tmp", arc)
    os.replace(marc + ".tmp", marc)
    if nm == 0:
        os.remove(marc)
    print(f"{arc}: {n} textures, {os.path.getsize(arc) / 2**20:.0f} MB, {px1 / 1e6:.1f} -> {pxh / 1e6:.1f} Mpx")
    if nm:
        print(f"{marc}: {nm} normal+height maps, {os.path.getsize(marc) / 2**20:.0f} MB")


# ---------------------------------------------------------------- data folder

HD_INI = """// HD textures (tools/hdtex.py mkdata): raise the texture size cap so the HD textures from
// ZZ_HD_Textures.gro aren't downscaled at load. tex_iNormalSize is log2 of the largest texture
// side for square textures (area = 4^n): 10 = 1024x1024.
tex_iNormalSize = 10;
"""


def cmd_mkdata(a):
    src, dst = a.data, a.out
    if os.path.abspath(src) == os.path.abspath(dst):
        sys.exit("refusing to write into the source data folder")
    arc = os.path.join(a.work, "out", ARCHIVE)
    if not os.path.isfile(arc):
        sys.exit(f"no {arc}: run build first")
    # hard-link copy: no extra disk, and the retail folder is never written to
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in files:
            s, d = os.path.join(root, f), os.path.join(dst, rel, f)
            if os.path.exists(d):
                st, dt = os.stat(s), os.stat(d)
                if st.st_ino == dt.st_ino:
                    continue
                os.remove(d)
            os.link(s, d)
    for name in (ARCHIVE, MAPS_ARCHIVE):
        p = os.path.join(a.work, "out", name)
        d = os.path.join(dst, name)
        if os.path.exists(d):
            os.remove(d)
        if os.path.isfile(p):
            shutil.copy2(p, d)
    # the GLSettings presets (re-run on every mode change) set tex_iNormalSize: append the raised
    # cap to each preset, in the copy only (replace the hard link with a real file first)
    gl = os.path.join(dst, "Scripts", "GLSettings")
    with open(os.path.join(gl, "HD.ini"), "w") as f:
        f.write(HD_INI)
    inc = '\ninclude "Scripts\\GLSettings\\HD.ini";\n'
    for f in sorted(os.listdir(gl)):
        if not f.lower().endswith(".ini") or f == "HD.ini":
            continue
        p = os.path.join(gl, f)
        with open(p, "rb") as fh:
            body = fh.read()
        if inc.strip().encode() in body:
            continue
        os.remove(p)  # break the hard link
        with open(p, "wb") as fh:
            fh.write(body + inc.encode())
    print(f"{dst}: hard-link copy of {src} + {ARCHIVE}" + (f" + {MAPS_ARCHIVE}" if os.path.isfile(os.path.join(dst, MAPS_ARCHIVE)) else "")
          + "; Scripts/GLSettings presets include HD.ini (tex_iNormalSize = 10)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["inventory", "samples", "compare", "build", "mkdata"])
    ap.add_argument("--data", default=os.path.join(DATA_ROOT, "tfe-full-web"))
    ap.add_argument("--work", default=os.path.join(DATA_ROOT, "hdtex"))
    ap.add_argument("--models", default=None)
    ap.add_argument("--out", default=os.path.join(DATA_ROOT, "tfe-hd-web"))
    ap.add_argument("--methods", default="bicubic,pbrify,texdat2,ultrasharp2,hatl,swinir,siax")
    ap.add_argument("--world", default="pbrify")
    ap.add_argument("--model", default="pbrify")
    ap.add_argument("--sky", default="swinir")
    ap.add_argument("--only")
    ap.add_argument("--levels")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--crop", type=int, default=96)
    ap.add_argument("--maps", action="store_true", help="also make normal+height maps")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    a.models = a.models or os.path.join(a.work, "models")
    {"inventory": cmd_inventory, "samples": cmd_samples, "compare": cmd_compare, "build": cmd_build,
     "mkdata": cmd_mkdata}[a.cmd](a)


if __name__ == "__main__":
    main()
