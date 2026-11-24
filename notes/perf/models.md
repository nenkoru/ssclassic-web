# Perf track D: model rendering

Branch `t3/optimize-model-rendering`, commits `20a73a5` and `64308dd`. Area: `UnpackFrame` and
`CModelObject::RenderModel` (`src/SamTFE/Sources/Engine/Models/RenderModel_View.cpp`),
`FindModelLights`, and `put_vertices` / `shim_init` in `port/common/gl1shim.c`.

## What was slow and why

stress500 puts 500 animated monsters of a few kinds on screen. `RenderModel_View` redid the whole
per-vertex pipeline for every instance:

- **UnpackFrame** decompresses the mip's vertices from the 8- or 16-bit frame (or two frames, when
  lerping). It builds the normal from the sin/cos tables, takes the dot with the light, and stores
  the shade. It was 9.2% self in ref.
- It then turns the shades into colours, gathers surface vertices from mip vertices, computes the
  diffuse texture coordinates, and multiplies the colours per surface.

But many instances show the same animation frame in the same rendered frame: about 70% of the
unpacked vertices were duplicates. Vertex positions, normals, surface vertices and texture
coordinates don't depend on the instance (its placement goes through the modelview matrix), only
on:

- the frame pair and lerp ratio,
- stretch and offset,
- the mip.

The shades and colours do depend on the instance's light.

In the GL1 shim, `shim_init()` was a real call made by every entry point: 0.4% of stress500 and
2.1% of demo.

## Changes

1. **Per-frame unpack cache** (`20a73a5`).
   - **Key:** frame0, frame1, mip, ratio bits (only when lerping), stretch and offset bits.
   - **Stored per entry:** mip vertices, normals and surface vertices, in a chunked arena (4 MB
     chunks, at most 16) with a 2048-slot open-addressing index (at most 1024 entries).
   - **Reset:** on a new `gl_iFrameNumber`, and whenever model data changes. A generation counter
     is bumped in `CModelData::Clear`, `ClearAnimations` and `PrepareModelForRendering`.
   - **On a hit:** the instance only computes its shades from the cached normals, with the same
     float expression as UnpackFrame.
   - **On a miss:** UnpackFrame runs as before and fills the entry, always keeping normals.
   - **Off switch:** `mdl_bUnpackCache` (C global, not a console var).
2. **Shared diffuse texcoords** (`64308dd`). They depend only on the mip and on the texture-size
   corrections (`fTexCorrU/V`, compared bitwise), so they are cached per frame in the same arena.
   Up to 64 entries.
3. **SIMD shading on hits** (`64308dd`). Shades and colours are computed 4 vertices at a time with
   wasm SIMD, bit-exact because it keeps the scalar arithmetic:
   - the same `(x*LX + y*LY) + z*LZ` order;
   - the same `f + copysign(0.5, f)` rounding, truncated;
   - the same truncation to SWORD and 0..255 clamp;
   - `pubClipByte`, replaced by a clamp to 0..255, which is what the table holds over its
     -512..1023 index range.
4. **SIMD diffuse surface colours** (`64308dd`). `MultiplyRGBCopyA1` is done 4 at a time with
   u8→u16 multiply, `>>8` and narrow. The products are at most 254, so the narrow never saturates.
5. **`shim_init` inline check** (`64308dd`). The check is inline and the one-time setup is out of
   line.

`put_vertices` was reviewed and already copies each client array per draw with one memcpy over
the used vertex range. Sharing copies across instances would need base-vertex draws in the shim,
so it is left as is. `FindModelLights` (about 1%) was left alone.

## Numbers

`perfbench --check --reps 3 --scenarios stress500,demo`, engine-thread CPU ms per frame. Other
tracks were benching on the same machine at the same time, so treat about ±3% as noise.

| scenario | build | mean | p50 | p95 | speedup |
|---|---|---|---|---|---|
| stress500 | ref | 6.119 | 2.150 | 14.770 | 1.00x |
| stress500 | v1 (`20a73a5`) | 5.960 | 1.915 | 14.920 | 1.03x |
| stress500 | v2 (`64308dd`) | 5.845 | 1.785 | 14.880 | 1.05x |
| demo | ref | 0.310 | 0.305 | 0.425 | 1.00x |
| demo | v1 | 0.315 | 0.305 | 0.440 | 0.98x |
| demo | v2 | 0.312 | 0.305 | 0.430 | 0.99x |

- **stress500:** p50 (render-dominated frames) drops 17%. p95 is the 3-frame simulation ticks
  (AI, ray casts, collision), which are outside this track.
- **demo:** unchanged within noise. It has few model instances, and they rarely share a frame.

Profile, engine worker self time (`--profile`):

| stress500 | ref | v2 |
|---|---|---|
| RenderModel inclusive | 21.7% | 14.9% |
| UnpackFrame | 9.2% | 3.1% (cache misses, about 20%) |
| RenderModel self | 6.7% | 5.2% |
| put_vertices | 2.8% | 3.1% |
| FindModelLights | 1.2% | 0.9% |
| shim_init | 0.4% | 0 (inlined) |

In demo, `shim_init` drops from 2.1% to 0. UnpackFrame (3.5% → 3.2%), RenderModel (4.6% →
4.9%) and put_vertices (5.0% → 5.1%) stay within noise.

## Behaviour check

- `perfbench --check`: **SAME simulation** for v1 and v2 (384 ticks, final 7d4eb99b).
- **In-engine verifiers.** A temporary verify build (not committed) recomputed every cached result
  the original way and compared bytes:
  - v1: 150k hits; vertices, normals, colours and surface vertices all bad=0.
  - v2: 100k SIMD shade hits, about 1.26M diffuse colour checks and 1.2M texcoord checks, all
    bad=0.
- **Screenshots** (`bench.mjs --shots`, `shotdiff.py`): v2 vs ref prints "8/8 frames ok (5
  bit-identical)", exactly the same as two ref captures compared with each other (ref vs ref2).
  The 3 frames that aren't bit-identical differ by at most 0.003% of pixels: flame and
  muzzle-flash frames, which vary between runs even for ref.

- **Functional tests** on the v2 snapshot, run one at a time:
  - svtest: all checks pass.
  - flowtest: all checks pass.
  - bottest: 7/7 pass on a rerun. The first run failed "bots move" and "bots fight", but bottest
    waits on wall-clock time and the machine was loaded by other tracks. ref failed it too under
    the same load, on "off by default".

## Risks

- **Cache staleness** if model data changes in a way that doesn't bump the generation. Covered:
  `CModelData::Clear`, `ClearAnimations`, `PrepareModelForRendering`. Not covered: an editor
  changing frames in place. It is reset every rendered frame anyway.
- **Pointer reuse:** if a `ModelMipInfo` is freed and reallocated at the same address within one
  frame, it would get a stale hit. Model data isn't freed mid-frame.
- **Memory:** the cache uses up to 64 MB of arena (16 × 4 MB). It is allocated lazily; when full,
  instances fall back to the uncached path.
- **SIMD bit-exactness** rests on wasm having no FMA and IEEE f32 lanes. The scalar `#else` path is
  unchanged for non-SIMD builds.

## Next ideas

- **SIMD for the UnpackFrame miss path** (3.1%). It is mostly gathers (sin/cos tables, Gouraud
  normal table), so about 1.5x at best, roughly 1% of stress500.
- **Fewer GL draws per model.** RenderOneSide → glDrawElements → put_vertices is about 5% of
  stress500 inclusive. Ideas:
  - a base-vertex path in the shim, so identical cached vertex arrays are uploaded once per frame;
  - instancing same-frame models (needs per-instance colours as an attribute).
- **Cache `FindModelLights` per entity** across rendered frames when neither the entity nor the
  lights moved.
- The bigger wins in stress500 lie outside this area: path-finding, ray casts and ClipMove are
  over 50% of the engine thread.
