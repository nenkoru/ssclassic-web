# Perf round 2, track H: model rendering and its GL submission

Branch `t3/939a1c55`, commits `d9aae33` (shim reuses shared model arrays) and `806920c` (SIMD
frame unpack). Area: `CModelObject::RenderModel`, `UnpackFrame` and `ShadesFromNormals`
(`src/SamTFE/Sources/Engine/Models/RenderModel_View.cpp`), `put_vertices`,
`bind_client_arrays` and `shim_glDrawElements` (`port/common/gl1shim.c`), and the replay on the
main thread (`port/web/gfx.js`, not changed). Round 1 of this area: `notes/perf/models.md`.

## What was slow and why

Measured in stress500 (500 animated monsters of a few kinds on screen) with temporary counters
(removed again), per rendered frame:

| | per frame |
|---|---|
| models rendered | 492 |
| unpack cache hits / fills / uncached | 410 / 81 / 0 |
| draws (`glDrawElements`) | 508, about one per model |
| surface vertices sent | 129.9k |
| mip vertices unpacked or shared | 88.4k |
| indices sent | 462k |

1. **The shim copied everything at every draw.** Round 1 made instances in the same animation
   frame share the unpacked vertices, normals, surface vertices and diffuse texture
   coordinates, so most of what 500 instances send is the same memory. The GL1 shim
   (`gl1shim.c`) still copied each client array into the batch's vertex streams at every draw,
   and the indices too (rebased onto the draw's base vertex). That was about 6 MB per frame
   recorded on the worker (`put_vertices` 7.2%, `shim_glDrawElements` 2.2% of engine self time
   in round 1), and the page then uploaded all of it again with `bufferSubData` on the main
   thread (replay p50 2.5 ms).
2. **Unpack-cache fills were scalar.** About 80 fills per frame of ~200 vertices each:
   `UnpackFrame` gathered each vertex through the mip-to-model index and the compressed-normal
   sin/cos tables one at a time, lerped two frames, then shaded every vertex again
   (`UnpackFrame` 6.5% self in round 1).

Colour arrays differ per instance (lighting), and there is about one draw per model, so the
colours are still copied (about 0.5 MB per frame).

## Changes

### `d9aae33` perf(gl1shim): copy shared model arrays once per batch and point later draws at them

- **Static-array contract.** `SE1_GL1Shim_StaticArray(p)` tells the shim "the bytes at `p` will
  not change until `SE1_GL1Shim_StaticReset()`". The engine declares the shared unpack-cache
  arrays (surface vertices, diffuse texcoords) and the model's element arrays (`FlushElements`)
  static. It resets when the unpack arena starts over (`UnpackCache_Check`), when a model's
  data is prepared (`PrepareModelForRendering`, only when it actually prepares) or cleared
  (`CModelData::Clear` / `ClearAnimations`, `MODEL_DATA_CHANGED`), and the shim resets at every
  present (`hand_off`). Pointers are kept in a 4096-slot open-addressing set; when it is half
  full, further arrays just are not reused.
- **Vertex reuse.** For a static source, `put_vertices` looks up (pointer, stream, first, count,
  size, type, stride) in `_vreuse` and, if this batch already copied that range, points the
  attribute at the earlier copy instead of copying again. The draw's base vertex is chosen among
  a few candidates (the batch cursor or the base of a reused stream) to need the fewest new
  attribute pointers, so a reused position stream and a fresh colour stream line up.
- **Index reuse.** `shim_glDrawElements` remembers where it wrote a static index array rebased
  onto a given base vertex (`_ireuse`) and points later draws with the same key at it.
- Reuse entries live for one batch (`batch_reset` → `reuse_forget`). `?vreuse=0` turns all of it
  off for A/B; `SE1_GL1Shim_ReusedBytes()` reports what was not copied.
- Result in stress500: 4.56 MB per frame no longer copied, 1.51 MB still is.

### `806920c` perf(models): unpack model frames 4 vertices at a time with wasm SIMD

- `UnpackFrame_SIMD` handles the four frame formats (16-bit and 8-bit vertices, with and without
  a lerp) four vertices per iteration: lane gathers through the mip-to-model index and the
  sin/cos tables (`wasm_*x4_make`), positions and normals lerped with the same float operations
  in the same order as the scalar code, and the shades turned into colours by `ShadeLanes`, which
  `ShadesFromNormals` now shares. A scalar tail handles the last 0 to 3 vertices.
- A lerp ratio of exactly 0 or 1 unpacks that one frame alone: the engine's `Lerp()`
  (`Engine/Math/Functions.h`) returns the end point itself for those ratios, so this gives the
  same values.
- Built only under `__wasm_simd128__`; other builds keep the scalar path.

## Numbers

`perfbench`, engine-thread ms per frame (`Module.se1Perf`: resume to swap). Every other track was
building and benching on the same machine at the same time, so means move by ±10% between runs
(r1's stress500 mean ranged 3.0 to 3.8 ms across my runs); compare within one run. `base` is my
branch's starting point (`15426e5`), `new0` is the final build with `?vreuse=0` (SIMD unpack
only), `new` is the final build (`806920c`).

Final run, `--check --reps 5 --scenarios stress500,demo`:

| scenario | build | mean | p50 | p95 | speedup vs ref |
|---|---|---|---|---|---|
| stress500 | ref | 6.040 | 2.015 | 15.000 | 1.00x |
| stress500 | r1 | 3.737 | 1.995 | 8.030 | 1.62x |
| stress500 | new | 3.758 | 1.720 | 9.150 | 1.61x |
| demo | ref | 0.299 | 0.290 | 0.400 | 1.00x |
| demo | r1 | 0.275 | 0.255 | 0.395 | 1.09x |
| demo | new | 0.273 | 0.255 | 0.390 | 1.10x |

Each change on its own, stress500, `--reps 3` (one run):

| build | mean | p50 | p95 |
|---|---|---|---|
| ref | 6.061 | 2.030 | 15.050 |
| base | 3.672 | 1.985 | 8.055 |
| new0 (SIMD unpack) | 3.600 | 1.955 | 8.070 |
| new (SIMD + shim reuse) | 3.685 | 1.680 | 9.080 |

**stress500 p95 goes up with the shim reuse, and it is the CPU clock, not more work.** The p95
frames are the simulation ticks (every third frame). With reuse they measure about 1 ms longer in
every run, although:

- the worker does less: busy samples (waits excluded) 2603 vs 2758 for `new0`, and per-frame
  timers (a temporary build) put `RenderModels` at 1.36 vs 1.53 ms on average and 1.60 vs 1.73
  ms on the slowest 5% of frames, with the shim's draw time halved;
- it waits no more: the hand-off wait (`batch_switch`) and the quad-buffer sync measured 0 ms in
  both, and the sync-proxy waits in the profile were fewer (134 vs 206 samples);
- with the worker kept busy (`?spin=1`, so it spins to vsync instead of sleeping) reuse wins
  everywhere, p95 included:

| stress500, one run | mean | p50 | p95 |
|---|---|---|---|
| new0, spin=0 (bench default) | 3.359 | 1.920 | 7.810 |
| new, spin=0 | 3.767 | 1.710 | 9.260 |
| new0, spin=1 | 2.395 | 1.190 | 5.160 |
| new, spin=1 | 2.231 | 1.020 | 5.120 |

stress500 is paced to 60 fps with lots of headroom. Reuse takes ~5% off the worker and about
half off the main thread's replay (below), so the CPU idles more of each frame, and macOS lowers
the clock or moves the sleeping worker to an efficiency core (`WebFrame.cpp` describes the same
effect on phones). The long tick frames then run slower in wall time. Every frame still makes
vsync; it costs nothing visible and saves power, but the bench's default metric reads it as a
loss. Under real load the clock stays up and reuse is a clear win:

| `--reps 3`, spin=0 | build | mean | p50 | p95 | fps |
|---|---|---|---|---|---|
| stress1000 | r1 | 5.564 | 2.170 | 13.245 | 60 |
| stress1000 | new0 | 5.537 | 2.040 | 13.450 | 60 |
| stress1000 | new | 5.682 | 1.905 | 14.765 | 60 |
| stress2000 | r1 | 29.984 | 34.570 | 65.700 | 24 |
| stress2000 | new0 | 29.490 | 34.055 | 65.305 | 24 |
| stress2000 | new | 26.143 | 33.210 | 64.345 | 26 |

(ref can't reach 1000 monsters within the bench's ready timeout, so r1 is the baseline here.)
stress1000 is still paced at 60 fps and shows the same clock effect; stress2000 is CPU-bound,
and there reuse cuts the mean 11% vs r1 and 2 fps up. For comparing perf work in paced
scenarios, `?spin=1` gives numbers that are closer to the work done.

- **demo:** within noise. Few model instances, which rarely share a frame.

**Main thread** (`tools/stress.mjs`, 500 monsters, one rep each, the replay of the recorded GL on
the page):

| | engine p50 | engine p95 | replay p50 | replay p95 |
|---|---|---|---|---|
| r1 | 5.92 | 10.61 | 2.53 | 3.71 |
| new (`d9aae33`) | 5.08 | 9.13 | 1.16 | 1.43 |

The replay halves: the page uploads 4.6 MB less per frame and binds fewer buffers.

Profile, engine worker self time (`--profile`, stress500, r1 vs new in the same run):

| | r1 | new |
|---|---|---|
| profiled mean | 2.761 ms | 2.633 ms |
| RenderModels inclusive | 35.6% (0.98 ms) | 28.9% (0.76 ms) |
| RenderModel self | 11.4% | 12.5% |
| put_vertices | 7.2% | 3.8% |
| UnpackFrame | 6.5% | 4.1% (reuse only: 6.4%) |
| shim_glDrawElements | 2.2% | 0.4% |
| FindModelLights | 1.6% | 2.0% |
| SetupModelRendering | 1.6% | 1.7% |
| AddModelEntity | 0.6% | 1.0% |

The model-rendering area costs 0.22 ms less per frame (−23%) in the profiled stress500 run.
Profiled runs measure lower means than unprofiled ones for every build (base 2.82 vs 3.67 ms):
the sampling profiler keeps the worker awake, so the clock stays up (see above).
`RenderModel` self is now the biggest single item; its share grows because the rest shrank.
`FindModelLights`, `SetupModelRendering` and `AddModelEntity` were not changed (their small
moves are noise). demo: `UnpackFrame` 3.9% → 2.5%, `put_vertices` 5.6% → 6.1% (noise; little
is shared there), the rest unchanged.

## Behaviour check

- `perfbench --check`: **SAME simulation** for both snapshots, in every run.
- **Shots** (`bench.mjs --shots`, `shotdiff.py`): new vs ref matches ref vs ref. 8/8 ok, the same
  5 frames bit-identical, the same 3 frames (t01100, t01300, t01500, muzzle flash) differ by
  ≤ 0.002% in both pairs.
- **Verifier build** (temporary, not committed): every reused vertex range and index range
  compared against what a copy would have written, and every SIMD unpack compared against the
  scalar unpack, over a stress500 run:
  - reused-vertex checks 175,665,776, mismatches 0;
  - reused-index checks 355,454,487, mismatches 0;
  - SIMD-unpacked vertices 19,439,418, position / normal / colour mismatches 0 / 0 / 0. By
    path: 8-bit no lerp 613,140; 8-bit lerp 0; 16-bit no lerp 309,636; 16-bit lerp 18,516,642.
- Functional tests on `models2b`: `svtest` 5/5, `bottest` 5/5, `flowtest` 4/4 pass.

## Risks

- **The static contract.** Reuse is correct only while every array declared static really stays
  unchanged until the next reset. The engine resets at every place I found that rewrites the
  memory (unpack arena wrap, model prepare and clear) and the shim resets at every present, so a
  missed case could only show inside one frame. A future caller that writes into a declared
  array and draws again in the same frame without a reset would draw stale vertices. The
  verifier above is the way to check such a change.
- **Pointer identity.** Entries are keyed by address. Freeing an array and allocating a new one
  at the same address within one frame, without a reset, would reuse stale data. Model data
  changes go through `CModelData::Clear`, which resets.
- **Table limits.** Static set and reuse tables fall back to plain copying when half full; no
  correctness risk, just less reuse in a frame with more than ~2000 shared arrays or ~4000
  reused ranges.
- **SIMD exactness.** The SIMD path uses the scalar code's operations in its order, and the
  verifier found 0 differences, but the 8-bit lerp path had no vertices in stress500 or demo:
  it is checked only by reading. (Most TFE models are 16-bit; the 8-bit ones were not lerping
  in these runs.) A change to the scalar unpack must be mirrored in `UnpackFrame_SIMD`, or the
  two paths drift apart.
- **Paced benches read reuse as a p95 loss.** In scenarios with headroom (stress500,
  stress1000 at 60 fps) the default bench metric shows p95 about 1 ms worse with reuse, from the
  lower clock, not more work (Numbers). A future bench comparison should use `?spin=1` or a
  CPU-bound scenario (stress2000) before reading it as a regression.
- `?vreuse=0` keeps the old shim behaviour for A/B; there is no switch for the SIMD unpack other
  than a non-SIMD build.

## Next ideas

- **Colours.** The per-instance colour stream (~0.5 MB per frame) is the largest copy left. Two
  instances in the same frame with the same light setup could share it (key the colour array by
  frame + light hash), or the lighting could move to the GPU (pass the shade per vertex once
  and the light per draw as a uniform).
- **Instancing.** With positions, texcoords and indices shared, the remaining per-draw cost on
  the page is state and the draw call. Instances that share everything but the matrix and
  colour could become one instanced draw in `gfx.js`.
- **`RenderModel` self** (12.5%): per-instance view transform and projection setup, surface
  loops and texture binding. Profile it line by line (`--profile` with a build that keeps the
  inlined helpers) before changing it.
- **`FindModelLights`** (2%): recomputed for every model every frame; lights rarely change
  between frames for a monster that hardly moved. A per-entity cache keyed by position cell
  and light-list generation would cut most of it.
- **The bench metric.** `se1Perf` work time includes the clock effect above. A `--spin` default
  of 1 in `perfbench` for paced scenarios (or reporting busy samples next to the mean) would
  make perf comparisons less sensitive to how idle a change leaves the CPU.
- Exercise the 8-bit lerp path (a level with 8-bit animated models) under the verifier.
