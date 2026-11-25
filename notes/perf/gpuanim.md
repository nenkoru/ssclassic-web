# Scale track I: GPU model animation and instancing (`?gpuanim`)

Branch `t3/2e663f33`. New file `port/common/GpuAnim.cpp`. Shim ops in `port/common/gl1shim.c`,
the replayer side in `port/web/gfx.js` (GA_VS / GA_FS / `gaOp`), the switch in `port/web/pre.js`,
and two hooks in `src/SamTFE/Sources/Engine/Models/RenderModel.cpp`. Switch: `?gpuanim=0|1`, or
the console var `mdl_bGpuAnim`. It is on by default; WebGL2 only.

## What was slow and why

For every model, every frame, `RenderModel_View` runs the whole vertex pipeline on the engine
worker:

1. **UnpackFrame:** decompress and lerp the 8/16-bit frame vertices, build normals from the
   sin/cos tables, and shade them against the model light.
2. **ShadesToColors:** turn the shades into colours.
3. **Surface setup:** gather the surface vertices, compute the texture coordinates, and multiply
   the colours per surface.
4. **Draw:** one `drawElements` per surface, per model, after the shim copies the vertex, colour
   and texcoord arrays into its arena.

The main thread then uploads that whole arena again and replays one draw per surface per model.
With thousands of monsters, both threads scale linearly with the number of visible vertices:

- Track D's frame cache (notes/perf/models.md) removed the duplicate unpacks. The per-instance
  shading, colour and arena copy are still there.
- At stress2000, r1 spends about 31 ms on the worker and 5.3 ms on the main thread per frame.

## The change

A plain opaque model no longer goes through `RenderModel_View`. Instead:

- **Frames, once per model** (`GA_FRAMES`). Every frame of the model data goes into one RGBA16I
  texture, one texel per frame vertex:
  - 16-bit models: x, y, z and the packed H|P normal angles;
  - 8-bit models: x, y, z and the gouraud normal index.

  The texture is at most 2048×2048 texels, so frames × vertices must stay under about 4M.
- **Mesh, once per mip** (`GA_MESH`). Per surface vertex: the mip vertex, the surface index and
  the texcoord (float bits). Plus the elements as u32, for the leading run of visible surfaces.
- **Tables, once** (`GA_TABLES`). The 256-entry sin/cos table and the 256 gouraud normals, in a
  256×2 RGBA32F texture.
- **Instance record, per model per frame.** 112 bytes, written into the batch's data arena:
  - frame bases (frame × vertex count) and the lerp ratio;
  - `mo_ColorMask`;
  - the 3×4 model-to-view matrix and stretch;
  - the model colour (`colMdlDiff`), `rm_vLightObj×-255`;
  - the light and ambient colours (10:10:10, after `AdjustColor`, the overbright clamp and
    iBright).
- **Batching.** Records queue per (model data, mip, texture, texture frame, mirror inversion,
  overbright).
- **Flush** (`GpuAnim_Flush`). The queue is flushed when the model view ends
  (`EndModelRenderingView`, before the simple shadows), or earlier, right before a model the CPU
  path draws with blending. That way, the translucent models still drawn by the CPU path land on
  top in the same order as before.

  Each batch sets the same state `SetRenderingParameters(OPAQUE/TRANSPARENT)` sets, then draws:
  - one instanced `drawElementsInstanced` with cull FRONT when the mip is double-sided;
  - one with cull BACK.

  Afterwards it leaves the state the CPU path leaves (LESS_EQUAL, depth write off, alpha test
  off, blend on, cull BACK).
- **The vertex shader** (`GA_VS`) mirrors the CPU formulas:
  - the lerp, `(p - center) × stretch`, the 16-bit normal from the sin/cos table or the 8-bit
    gouraud normal;
  - `shade = clamp(round(n · light))`, then `A + (L × shade >> 8)` clamped to 255;
  - the surface colour, `MultiplyRGBA` / `MultiplyRGBCopyA1`, fullbright surfaces (>>1 when
    overbright);
  - per-instance and per-surface colour-mask culling (`ms_ulOnColor` / `ms_ulOffColor` against
    `mo_ColorMask`, via a degenerate position).
- **The fragment shader** applies texture × colour, overbright ×2, and the alpha test against
  the shim's reference.

### Eligibility

A model takes the GPU path only if all of these hold, and otherwise renders on the CPU path
unchanged:

- the mip is `MMI_OPAQUE` and there is no forced translucency;
- the diffuse surfaces are `STT_OPAQUE` or `STT_TRANSPARENT`, with a diffuse texture;
- `RT_TEXTURE` is set, and no white-texture, no-fill or wireframe flags;
- no fog or haze, tessellation 0, no strips/triangles debug, not inside a mirror or warp;
- no bump, detail, reflection or specular layer is active.

Attachments are separate model objects: each one is checked on its own. Shadows (the simple
shadows, after the flush) and everything else are unchanged.

### Other notes

- **Resources** are kept per model data in an `unordered_map`:
  - they are rebuilt when the model's frame/vertex pointers or counts change;
  - models unused for 600 frames are dropped;
  - a freed blob stays alive 8 frames, because the threaded replayer runs a frame behind.
- **`?gpuanim` and WebGPU.** `pre.js` puts `?gpuanim` into `Module.se1GpuAnim`. On
  `se1gfx.backend !== 'webgl2'` the path never turns on (WebGPU stays on the CPU path), and
  `gfx-webgpu.js` skips the ops.

### Engine changes (src/, guarded by `__EMSCRIPTEN__`)

- `CModelObject::RenderModel`: try `GpuAnim_RenderModel` first, and fall back to
  `SetModelView` + `RenderModel_View`.
- `EndModelRenderingView`: `GpuAnim_Flush()` before the simple shadows.

## Results

Apple M-series Mac, headless Chrome, `tools/perfbench.mjs` (reps 3, 5 s per rep):

- **worker ms:** mean engine worker ms per frame;
- **main ms:** mean main-thread replay ms per frame (`Module.se1Replay`);
- **ref:** pre-round-1 `main`; **r1:** the round-1 perf merge;
- **new:** this branch; **new0:** this branch with `?gpuanim=0`.

| scenario | build | worker mean | worker p50 | worker p95 | main ms | fps |
|---|---|---|---|---|---|---|
| stress500 | ref | 5.96 | 2.01 | 14.8 | 1.97 | 60 |
| stress500 | r1 | 3.50 | 1.95 | 7.8 | 2.46 | 60 |
| stress500 | **new** | **3.34** | **0.90** | 10.3 | **0.89** | 60 |
| stress500 | new0 | 3.59 | 2.01 | 7.9 | 2.56 | 60 |
| stress2000 | ref | 43.6 | 5.1 | 179 | 4.76 | 19 |
| stress2000 | r1 | 31.2 | 34.8 | 66 | 5.29 | 23 |
| stress2000 | **new** | **20.8** | 31.2 | 54 | **0.57** | **33** |
| stress2000 | new0 | 29.7 | 34.3 | 66 | 5.22 | 24 |
| stress5000 † | **new** | **49.1** | **1.9** | 191 | **0.59** | **16** |
| stress5000 † | new0 | 65.5 | 8.3 | 203 | 11.35 | 13 |
| demo | ref | 0.303 | 0.295 | 0.41 | 0.136 | 3288 |
| demo | r1 | 0.282 | 0.260 | 0.42 | 0.142 | 3537 |
| demo | **new** | **0.265** | 0.235 | 0.41 | 0.129 | 3756 |
| demo | new0 | 0.276 | 0.250 | 0.41 | 0.119 | 3611 |

- stress500 averages 5–6 reps over two runs, stress2000 averages 3.
- **† stress5000 can't hold 5000 monsters on any build.** The mod host's entity handle table
  (`MAX_HANDLES` 2048 in `port/common/Se1ModHost.cpp`) caps it at 2047 alive, so ref and r1 time
  out ("not ready"). For these rows I raised the cap to 8192 in a scratch build, not committed,
  and compared new vs new0 only. At stress2000 the p50 is above the mean on the CPU builds
  because the frame times there are bimodal.

**stress500 p95.** At stress500 the p50 render frame drops from 1.95 ms (r1) to 0.90 ms of worker
time, and the main thread from 2.46 to 0.89 ms. But the worker's p95 goes up, 7.8 → 10.3 ms.

The p95 frames are tick frames: every third frame carries a 20 Hz game tick (AI and movement). In
those frames, the same simulation work took ~9.5 ms with gpuanim and ~5.5 ms without. That is CPU
clock scaling: with the GPU path the worker sleeps ~95% of each frame, so its core clocks down
(the effect `WebFrame.cpp`'s adaptive spin describes). Its threshold is a work share of 35%, so
the spin doesn't kick in.

With `?spin=1`, 3 reps each:

| stress500 | gpuanim on | gpuanim off |
|---|---|---|
| worker mean | 1.76 | 2.48 |
| p50 | 0.53 | 1.24 |
| p95 | 4.7 | 5.3 |
| main ms | 0.49 | 1.78 |

That is a real win at every percentile. In one spin=0 rep, the clock happened to stay up: mean
1.99, p95 5.07.

**Share of the area.** Worker profile (`--profile`, stress500, one run per build), as a share of busy samples:

| | ref | r1 | new |
|---|---|---|---|
| `CModelObject::RenderModel` (incl. callees) | 21.9% | 30.9% | 4.0% |
| `CRenderer::RenderModels` (incl. callees) | 24.2% | 34.7% | 10.2% |

In ms, `RenderModel` takes about 1.31 ms in ref, 0.87 ms in r1 and 0.09 ms in new. In new, the
`UnpackFrame`, `put_vertices` and `shim_glDrawElements` model work is gone from the top list.
What's left in model rendering is `SetupModelRendering` (mip, lights, bbox; 2.0%) and
`FindModelLights` (2.3%). Collision (`ClipMove`, track F) is now the top item.

**Draws.** gaStats in stress500 shows about 10 instanced draws per frame for about 570 instances.
The demo has about 1.5 instances per draw: few repeated models and lots of level geometry, so the
gain there is small.

## Checks

- **Simulation.** `perfbench --check`: SAME simulation, 384 ticks, for r1, new and new0 vs ref.
  The path doesn't touch simulation state.
- **Frames** (`perfbench --shots`, demo, ref vs new): shotdiff passes all 8 frames.

  | Frame | Max channel delta | Pixels with any diff | Pixels with diff > 8 |
  |---|---|---|---|
  | t00300 | 1 | 0.000% | |
  | t00500 | 1 | 0.001% | |
  | t00700 | 1 | 0.008% | |
  | t00900 | 5 | 0.006% | |
  | t01100 | 53 | 0.010% | 0.004% |
  | t01300 | 58 | 0.012% | 0.003% |
  | t01500 | 118 | 0.005% | 0.001% |
  | t01700 | 15 | 0.006% | |

  I looked at enlarged crops: every pixel over 1 is on a particle, fireball or flame. Those vary
  between two runs of ref as well. Model pixels differ by at most 1 (float rounding in the
  lerp). The stress500 se1d shots with gpuanim 1 and 0 look the same.
- **Functional tests**, on the gpuanim build: `svtest`, `bottest` and `flowtest` all pass.

## Risks

- **Model data identity.** Resources are keyed by the `CModelData` pointer and checked against
  its frame/vertex pointers and counts. Data reloaded at the same address with the same arrays
  and different contents would draw stale frames. A frame-cache generation counter like track D's
  would close this.
- **Draw order of opaque models.** Instanced models draw at the end of the model view, not where
  they come in the model list. With depth testing that only matters at exact depth ties, for
  example coplanar attachments: the shots show no difference.
- **The projection** is read from the shim state at flush time. All models of one view share it,
  but a view that changed the projection between models would be wrong.
- **Large models.** Above 2048×2048 frame texels or 65535 vertices, a model stays on the CPU path,
  as do models with more than 64 surfaces.
- **Memory.** Frames are kept for every model data seen within the last 600 frames, as RGBA16I:
  8 bytes per frame vertex, so a 1000-vertex model with 300 frames takes 2.4 MB of GPU memory.
- **WebGPU** keeps the CPU path.

## Next ideas

- Port the path to `gfx-webgpu.js` (a storage buffer for the instances, the same shader in WGSL).
- Fog and haze in the shader. They are per-vertex texture lookups on the CPU path; doing them in
  the shader would let fogged levels take the GPU path.
- Translucent surfaces: sort the instances by depth inside a batch, and keep the engine order
  across batches.
- Simple shadows as instanced quads.
- Put the per-surface table into a uniform buffer, uploaded once per mesh instead of per draw.
- Frustum- and mip-level work on the GPU: per-instance mip selection is still CPU.
- Pacing: with the render this cheap, the worker idles and gets clocked down (stress500 p95, see
  above). Lowering the adaptive spin threshold in `WebFrame.cpp`, or spinning only around tick
  frames, would win back ~4 ms on the p95 (threading track L).
- Raise `MAX_HANDLES` in `port/common/Se1ModHost.cpp` (2048) so stress5000 can actually hold
  5000 monsters (it plateaus at 2047 alive; for the numbers above I raised it to 8192 in a
  scratch build only).
