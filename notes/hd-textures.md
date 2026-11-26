# HD textures

The retail TFE textures, AI-upscaled offline and loaded from an override archive, so the `full`
game looks remastered without touching the retail data or the engine. Tools: `tools/tex.py`
(.tex codec), `tools/test_tex.py` (round trip), `tools/hdtex.py` (pipeline), `tools/hdtex_ml.py`
(model backends). Everything they make is retail-derived and lives under `data/` (never committed).

## How to use it

```sh
# once: a venv with torch + spandrel + diffusers, and the models (see "Models" below)
python3 -m venv data/hdtex/venv && data/hdtex/venv/bin/pip install torch spandrel diffusers transformers accelerate pillow numpy
export OMP_NUM_THREADS=4 PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.5 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.4
P="nice -n 15 data/hdtex/venv/bin/python tools/hdtex.py"
python3 tools/hdtex.py inventory               # categories, pixel area, per-level memory
$P compare --methods pbrify,ultrasharp2,swinir # contact sheets: data/hdtex/compare/sheet_*.png
$P build --levels 01_Hatshepsut,08_Suburbs --maps   # or no --levels: everything (cached, incremental)
python3 tools/hdtex.py mkdata                  # data/tfe-hd-web
cmake -S port -B build-web-tfe-hd -DDATA_DIR=$PWD/data/tfe-hd-web -DSE1_LAZY_DATA=ON -DSE1_PROFILE=ON …  # as build-web-tfe-full
node tools/dev.mjs build hd && node tools/dev.mjs serve hd     # http://localhost:8097
```

- **HD on/off:** the HD build is `hd` (port 8097, `build-web-tfe-hd`, data `data/tfe-hd-web`). `?hd=0`
  on its URL removes `ZZ_HD_Textures.gro` and `ZZ_HD_Maps.gro` from the file system before the
  engine starts (`port/web/lazydata.js`): the same binary then shows the retail textures. The
  `full` build (8096) and `data/tfe-full-web` are untouched.
- `data/tfe-hd-web` is a hard-link copy of `data/tfe-full-web` (no extra disk; the retail folder is
  never written) plus the two archives and the raised texture cap. Re-run `mkdata` after a `build`,
  then relink the HD build.
- Worktrees have no `data/`: set `SE1_DATA_ROOT=/path/to/main/checkout/data`.

## How it works

**The .tex format** (`Texture.cpp` Read_t/Write_t). `TVER` + version 3/4, then chunks: TDAT
(flags, mex size, fine mips, first mip, frames), FRMS (v4: only the finest mip, RGBA8 or RGB8;
v3: the whole mip chain as RGBA4444/RGB5551), ANIM, BAST/DTLT, and the effect chunks FXDT, FXB2,
FXBF. `tools/tex.py` parses and rebuilds all 1329 retail textures **byte-identically**, decodes
the pixels (v3 16-bit like `Convert()`), and writes a new v4 file with other pixels:
`python3 tools/test_tex.py data/tfe-full-web` → `1329 textures: byte-identical 1329, pixel round
trip 1329, 2x rewrite 1329`.

**The trick that makes it drop-in:** a texture's on-screen size comes from its *mex* size; the
stored pixels are `mex >> firstMip`. Every world and model texture has `firstMip >= 2`, so an HD
texture keeps the mex size and lowers `firstMip` by log2(scale): brush and model mapping, UVs and
scripts don't change. The engine makes the mips at load (`MakeMipmaps`), so the files store only
the finest level.

**Override archive.** `UNZIPReadDirectoriesReverse_t` sorts the archives in reverse name order
(`stricmp`) and `UNZIPGetFileIndex` takes the first hit, so the alphabetically last archive wins:
`ZZ_HD_Textures.gro` overrides every retail `.gro` (`fil_bPreferZips` is off, but no texture is a
loose file in the full data, so nothing shadows it).

**The size cap.** `RemoveOversizedMipmaps` drops mips above `tex_iNormalSize` (area 4^n). The
GLSettings presets re-run on every mode change and set it from `RAM.ini` (6–10 by quality), so
`mkdata` writes `Scripts/GLSettings/HD.ini` (`tex_iNormalSize = 10;`, 1024x1024) and appends an
`include` of it to every preset in the copy. No engine change. Lowering it again (`tex_iNormalSize
= 9` in the console) is a runtime memory knob: the engine drops the top mip of the HD textures.

**Pipeline per texture** (`hdtex.py build`):
1. Classify: world (brush, `Textures/`), model (`Models/`), sky (`Background`), effect, UI.
   Effects (procedural fire/water), UI, fonts and textures under 16 px stay as they are.
2. Make a 4x master: tileable world textures are **wrap-padded** (16 px) before the model and
   cropped after, so they stay seamless; models are reflect-padded. Transparent texels get their
   colour pushed in from their neighbours first, so no dark fringes.
3. **Alpha on its own**: bicubic; alpha-*tested* textures (under 3% mid-alpha texels) are
   thresholded at 50% after the smooth upscale: crisp but smooth outlines, no grey halos.
4. Diffusion (optional, `<sr>+sd15`): SD1.5 + tile ControlNet at low denoise on 512 tiles, then
   the low frequencies are taken from the SR start again (colour and shading lock).
5. Box-downsample the master to the planned scale (supersampled), write the .tex, pack.
6. Cache: `data/hdtex/cache/v<pipeline>-<method>/<sha1 of the source .tex>.png`. Re-runs only do
   new or changed textures; `--force` redoes.

## Inventory

1329 textures in the full data (later archives override earlier ones):

| category | count | with alpha | Mpx at 1x | Mpx as planned |
|---|---:|---:|---:|---:|
| world (brush) | 424 | 30 | 40.56 | 277.84 |
| model skins | 260 | 37 | 14.12 | 159.35 |
| sky | 121 | 1 | 10.79 | 43.16 |
| effect / animated | 182 | | | (left as is) |
| UI / fonts / HUD | 310 | | | (left as is) |
| other | 32 | | | (left as is) |

Per-level texture memory (RGBA8 + mips, MB): the textures named in the level's .wld plus the
weapon, item and player skins; enemy skins come from entity code and aren't counted, so add
roughly 30–80 MB at 1x x the same factor. "plan" is the per-category plan below.

| level | 1x | 2x | 4x, cap 1024 | plan |
|---|---:|---:|---:|---:|
| 01_Hatshepsut | 77 | 300 | 752 | 702 |
| 02_SandCanyon | 60 | 233 | 588 | 588 |
| 04_ValleyOfTheKings | 72 | 278 | 683 | 683 |
| 08_Suburbs | 66 | 251 | 600 | 580 |
| 09_Sewers | 50 | 192 | 501 | 501 |
| 10_Metropolis | 75 | 282 | 649 | 617 |
| 12_Karnak | 71 | 263 | 675 | 647 |
| 13_Luxor | 78 | 299 | 717 | 687 |
| 15_TheGreatPyramid | 77 | 289 | 667 | 643 |

This is GPU memory. The wasm heap cost is transient: dynamic textures free their pixels after the
upload (`Texture.cpp`), and the GL shim keeps no copy.

## Choosing the upscaler

Fixed sample set (13): Hatshepsut stone wall relief, brick, floor, hieroglyph pillar, Dunes sand,
Suburbs house wall, Great Pyramid metal floor and lift grate (alpha), wood, Werebull skin, shotgun
skin, palm leaves (alpha), Hatshepsut sky. Contact sheets: `data/hdtex/compare/sheet_<sample>.png`
(same central crop, 4x zoom, nearest/bilinear first), outputs in `data/hdtex/compare/<method>/`.

Candidates and time for the 13 samples on the M-series GPU (MPS, fp16 where the model allows,
4 CPU threads, niced):

| method | kind | 13 samples | brick 256² | notes |
|---|---|---:|---:|---|
| bicubic | baseline | 0.7 s | 0.03 s | blur |
| 4x-PBRify-UpscalerV4 (DAT2) | texture-trained transformer | 248 s | 5.7 s | natural material grain (pitting, cracks), keeps the palette |
| 4x-PBRify SPAN V4 | texture-trained, light | 3.9 s | 0.2 s | fast, smudgy |
| 4xTextureDAT2_otf | texture-trained transformer | 141 s | 6.9 s | very sharp but **shifts colours** (warm sandstone goes grey), invents patterns on leaves |
| 4x-UltraSharpV2 (DAT2) | general transformer | 135 s | 5.8 s | crisp edges (metal, grates, weapon parts); invents crack networks on skin |
| 4xNomos8kSC HAT-L | general transformer | 360 s | 16.7 s | faithful, clean, soft; blotchy clouds |
| SwinIR-L realSR GAN | general transformer | 197 s | 8.3 s | smooth, natural; best on clouds |
| NMKD Siax, UltraSharp (ESRGAN) | CNN | 26 s | 1.1 s | over-sharpened, worms |
| SD1.5 + tile ControlNet (bicubic start, denoise 0.45) | diffusion | 5 samples: 300 s | 54 s | stays blurry: the tile ControlNet locks to the blurred input |
| PBRify → SD1.5 tile (denoise 0.3) | hybrid | 5 samples: 296 s | 61 s | a little more surface variation than PBRify alone, slightly softer |
| UltraSharpV2 → SD1.5 tile (denoise 0.3) | hybrid | 5 samples: 285 s | 55 s | same; tames UltraSharp's cracks a bit |

Not tried, and why: SDXL (and xinsir's SDXL tile ControlNet), SUPIR and Flux are too heavy for a
shared 36 GB Mac (the machine rebooted once with a model run, a GI bake and a game open together);
SD1.5 tile is the largest diffusion model this pipeline runs.

Diffusion sheets (5 samples: stone wall, brick, hieroglyphs, metal, Werebull):
`data/hdtex/compare/sheet_sd_<sample>.png`. Diffusion ran on 512 tiles (feathered 64 px overlaps,
wrap-padded for tileable textures), 24 steps (about 7 at denoise 0.3), CFG 5, then the low
frequencies came back from the SR start, so colours and shading can't drift. Peak for the SD run:
RSS 1.47 GB, process footprint 6.6 GB with the MPS allocations (SR runs: 2.2 GB / 4.0 GB).

**The choice, per category:**

| category | method | final size | why |
|---|---|---|---|
| world (brush) | PBRify V4 (4x master, box-downsampled) | 4x, longest side ≤ 1024 | texture-trained: plausible stone pitting, cracks and grain; keeps the warm palette; seamless with wrap padding |
| model skins | PBRify V4 | 4x, ≤ 1024 | faithful on skin and cloth (UltraSharpV2 invents crack networks on the Werebull); weapons and items close to the camera get the most from 1024 |
| alpha (plants, grates) | PBRify V4 + separate alpha | as above | TextureDAT2 paints camouflage patterns into palm leaves; the alpha path keeps edges crisp |
| sky | SwinIR-L realSR | 2x, ≤ 1024 | the only one that keeps clouds soft (the others make cauliflower) |
| effects, UI, fonts | none | 1x | procedural or pixel art at firstMip 0: no room to scale without changing the mex size |

Diffusion is not worth it at this denoise: at 0.3 it barely differs from the SR start, and from a
bicubic start at 0.45 it stays blurry. Stronger denoise wasn't tried: it trades faithfulness for
invention (the relief figures and hieroglyphs are exactly what it would repaint), which the brief
rules out. It costs ~10x the SR time (about 1 min per 256²
texture, ~11 h for all world and model textures vs ~1.5 h for PBRify). `--world pbrify+sd15` is
there for anyone who wants to try it on hero textures. UltraSharpV2 is the runner-up for metal and
weapon parts (crisper edges); a per-texture method override is an easy next step.

## Normal and height maps

`build --maps` runs the 1x PBRify NormalV3 and Height models on each world and model texture at
its shipped HD size (wrap-padded for tileable ones) and stores **normal in RGB, height in A** as a
`.tex` with the same mex size and first mip as the HD colour texture, named `<texture>_nh.tex`, in
`ZZ_HD_Maps.gro` (same override archive mechanism; the engine never asks for these names, so they
cost nothing until a renderer uses them). Roughness was skipped (another model, little gain on a
renderer without specular).

### Normal maps in the renderer (`?nm=1`)

Wired for brushes, WebGL only (WebGPU and models are not done). `port/common/Se1NormalMaps.cpp`:

- **Loading.** When a texture's GL objects are made (`Texture.cpp` hook) it looks for
  `<name>_nh.tex` and, if found, binds it once and registers it with the shim as the texture's
  *companion* (`SE1_GL1Shim_SetCompanion`, for every frame object of an animated texture).
- **Light direction.** The engine's light maps are scalar, so `SE1NM_MixDirections` (LayerMixer
  hook) bakes a second RGBA map per shadow map: per texel the luminance-weighted sum of the static
  lights' directions (point lights with the hotspot/falloff ramp, directional lights by their
  angle, each masked by its layer shadow bits) in the frame (StepU, StepV, normal), and in A the
  directional share `k = |sum w*L| / max(texel luminance, sum w)`, so ambient and GI stay flat.
  It is uploaded with the shadow map and is the shadow texture's companion. 01_Hatshepsut: 217
  maps in 7.6 ms.
- **Shading.** `gl1shim.c` `nm_key`: a draw with a base texture (unit 0, MODULATE) and the shadow
  map on a COMBINE-MODULATE unit, both with companions, binds them on units 4 and 5 and sets
  bit 21 of the program key. The shader takes the tangent axes from the Jacobian of the shadow uv
  over the base uv (`dFdx`/`dFdy`), turns the light direction into texture space and scales the
  shadow by `f = (1-k) + k*max(n.l, 0)/max(l.z, 0.25)`, capped at `gfx_fNormalMaxBoost` (2.5).
- **Cvars.** `gfx_bNormalMaps`, `gfx_fNormalStrength` (2; the PBRify normals are flat, mean
  n.z 0.97), `gfx_fNormalFlipY` (+1: green points along +v, image rows down; checked against the
  height channel's slope, correlation 0.6–0.8 on both axes), `NM_Refresh()` re-mixes the light
  maps, `NM_Stats()`. `?nm=2` logs every texture it looks up.

Off (`?nm` absent) it costs nothing: no lookups, no direction maps, the shim keys are unchanged.

## Results (01_Hatshepsut + 08_Suburbs)

**Build:** `build --levels 01_Hatshepsut,08_Suburbs --maps` made 304 new 4x masters (308 planned,
the rest cached from the sheets) in 37.4 min, one model process, niced, 4 threads. Output:
`ZZ_HD_Textures.gro` 321 textures, 345 MB (23.4 → 189.8 Mpx); `ZZ_HD_Maps.gro` 274 normal+height
maps, 430 MB; cache 783 MB. Peak for the build: RSS 2.33 GB (`time -l` 2.50 GB), MPS allocations
4.34 GB, process footprint 6.18 GB. The whole project's worst peak was the SD sheet run (footprint
6.6 GB, RSS 1.47 GB); the machine stayed under the 8 GB budget throughout.

**In game** (same binary, `hd` build, HD vs `?hd=0`; headless Chrome, 844x633 canvas, same pose
via `GI_Pose`, same level time so the weather matches). Shots in `data/hdtex/shots/`:
`<level>_<pose>_{1x,hd}.png`, side by side `pair_<level>_<pose>.png`, both levels on one page
`sheet_hat.png` / `sheet_sub.png`, 2x crops `zoom_*.png`. Poses `e` and `f` are at FOV 25
(`plr_fFOV`), which shows what a 4K screen or a wall up close sees.

| pose | what | fine detail, HD / 1x |
|---|---|---:|
| hat_a | start, temple ahead | 1.06 |
| hat_b / hat_c | colonnade, relief pillars | 0.94 / 0.84 (less moiré on the patterned base, not less detail) |
| hat_d | floor tiles, sky | 1.15 |
| hat_e (FOV 25) | relief wall | 1.11 |
| sub_a / sub_b | start, street | 1.00 / 0.98 |
| sub_c / sub_d | mural + mud walls, a wall up close | 0.98 / 1.07 |
| sub_e (FOV 25) | house wall and door | **1.28** |
| sub_f (FOV 25) | door + temple mural | 1.14 |

"Fine detail" is the mean absolute Laplacian of the frame. It also counts aliasing, which the
HD mips reduce, so a value under 1 can be the better picture. Up close and at FOV 25 the HD
textures are clearly sharper: wood grain, cracks, stone edges and relief outlines. At 844 px and
a normal distance the difference is small. The retail textures already come close to one texel
per pixel there, and the plan's 1024 cap means many world textures only got 2x (e.g.
`HouseWall03_1` goes from 512x256 to 1024x512). The gain grows with screen resolution: at 1440p
or 4K fullscreen a wall covers 2–4x more pixels than in these shots.

| | 1x (`?hd=0`) | HD |
|---|---:|---:|
| 01_Hatshepsut: page open → `level started` | 1.8 s | 3.8 s |
| 08_Suburbs: page open → `level started` | 1.8 s | 3.6 s |
| wasm heap after load, Hatshepsut | 315 MB | 436 MB (+121) |
| wasm heap after load, Suburbs | 307 MB | 441 MB (+134) |
| GPU textures (estimate, table above) | 77 / 66 MB | ~700 / ~580 MB |

Load times are with a warm HTTP cache from the local dev server. Over a network add the
archive's download: the level's share of the 345 MB deflate archive (lazy data fetches per file).
The heap only grows (Emscripten), so +120–135 MB is the transient decode and mip peak. It stays
allocated, but the engine frees the pixels after the upload.

**Open problems**
- Only two levels are built. Everything takes ~1.5 h of PBRify (`build` without `--levels`),
  then `mkdata` and a relink.
- GPU memory is ~10x per level at the plan. That is fine on a desktop GPU, but laptops and
  phones need either `tex_iNormalSize = 9` (the console knob above) or KTX2 (next steps).
- The 1024 cap limits big walls to 2x. `tex_iNormalSize = 11` (2048) together with a 4x plan for
  large world textures would show more, but costs ~4x the GPU memory for those textures.
- The normal and height maps are built but not rendered (needs the shim, which belongs to another
  agent's work).
- There is no per-texture method override yet (UltraSharpV2 for metal and weapons).
- TextureDAT2 colour drift rules it out; it is not a pipeline issue.
- `Initial.ini(88): Identifier 'gfx_fProbeRatio' is not declared` comes from line 88 of the retail
  `Initial.ini`, which sets a variable this engine doesn't declare. It is harmless and isn't from
  this branch: the copy only appends the `include`.
- SDXL, SUPIR and Flux weren't tried (resource limits on the shared Mac).

## Next steps

- **Normal maps**: brushes are done (above); models need per-vertex tangents and the model light
  vector, WebGPU needs the same variant in `gfx-webgpu.js`. Parallax from the height channel.
- **Client-side upscaling for BYOD** (the public bundle imports the player's own data, so no
  retail-derived archive can ship): run a small SR model (SPAN class, ~0.2 s per 256² on desktop
  GPUs) in WebGPU at texture load, or once at import, caching the results in OPFS.
- **KTX2 / Basis Universal**: the HD archive is RGBA8 deflate; GPU-compressed textures (BC7/ASTC
  via Basis) would cut both download and GPU memory by 4–8x, which is what makes 4x affordable on
  laptops and phones. Needs a compressed-texture path in the GL shim (upload as
  `compressedTexImage2D`) and the engine to skip its CPU mip generation for those.
- A diffusion pass over the whole world set (hours, overnight) if the sheets keep favouring it.
