# Global illumination: baked bounce light on the static levels

Status: prototype on branch `t3/prototype-global-illumination` (`port/common/Se1GI.cpp`, console
`GI_Compute()`). This note is the design, the engine hooks, the measured cost and the road to
shipping it. Paths are relative to `src/SamTFE/Sources/Engine/` unless they start with `port/` or `tools/`.

## 1. Summary

SE1 lights brush polygons with baked shadow maps: per polygon, one 1-bit mask layer per light, mixed
on the CPU into an RGBA texture whenever the polygon is about to be drawn. That's direct light plus
a flat per-sector ambient. There is no bounce light.

The plan is "radiosity from the lightmaps". It keeps the brief's approach with three changes, each backed by what the code
and the prototype showed:

1. **Gather on a coarse grid, not per shadow-map texel.** Indirect light is low-frequency. Every
   lit polygon gets a grid aligned with its own shadow map at a coarser shadow-map mip (cell about
   1 m; `gi_fCellSize`). It is bilinearly upsampled when the engine mixes the real shadow map. On
   KarnakDemo that is 1.0 M cells against 3.7 M mip-0 shadow-map texels (3.7x fewer rays), with
   no visible loss: indirect light has no sharp edges to lose (§5).
2. **Inject at mix time, not as a texture or a new layer.** The engine already re-mixes a polygon's shadow map from
   its layers whenever it is (re)cached. One call at the end of `CLayerMixer::MixOneMipmap` adds the
   indirect term. Animated lights, dynamic lights, mip selection, filtering, flat-shadow fast paths
   and the upload all keep working unchanged, and nothing new reaches gl1shim or the replayers.
3. **CPU (wasm) first, WebGPU compute later.** At 1 m cells, 64 rays and 2 bounces, KarnakDemo is
   129 M rays: 16.5 s on 4 wasm threads of an M3 Pro, or 0.8 s at the low tier (§5). The CPU path runs on the engine worker
   with direct access to the engine's data structures.
   WebGPU compute is the upgrade path for the high tiers (finer cells, more rays). It needs the
   same flattened buffers (triangles, BVH, grids) the CPU path already builds, so the CPU code is
   also the reference for it.

## 2. How direct light works today (engine hooks)

### Where shadow maps are calculated, stored and mixed

| What | Where |
|---|---|
| Per-light 1-bit mask layers (`CBrushShadowLayer::bsl_pubLayer`, with mips) | `Brushes/Brush.h:173` |
| Per-polygon shadow map: layers, mex offsets/size, first/last mip | `Brushes/Brush.h:202` (`CBrushShadowMap`), base `Graphics/ShadowMap.h` (`CShadowMap`) |
| Layers are saved in the `.wld` and read with the world | `Brushes/BrushShadows.cpp:198` (`ReadLayers_t`), `Brushes/BrushArchive.cpp:227` |
| Layers not in the file are queued (`ba_lhUncalculatedShadowMaps`) and calculated by ray-casting the world | `Brushes/BrushShadows.cpp:457` (queue), `Light/LayerMaker.cpp:884` (`CBrushPolygon::MakeShadowMap`), `World/World.cpp:621/647` (`Calculate[Non]DirectionalShadows`); the renderer calls the non-directional one each frame, `Rendering/Render.cpp:991` |
| Caching on demand: `Prepare()` picks a mip, `Cache()` allocates and mixes | `Graphics/ShadowMap.cpp:477`, `:88`, `:175` |
| Mixing: ambient fill, gradient, each layer (point/directional, masked or all-lit), filter, dither | `Light/LayerMixer.cpp:2420` (`CLayerMixer::MixOneMipmap`) |
| Dynamic lights mixed into a second buffer on top of the static one | `Light/LayerMixer.cpp:2648`, `Graphics/ShadowMap.cpp:185/223` |
| Flat shortcut: a polygon whose light is uniform keeps one colour, no texture | `Brushes/BrushShadows.cpp:597` (`IsShadowFlat`), `Graphics/DrawPort_RenderScene.cpp:406` |
| Upload (RGB5 unless `shd_bFineQuality`, else RGBA8) | `Graphics/ShadowMap.cpp:627/639` |
| Applied as `tex * shadow * 2` (blend `DST_COLOR, SRC_COLOR`): byte 128 = texture unchanged | `Graphics/DrawPort_RenderScene.cpp:651/696` |
| Uncache (frees memory and the GPU texture; the next draw re-mixes) | `Graphics/ShadowMap.cpp:262` |

### Shadow-map texel → world position, and back

`CLayerMixer::CalculateData` (`Light/LayerMixer.cpp:187-250`) gives the mapping for mip `m`:
texel `(u,v)` has its centre at mex `(u<<m) - sm_mexOffsetX + (1<<(m-1))` (same for v).
`bpo_mdShadow.GetSpaceCoordinates(bpl_pwplWorking->wpl_mvRelative, mex, v)` gives the
brush-relative position, and the brush entity's `en_mRotation` and position make it absolute (`:230`).
The reverse (world → shadow pixel) is in `CEntity::FindShadingInfo`, `Entities/Entity.cpp:1450-1462`.
The prototype takes three texel positions per polygon (origin, +u, +v) and builds the dual basis, so
any world point on the polygon maps to grid coordinates with two dot products (`Se1GI.cpp TexelPos`).

### Brush polygons, triangles and albedo

- Brushes: `CWorld::wo_baBrushes.ba_abrBrushes` → `CBrush3D::GetFirstMip()` → `bm_abscSectors` →
  `bsc_abpoPolygons` (`Brushes/Brush.h`, `BrushArchive.h:31`). The world is `_pNetwork->ga_World`.
- Triangles: `bpo_aiTriangleElements` into `bpo_apbvxTriangleVertices[i]->bvx_vAbsolute`
  (`Brushes/Brush.h:435-436`). Plane: `bpo_pbplPlane->bpl_plAbsolute`. Its normal faces the visible side.
- What blocks light: the prototype treats a polygon as solid unless it is `BPOF_INVISIBLE`,
  `BPOF_DOESNOTCASTSHADOW`, `BPOF_PORTAL` or `BPOF_TRANSLUCENT`. That mirrors what the engine's own
  shadow caster ignores.
- Albedo: the average colour of `bpo_abptTextures[0]`'s texture (`CTextureData::td_pulFrames`, the
  mip at or under 32x32, alpha-weighted), times the layer colour `bpt_colColor`. Frames of
  non-static textures are freed after their first upload (`Graphics/Texture.cpp:1410`). The prototype
  then loads a private copy (`CTextureData::Load_t`) and caches one colour per texture.
- Full-bright polygons (`BPOF_FULLBRIGHT`: sky, lava, light panels) emit `albedo * gi_fFullbright`.

### Where the indirect term goes in (prototype hooks, all `#ifdef __EMSCRIPTEN__`)

| Hook | Where | What |
|---|---|---|
| `SE1GI_AdjustAmbient` | `Light/LayerMixer.cpp:2447` | scales the sector ambient fill by `gi_fAmbient`: the flat ambient was the old stand-in for bounce light |
| `SE1GI_AddIndirect` | `Light/LayerMixer.cpp:2552` | after all static layers, before dark gradients, filtering and dithering: adds `E_ind * 128 * gi_fStrength`, bilinear from the grid, to every texel of the mip being mixed |
| `SE1GI_PreventsFlat` | `Brushes/BrushShadows.cpp:612` | a polygon with indirect light is no longer "flat" |
| `SE1GI_AddModelAmbient` | `Rendering/RenderModels.cpp:564` | models: see below |
| `SE1GI_DeclareSymbols` | `Engine.cpp` (next to `con_bNoWarnings`) | console variables and functions |

After a bake (or a cvar change, `GI_Refresh()`) every affected shadow map is `Uncache()`d. The
next frame that draws it re-mixes it with the indirect term and uploads it. That's the same path the engine
takes when it evicts shadow maps under memory pressure.

### Dynamic lights and models

- **Dynamic lights** (`LSF_DYNAMIC`: muzzle flashes, explosions, projectiles) are mixed into a
  second buffer on top of the static one (`MixOneMipmapDynamic`, `LayerMixer.cpp:2648`). It starts
  as a copy of the static map, indirect term included, so dynamic lights keep working and stay
  direct-only. Bouncing dynamic lights is out of scope; the cost would be per frame.
- **Animated static lights** (flicker, pulsing) are mixed per frame from their current colour. The
  bake uses the colour at bake time, and the indirect term doesn't animate. That's acceptable for flicker. A
  light that switches off would leave its bounce behind; the ship version should bake those lights
  into a separate indirect layer scaled by the light's current intensity (§7).
- **Models** don't sample the mixed shadow map. `CRenderer::FindModelLights`
  (`Rendering/RenderModels.cpp:329`) takes the polygon under the model (`en_psiShadingInfo`,
  found by `CEntity::FindShadingInfo`). It sums each layer's light with `GetLightStrength` at the
  model's shadow-map pixel, and the sector ambient (`:414`). The hook adds the bilinear indirect
  term at that pixel to the model's ambient (`slSAR/G/B`) and scales the sector ambient by
  `gi_fAmbient` the same way. A monster standing on a red-lit floor picks up red fill light.
  Terrain (TSE only) and full-bright floors keep their old path.

### Determinism

The baked term only changes `sm_pulCachedShadowMap` (a render cache) and the model colour computed
inside the renderer. No entity, gameplay code or network message reads either (grep of
`src/SamTFE/Sources/Entities` and `Game` for `si_pbpoPolygon|GetLightStrength|bpo_smShadowMap`:
nothing). `port/common/SimHash.cpp` doesn't hash them. So GI can differ between clients (another tier,
or no GI at all) and multiplayer stays in sync. Bake results don't even have to be bit-identical
across machines.

## 3. The algorithm (prototype)

1. **Collect.** For every brush entity with `RT_BRUSH` (not field brushes, not hidden): its first
   brush mip's polygons. Solid ones go into a triangle list. Lit ones (solid, not full-bright, a
   shading shadow map) get a grid at mip `m`, the coarsest shadow-map mip whose texel is at most
   `gi_fCellSize`.
2. **Direct light per cell.** Let the engine mix the shadow map at mip `m` (`Cache(m)`), read the
   bytes, subtract the sector ambient (it isn't re-emitted), divide by 128 and `Uncache()`.
   The engine's own mixer does this, so gradients, directional lights and masks match what the
   player sees exactly.
3. **BVH.** Binned SAH, 16 bins, leaves of at most 4 triangles. Two-sided Möller-Trumbore. Back faces are told apart by the
   polygon plane.
4. **Gather.** Per cell: `gi_iRays` cosine-weighted, stratified rays with a per-cell random rotation.
   They start 5 cm above the cell centre. A hit on polygon P brings back
   `albedo(P) * (E_direct + E_indirect_prev)(P, hit)`, bilinear on P's grid. With a cosine pdf, the
   mean over the rays is the irradiance in shadow-map units. Misses (sky, void) bring nothing (§7: sky light).
   `gi_iBounces` passes; pass k uses the indirect term of pass k-1.
5. **Cells inside walls.** A cell centre outside its polygon can end up inside geometry. If more than 25% of
   its rays hit back faces, it's marked invalid and refilled from valid neighbours, so bilinear
   filtering at polygon edges doesn't pull in black.
6. **Denoise.** A 3x3 binomial blur inside each grid.

## 4. Running the prototype

```
node tools/se1d.mjs open '?args=%2Blevel%20Levels/KarnakDemo.wld'   # ?level= only works for survivors/archipelago
node tools/se1d.mjs eval 'Module._SE1Mod_DebugSkipIntro(); 1'
node tools/se1d.mjs cmd 'gi_iThreads=4; GI_Compute();' --ms 60000   # bake; prints counts and timings
node tools/se1d.mjs cmd 'GI_Pose(840.0, 2.0, 2049.0, 0.0);'       # FLOAT literals: '2049' fails the shell's type check
node tools/se1d.mjs cmd 'gi_bEnable=0; GI_Refresh();'  # before
node tools/se1d.mjs cmd 'gi_bEnable=1; GI_Refresh();'  # after
```

Cvars: `gi_iRays` (64), `gi_iBounces` (2), `gi_fCellSize` (1.0 m), `gi_fStrength` (1.0),
`gi_fAmbient` (0.5), `gi_fFullbright` (0.5), `gi_fAlbedo` (1.0).
`gi_iThreads` (4), `gi_fSky` (0) with `gi_colSky`. `GI_Where()` / `GI_Pose(x,y,z,heading)` place
the player for matched before/after shots. `GI_Clear()` drops the bake.

## 5. Measured (prototype)

KarnakDemo (demo data), `build-gi` (`tools/optbuild.sh build-gi`, `-O3`, threaded), headless
Chrome on an M3 Pro (36 GB), `gi_iThreads=4`, 2026-11-26.

| | low | default | high |
|---|---|---|---|
| cvars | `gi_fCellSize=2 gi_iRays=16 gi_iBounces=1` | `1.0 / 64 / 2` | `1.0 / 128 (121 used: strata are n x n) / 2` |
| GI cells | 445,703 (27,730 inside walls) | 1,005,806 (54,194 inside walls) | 1,005,806 |
| rays | 7.1 M | 128.7 M | 243.4 M |
| setup (collect, grids, albedo) | 102 ms | 106 ms | 103 ms |
| direct (engine mixer at the grid mip) | 8 ms | 21 ms | 17 ms |
| BVH | 5 ms | 7 ms | 5 ms |
| gather | 694 ms | 16,360 ms | 21,249 ms |
| throughput | 10.3 Mrays/s | 7.9 Mrays/s | 11.5 Mrays/s |
| **total** | **0.8 s** | **16.5 s** | **21.4 s** |

- Scene: 5,357 brush polygons (4,830 receivers, 1,052 with flat shadow maps today), 16,390
  triangles, 11,485 BVH nodes. 3.70 M shadow-map texels at mip 0.
- Mean direct 0.374, mean indirect 0.105 (1.0 = shadow byte 128): bounce adds about 28% of the
  direct light on average, concentrated in shaded areas. (The low tier's mean direct, 0.528, differs
  because the means are per cell, and at 2 m the small, bright polygons weigh more.)
- Throughput is 2-3 Mrays/s per wasm thread. The default run's 7.9 Mrays/s was the first bake
  after load (cold caches, textures loading for albedo); the warm high run reached 11.5.
- Memory: the renderer process's RSS went from 542 MB to a 648 MB peak during the default bake (+106
  MB, sampled every second). The grids are 3 float RGB arrays per cell (direct, indirect, new):
  1 M cells x 36 B = 36 MB. The rest is albedo textures loaded through `Load_t`, the BVH and the thread
  stacks. After the bake, the direct and indirect grids (24 B per cell) stay for mix time. RSS
  after the bake was not measured separately.
- Applying it: `GI_Refresh()` uncaches the 5,357 shadow maps, and they are re-mixed lazily as they are drawn.
  The per-texel cost at mix time is one bilinear lookup and three adds. Frame-time impact of the
  re-mix wave was not measured (§8.1 spreads it over frames anyway).
- Visual result: `data/dev/shots/gi-karnak/` in the main checkout (not committed). It has
  `sheet.png` (all six viewpoints, off | on), and `v*_off.png` / `v*_on.png` / `v*_a0.5.png` pairs at
  the same poses. Indoors (v0, v1), the torches now light the ceiling, the back wall and the
  shadowed recesses warmly: +12-19% mean brightness, all of it in areas that were black. Outdoors with
  `gi_fAmbient=1.0`, the sunlit courtyard washes out (+35-40%): the mappers' sector ambient
  already stood in for bounce, so it is counted twice. With `gi_fAmbient=0.5` (now the default), the
  overall brightness stays within 4-9% of today's. The flat fill becomes directional bounce:
  walls facing the lit floor brighten and undersides stay darker. `gi_fAmbient=0.25` is darker than today.
- Seen in the shots but not caused by GI: a large black triangle in the lower left of the
  courtyard views appears with GI off too, right after a teleport. It's an existing rendering glitch to look at separately.

## 6. Cost model

Rays = cells x `gi_iRays` x `gi_iBounces`. Cells scale with lit surface area /
`gi_fCellSize`^2, with a floor: the grid can't go coarser than the polygon's last shadow-map mip
(`sm_iLastMipLevel`; `port/common/Se1GI.cpp`, the mip choice in `GI_Compute`). So small polygons keep
the same cell count, and going from 1 m to 2 m cells only cut KarnakDemo's cells 2.3x, not 4x.

| Level size (lit area) | cells at 1 m | default tier (64 x 2) on 4 wasm threads | low tier |
|---|---|---|---|
| small (KarnakDemo-like) | ~1 M | ~16 s | ~1 s |
| large retail level (2-3x) | 2-3 M | 35-50 s | 2-3 s |

- Per ray: ~0.4 µs per thread in wasm (BVH of 16 k triangles). Traversal cost grows about with log(triangles).
- WebGPU compute (estimate, not measured): a software BVH tracer in WGSL on an M3 Pro GPU
  does roughly 200-500 Mrays/s on scenes this small, which would make the default tier 0.3-0.6 s and the
  high tier about 1 s. The data is already flat: triangles, nodes, polygon records and grids.
- Cache size: 1 M cells x RGB9E5 (4 B) = 4 MB per level at the default tier, or ~1 MB at the
  low tier. That is larger than §8 guessed, but fine for IndexedDB. With zstd/deflate it is smaller
  still, since the grids are smooth.
- Determinism isn't needed (visual only), so threads can split the work any way.

## 7. Quality tiers

| Tier | Bake | Apply | Use |
|---|---|---|---|
| off (potato) | none | today's look | default on phones, `?gi=0` |
| low | 2 m cells, 16 rays, 1 bounce, CPU, 4 threads: **0.8 s** on KarnakDemo | mix-time add, `gi_fAmbient=0.5` | default desktop when nothing is cached; bakes during level load |
| default | 1 m cells, 64 rays, 2 bounces: **16.5 s** CPU (4 threads), ~0.5 s WebGPU (estimate) | mix-time add; `gi_fAmbient=0.5`, `shd_bFineQuality=1` (RGBA8 shadow maps, no RGB5 banding) | default desktop: low first, then default in the background, swapped in with a fade |
| high | 0.5 m cells, 256 rays, 3 bounces, sky light, per-texel albedo, WebGPU compute | as default plus an indirect layer for animated/switchable lights | strong GPUs |
| ultra | per shadow-map texel, 1k rays, WebGPU; also feeds a light-probe grid for models | probes for models instead of the floor sample | "show-off" |

The tier only changes the bake parameters and two cvars, never gameplay. The cache key includes
the tier, so switching tiers means another bake or another cached entry.

## 7b. Prebaked files (done for the dev builds)

`node tools/gibake.mjs [--cell 0.5] [--rays 256] [--bounces 3] Levels/<name>.wld ...` bakes each level in
se1d against a dev server for a build with the level's data (`tools/devserver.py` takes the upload:
`POST /__gi/Levels/<name>.gi` -> `data/gi/Levels/<name>.gi`). Copy the files to `<data dir>/GI/Levels/`
and relink: on every world load (`CWorld::Clear` hook) the engine looks for `GI/<world path>.gi`
on the first shadow-map mix and takes it if it matches (`GI: loaded ...` in the console; `gi_bLoad=0`
turns it off, `GI_Load()` retries).

- Format (`Se1GI.cpp`, "bake files"): a 32-byte header, one 16-byte record per lit polygon (brush
  entity ID, sector, polygon, mip and grid size) and one RGB9E5 word per cell. Entity IDs come from
  the world file, so spawn-flag filtering (difficulty, coop) doesn't shift the keys. A polygon whose
  shadow-map size differs from the bake means the world changed, and the file is refused.
- Big files go through lazy data like the rest of the data (fetched on demand when the level loads).
- KarnakDemo at 1 m: 4.1 MB, loaded in 18 ms. The picture matches a live bake (mean pixel difference
  1.4 against 9.4 for GI off).

## 8. Toward shipping

1. **Bake on level load, off the critical path.** Hook after `CWorld::Load_t` succeeds
   (`Network/Network.cpp:1052/1693/1704/2420` all go through `CNetworkLibrary` level start; the mod
   host already has `SE1Mod_LevelStarted`). Start the bake there on worker threads and keep
   rendering without GI. When it's done, `Uncache()` the affected shadow maps (a few per frame to
   spread the re-mix and re-upload) and fade it in with `gi_fStrength` 0 → 1 over a second.
2. **Cache.** Key: SHA-1 of the `.wld` bytes, plus the bake version, the tier and the GI cvars. Value: the grid
   header (polygon order is stable: brush, sector, polygon index in the file), then the cells as
   RGB9E5 or RGBA16F. 1 m grids are ~4 MB per level as RGB9E5, ~1 MB at the low tier (§6). Stored in IndexedDB from the
   page (the engine worker posts the blob; `port/web/` already persists user data in IndexedDB for
   the BYOD build, `notes/user-data.md`). Nothing retail-derived ships: every player bakes from
   their own data. For the `full` dev build, an offline bake (the same code, run headless over
   all levels by a tools/ script) can prefill the cache.
3. **Progress UI.** The bake reports cells done / total through the existing console bridge. The page shows a small
   "Baking light 43%" chip (in `port/web/`, not in the engine). It never blocks play.
4. **WebGPU compute path.** Upload the flattened triangle list, BVH nodes, polygon records (grid
   origin, dual basis, albedo, emit) and the direct grid as storage buffers. One dispatch per bounce
   with one invocation per cell, which loops over its rays. Read back the indirect grid. This needs a
   compute-capable device in the worker (`navigator.gpu` works in workers). It is separate from the
   render replayer's device, so no hook in `gfx-webgpu.js` is required. WebGL2-only browsers use the CPU path.
5. **Quality.**
   - Per-hit texture albedo instead of the per-polygon average. It needs per-hit UVs (`bpo_abptTextures[0].bpt_mdMapping`) and a small texture atlas.
   - Animated and switchable lights get their own indirect layer, scaled at mix time by the light's current colour, as the layers already are.
   - Sky light from the level's background (WorldSettings / sky entity colour) instead of the `gi_colSky` constant.
   - Linear-space albedo and light, with gamma-correct mixing.
   - Shadow maps at RGBA8 (`shd_bFineQuality`), so the gentle gradients don't band.
6. **Models.** Today models take the indirect term at the floor point under them, as SE1
   already does for direct light. Upgrade: a sparse irradiance-probe grid (SH L1 per probe) baked
   from the same BVH, sampled at the model centre. That handles flying monsters and keeps directional fill.
7. **Brush mips and moving brushes.** Only each brush's first mip is baked. Lower brush mips (rare)
   and moving brushes (doors, lifts; they're baked where they stand at load) need handling. Moving brushes should
   probably be excluded as occluders and receive only the term at their start position.
8. **Multiplayer.** Visual only (§2, Determinism). Each client bakes and caches on its own, and the server
   needn't know. A dedicated server (`rust/se1-server` / headless) never bakes.
