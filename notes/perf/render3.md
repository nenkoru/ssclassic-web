# Perf round 3, model rendering on the engine thread

Branch `t3/optimize-crowd-model-rendering`, base `51645f2`. Area: `CRenderer::RenderModels()` and
what it calls per model (`src/SamTFE/Sources/Engine/Rendering/RenderModels.cpp`) and the GPU
animation queue (`port/common/GpuAnim.cpp`). Earlier rounds of this area: `models.md`, `models2.md`
(CPU unpack and shading, GL shim), `gpuanim.md` (instanced GPU animation). This round does not
change any of those.

## Where the time went

stress500, base profile: `RenderModels` is 12.5% of the engine thread inclusive. Its time is spread
over many functions: `FindModelLights` 3.0%, `CModelObject::RenderModel` 5.7% (of which
`GpuAnim_RenderModel` is about 1.6%), `SetupModelRendering` and `CreateAttachment` about 3%, and
the delayed-model sort 0.5%. `AddModelEntity` (2.2%) runs from the sector walk, not from here.

A temporary counter build measured, per frame:

| | per frame |
|---|---|
| `FindModelLights` calls (all on the polygon path) | 163 |
| different polygons under those models | 8 |
| shadow layers walked | 4187 (about 26 a call) |
| lights pushed | 622 |
| layers rejected by the shadow map (`< 0.01`) | 687 |
| layers rejected by the falloff distance | about 2880 |
| animated / directional lights among the layers | 0 / 16 |
| delayed models | 206 |

So `FindModelLights` walked the same few layer lists again for every model. For each layer it
chased the list node, the light and the light's entity, called `GetLightColorAndAmbient()`, and
read the layer's shadow bitmap (`GetLightStrength()`), even though about 70% of the layers were then
dropped because the model was out of the light's range.

## What changed

1. **Per-polygon layer cache in `FindModelLights`.** During one `RenderModels()` pass, the
   layers of a polygon are gathered once, on first use, into a dense array. Each entry holds the
   layer, the light, its colour and directional ambient (with running sums), flags, falloff,
   hotspot and position. A 256-slot hash table maps the polygon to its entries, keyed by a pass
   counter, so a new pass starts empty. If the table is full, the call runs the original loop.
   - *Exact because* nothing cached can change during a pass: lights and brushes don't move
     while models render, and an animated light's colour depends only on the render time.
     `GetLightStrength()` is still called through the layer pointer.
   - The directional-ambient sum seen by a `LSF_SUBSTRACTSECTORAMBIENT` light is the running sum
     up to that layer. These are integer sums, so the values are the same as the original's.
2. **Falloff first, four layers at a time.** For an omni light with an entity, the falloff test
   runs before `GetLightStrength()`. Both tests are pure, and either one rejects the layer, so
   swapping their order changes nothing. Directional lights, and lights without an entity, keep
   the original order.
   - `Length() > fFallOff` is `(FLOAT)sqrt((DOUBLE)s) > fFallOff`, where `s` is the float sum of
     squares. That expression never decreases as `s` grows. So it is true exactly when `s` is
     above `FallOffThreshold(fFallOff)`: the largest float that still passes, found once per
     light with `nextafterf`. Odd ranges (≤ 0, NaN, huge) get +inf and go to the exact code.
   - The test runs in wasm SIMD on four layers at once. Each lane does the same float operations
     as `Length()`, in the same order. wasm has no FMA or extended precision, so `s` is the same
     bit for bit. A NaN `s` is kept, as the original keeps it.
   - The layers that pass run the original per-layer code, in the original order. The pushed
     lights and the float sums therefore match the original exactly.
3. **`IsOfClass(&en, "Player Weapons")` without a `strcmp` per model.** The answer is cached per
   class-name pointer, in 16 entries. Class names are static strings.
4. **Delayed-model sort skipped when the keys are already strictly increasing.** This happens in
   the second pass of a frame that has a background pass. When the keys are all distinct, there is
   only one sorted order, so the sort could only leave the array as it is. Any tie or NaN still
   runs `se1_qsort`.
5. **`GpuAnim_RenderModel`: 16-entry cache in front of the `_models` hash map.** A crowd looks up
   the same few model datas, and their attachments, hundreds of times a frame. The cache is
   cleared whenever an entry leaves `_models` (`SE1_GpuAnim_Forget`, idle housekeeping).

## Verification

**Verify builds.** These ran the original layer loop and the new one on every
`FindModelLights` call, then compared the return value, `colLight`, `colAmbient`,
`fTotalShadowIntensity`, `vTotalLightDirection`, `plFloorPlane` and every pushed `ModelLight`
with `memcmp`:

| build | run | calls | lights pushed | mismatches |
|---|---|---|---|---|
| cache, scalar falloff | stress500 | 382,975 | | 0 |
| cache, scalar falloff | timedemo (whole) | 1,339,449 | | 0 |
| final (SIMD falloff) | stress500 | 587,673 | 2,263,926 | 0 |
| final (SIMD falloff) | timedemo (whole) | 1,373,966 | 1,458,006 | 0 |
| final (SIMD falloff) | stress1000, kind 2 | 739,792 | 3,874,503 | 0 |

**Simulation.** `perfbench --check` gives "SAME simulation, 384 ticks".

**Frames.** `bench.mjs --shots` base vs new, then `shotdiff.py`: 8/8 frames ok, 5 of them
bit-identical. The largest difference is 0.002% of pixels. Same-build runs already vary that
much (muzzle-flash pixels, ≤ 0.01%).

## Numbers

The whole-frame bench can't see this change. `RenderModels` is about 12% of the engine thread,
and paced runs vary by ±5% between reps:

| scenario | build | mean ms | p50 | p95 | speedup |
|---|---|---|---|---|---|
| demo | base | 0.267 | 0.240 | 0.400 | 1.00x |
| demo | new | 0.272 | 0.245 | 0.415 | 0.98x |
| stress500 | base | 3.193 | 1.425 | 9.345 | 1.00x |
| stress500 | new | 3.147 | 1.330 | 9.665 | 1.01x |
| stress1000 | base | 4.184 | 0.905 | 12.470 | 1.00x |
| stress1000 | new | 4.115 | 0.955 | 12.690 | 1.02x |

(`perfbench --reps 2`; the machine was shared with other work, so the absolute numbers are higher
than in earlier rounds.)

**Direct measurement.** A temporary A/B build timed `RenderModels()` with `emscripten_get_now()`
and switched between the original and the new code paths every 64 frames, on the same running
game. Each line averages 1280 frames, and the first (spawn) window is left out:

| scenario | original µs/model | new µs/model | change |
|---|---|---|---|
| stress500 | 2.17–2.26 | 1.93–2.03 | −10.5% (about 45 µs of ~450 µs a frame) |
| stress1000 | 1.54–1.56 | 1.34–1.37 | −12.5% (about 70 µs of ~540 µs a frame) |

The parts were measured the same way. The cache (with the class and sort changes) gave −10.6%.
The SIMD falloff test, compared with the cache alone, gave −6%.

A build that called `FindModelLights` twice per model put its cost at about 100 µs a frame
before this change and about 50 µs after. What is left is mostly the shadow-bitmap reads of the
layers in range and the per-model totals after the loop.

## Not done, or rejected

- `CRenderer::ScanOneLine` (3–4% self): this is the world span scan, not model rendering, and
  `visibility.md` already worked on it.
- `CreateAttachment` building its OBB lazily, caching `MakeRotationMatrixFast` per attachment,
  `CAnimObject::GetFrame`, `AddModelEntity`: each is under 1% of the frame and mostly memory
  reads. An exact change would save a few µs at most.
- A radix sort for the delayed models, with a fallback on ties: the sort is about 0.5% of the
  frame, and the skip in item 4 already covers the second pass.
- Caching the surface-translucency check in `GpuAnim_RenderModel` per mesh: a model's mapping
  surfaces could change without the mesh's pointers changing, so the cached answer could go
  stale. Small win, not worth the risk.
