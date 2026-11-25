"""Machine-learning backends for tools/hdtex.py (needs torch; run with the hdtex venv).

  SR      super-resolution models loaded with spandrel (ESRGAN, DAT, HAT, SwinIR, SPAN, ...),
          run tiled on MPS so big inputs fit
  SD      Stable Diffusion img2img with the tile ControlNet ("recreation" at low denoise):
          sd15 = SD 1.5 + control_v11f1e_sd15_tile (SDXL-class models are out: too heavy for the Mac
          next to everything else). Up to 512x512 the image goes in whole and every Conv2d in the
          UNet, ControlNet and VAE gets circular padding, so a tileable texture stays seamless;
          bigger images go in 512 tiles (wrap-padded, feathered), which keeps the memory flat.
  maps    1x PBRify normal / height models (tileable inputs are wrap-padded the same way)

All functions take and return float32 numpy arrays (h, w, 3) in 0..1.

Resource limits (the Mac has 36 GB shared with the game, builds and Chrome): 4 CPU threads, fp16 on
MPS, an MPS high-water mark of half the memory, tiles of 512 or less, one model in memory at a time
(free_models() between candidates). Run under `nice -n 15`.
"""
import gc
import os
import resource
import subprocess
import time

for _k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_k, "4")
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.5")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.4")  # must not exceed the high mark
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402

torch.set_num_threads(4)

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
_models = {}
_peak_gpu = 0


def free_models():
    """Drop every loaded model and give the memory back (between candidates)."""
    _models.clear()
    gc.collect()
    if DEV == "mps":
        torch.mps.empty_cache()


def _note_gpu():
    global _peak_gpu
    if DEV == "mps":
        _peak_gpu = max(_peak_gpu, torch.mps.driver_allocated_memory())


def peak_mem():
    """(peak RSS of this process, peak MPS driver allocation) in bytes."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, _peak_gpu


def wait_for_memory(min_free=40, max_swap_mb=2048, log=print):
    """Block while the system is short of memory: free under min_free % or swap over max_swap_mb."""
    t0 = time.time()
    while True:
        try:
            mp = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout.strip().splitlines()[-1]
            free = int(mp.rsplit(":", 1)[1].strip().rstrip("%"))
            sw = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
            used = float(sw.split("used = ")[1].split("M")[0])
        except Exception:  # noqa: BLE001  (not macOS: no check)
            return
        if free >= min_free and used <= max_swap_mb:
            return
        if time.time() - t0 < 1:
            log(f"  waiting for memory: free {free}%, swap used {used:.0f} MB")
        time.sleep(30)


def _load_sr(path):
    if path not in _models:
        from spandrel import ModelLoader
        m = ModelLoader(device="cpu").load_from_file(path)
        m.model.eval()
        m.to(DEV)
        if DEV == "mps" and m.supports_half:
            m.half()
        _models[path] = m
    return _models[path]


def sr_scale(path):
    return _load_sr(path).scale


@torch.inference_mode()
def run_sr(path, img, tile=192, overlap=16):
    """Super-resolve img (h, w, 3) float 0..1 with the model at `path`. Returns (h*s, w*s, 3)."""
    m = _load_sr(path)
    s = m.scale
    h, w, _ = img.shape
    out = np.zeros((h * s, w * s, 3), np.float32)
    wsum = np.zeros((h * s, w * s, 1), np.float32)
    step = tile - 2 * overlap
    ys = list(range(0, max(1, h - 2 * overlap), step)) if h > tile else [0]
    xs = list(range(0, max(1, w - 2 * overlap), step)) if w > tile else [0]
    for y0 in ys:
        for x0 in xs:
            y1, x1 = min(h, y0 + tile), min(w, x0 + tile)
            y0b, x0b = max(0, y1 - tile), max(0, x1 - tile)
            patch = img[y0b:y1, x0b:x1]
            t = torch.from_numpy(np.ascontiguousarray(patch.transpose(2, 0, 1)))[None].to(m.device, m.dtype)
            r = m(t)
            _note_gpu()
            r = r[0].clamp(0, 1).float().cpu().numpy().transpose(1, 2, 0)
            # feathered blend so tile seams don't show
            ph, pw = r.shape[:2]
            wy = np.minimum(np.arange(ph) + 1, np.arange(ph)[::-1] + 1).astype(np.float32)
            wx = np.minimum(np.arange(pw) + 1, np.arange(pw)[::-1] + 1).astype(np.float32)
            wt = np.minimum(np.minimum(wy[:, None], overlap * s), np.minimum(wx[None, :], overlap * s))[..., None]
            out[y0b * s:y1 * s, x0b * s:x1 * s] += r * wt
            wsum[y0b * s:y1 * s, x0b * s:x1 * s] += wt
    return out / np.maximum(wsum, 1e-6)


# ---------------------------------------------------------------- diffusion

SD = {
    "sd15": dict(base="stable-diffusion-v1-5/stable-diffusion-v1-5", variant="fp16",
                 cn=("comfyanonymous/ControlNet-v1-1_fp16_safetensors", "control_v11f1e_sd15_tile_fp16.safetensors",
                     "lllyasviel/control_v11f1e_sd15_tile")),
}


def _circular(module, on):
    for mod in module.modules():
        if isinstance(mod, torch.nn.Conv2d):
            if not hasattr(mod, "_hd_pad_mode"):
                mod._hd_pad_mode = mod.padding_mode
            mod.padding_mode = "circular" if on else mod._hd_pad_mode


def _local(repo):
    """The local snapshot folder of a downloaded HF repo (we fetch only the fp16 files, which the
    offline completeness check in from_pretrained rejects), else the repo id."""
    from huggingface_hub.constants import HF_HUB_CACHE
    d = os.path.join(HF_HUB_CACHE, "models--" + repo.replace("/", "--"))
    try:
        ref = open(os.path.join(d, "refs", "main")).read().strip()
    except OSError:
        return repo
    snap = os.path.join(d, "snapshots", ref)
    return snap if os.path.isdir(snap) else repo


def _load_sd(kind):
    key = "sd:" + kind
    if key in _models:
        return _models[key]
    from diffusers import ControlNetModel
    cfg = SD[kind]
    dtype = torch.float16
    repo, single, cfg_repo = cfg["cn"]
    if single:
        from huggingface_hub import hf_hub_download
        cn = ControlNetModel.from_single_file(hf_hub_download(repo, single), config=_local(cfg_repo), torch_dtype=dtype)
    else:
        cn = ControlNetModel.from_pretrained(_local(repo), torch_dtype=dtype)
    from diffusers import StableDiffusionControlNetImg2ImgPipeline as P
    pipe = P.from_pretrained(_local(cfg["base"]), controlnet=cn, variant=cfg["variant"], torch_dtype=dtype,
                             safety_checker=None, requires_safety_checker=False)
    from diffusers import DPMSolverMultistepScheduler
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
    pipe.to(DEV)
    pipe.set_progress_bar_config(disable=True)
    pipe.enable_attention_slicing()
    _models[key] = pipe
    return pipe


NEG = ("blurry, low quality, jpeg artifacts, text, watermark, signature, logo, photo of a room, "
       "perspective, 3d render of a scene, people, frame, border")


@torch.inference_mode()
def _sd_once(pipe, img, prompt, strength, steps, cfg, cn_scale, circular, seed):
    from PIL import Image
    h, w = img.shape[:2]
    H, W = max(64, (h + 32) // 64 * 64), max(64, (w + 32) // 64 * 64)
    pil = Image.fromarray((img * 255 + 0.5).clip(0, 255).astype(np.uint8))
    if (H, W) != (h, w):
        pil = pil.resize((W, H), Image.LANCZOS)
    for part in (pipe.unet, pipe.vae, pipe.controlnet):
        _circular(part, circular)
    g = torch.Generator("cpu").manual_seed(seed)
    out = pipe(prompt=prompt, negative_prompt=NEG, image=pil, control_image=pil, strength=strength,
               num_inference_steps=steps, guidance_scale=cfg, controlnet_conditioning_scale=cn_scale,
               generator=g, width=W, height=H, output_type="np").images[0].astype(np.float32)
    _note_gpu()
    if not np.isfinite(out).all():
        raise RuntimeError("diffusion produced NaNs")
    if (H, W) != (h, w):
        out = np.asarray(Image.fromarray((out * 255 + 0.5).clip(0, 255).astype(np.uint8)).resize((w, h), Image.LANCZOS),
                         np.float32) / 255
    return out


def run_sd(kind, img, prompt, strength=0.35, steps=24, cfg=5.0, cn_scale=1.0, seamless=False, seed=1,
           tile=512, overlap=64):
    """Re-detail img (h, w, 3) float 0..1 (already at the target size) with SD + tile ControlNet.

    Low `strength` keeps layout and palette; the tile ControlNet, fed the same image, keeps the
    structure locked. Images up to `tile` go in whole (circular convolutions when seamless);
    bigger ones in tile x tile pieces with feathered overlaps, wrap-padded when seamless.
    """
    pipe = _load_sd(kind)
    h, w = img.shape[:2]
    if h <= tile and w <= tile:
        return _sd_once(pipe, img, prompt, strength, steps, cfg, cn_scale, seamless, seed)
    p = overlap
    src = np.pad(img, ((p, p), (p, p), (0, 0)), mode="wrap" if seamless else "reflect")
    H, W = src.shape[:2]
    out = np.zeros_like(src)
    wsum = np.zeros((H, W, 1), np.float32)
    step = tile - overlap
    ys = sorted({min(y, H - tile) for y in range(0, max(1, H - overlap), step)}) if H > tile else [0]
    xs = sorted({min(x, W - tile) for x in range(0, max(1, W - overlap), step)}) if W > tile else [0]
    for y0 in ys:
        for x0 in xs:
            patch = src[y0:y0 + tile, x0:x0 + tile]
            r = _sd_once(pipe, patch, prompt, strength, steps, cfg, cn_scale, False, seed)
            ph, pw = r.shape[:2]
            wy = np.minimum(np.arange(ph) + 1, np.arange(ph)[::-1] + 1).astype(np.float32)
            wx = np.minimum(np.arange(pw) + 1, np.arange(pw)[::-1] + 1).astype(np.float32)
            wt = np.minimum(np.minimum(wy[:, None], overlap), np.minimum(wx[None, :], overlap))[..., None]
            out[y0:y0 + ph, x0:x0 + pw] += r * wt
            wsum[y0:y0 + ph, x0:x0 + pw] += wt
    return (out / np.maximum(wsum, 1e-6))[p:p + h, p:p + w]


def timed(fn, *a, **k):
    t = time.time()
    r = fn(*a, **k)
    if DEV == "mps":
        torch.mps.synchronize()
    return r, time.time() - t


def model_path(models_dir, name):
    for ext in ("", ".safetensors", ".pth"):
        p = os.path.join(models_dir, name + ext)
        if os.path.isfile(p):
            return p
    raise FileNotFoundError(name)
