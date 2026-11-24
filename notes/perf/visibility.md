# Perf track E: world visibility and brush rendering

Branch `t3/optimize-world-visibility`. Area: the software visibility pass (the ASER scan-line edge
renderer and the per-sector clipping in `src/SamTFE/Sources/Engine/Rendering/`), measured mostly by the
`demo` scenario (timedemo, 1024x768).

## What was slow and why

Ref profile of `demo` (self time): `CRenderer::ScanOneLine` 16.8%, `AddActiveSector` 10.6%,
`CRenderer::Render` 8%, `ClipToOnePlane` 5.3%, `MakeSpan` 5.3%, `MakeScreenPolygon` 1.6%,
`intro_sort` + `qsort_CompareDelayedModels` ~3.7%. Together about half of a timedemo frame.

Counted per timedemo frame (temporary counters, since removed): 768 scan lines, 790 scans (only ~22
re-scans after a portal), ~11.7k edge visits in `ScanOneLine`, ~10.7k resort steps but only ~380
edge moves, ~3.6k edge visits in the separate removal pass, ~5.1k spans, ~3.8k surface-stack walk
steps, ~55 sectors activated (~35 visible), ~830 transformed vertices, ~342 transformed planes,
~200 screen polygons, ~600 polygon-plane clips, ~290 delayed models sorted.

So the work is many tiny steps, with no single large loop to replace: per edge, per span, per plane.
The wins come from taking work and dependent memory loads out of those steps, while keeping every
observable output the same: span order, first-span order (scene polygon order), portal order,
mirror boxes, sort orders and float arithmetic.

Note: `__attribute__((noinline))` does not split the profile. Binaryen's inliner ignores it and still
inlines the single-caller functions, so the split inside `AddActiveSector`/`Render` is estimated
from the counts above.

## Changes (all under `#ifdef __EMSCRIPTEN__`, originals kept in `#else`)

1. **Sorts with inlined comparators** (`port/common/FastSort.h`, new). A template copy of the
   introsort in `FastSort.c`, the `qsort` the web build links in through `-Wl,--wrap=qsort`. It
   runs the same steps: pivot, partition, insertion and heap thresholds, depth limit. So with
   comparators that give the same result for every pair, it makes the same swaps and leaves the
   same order. `qsort` is not stable, and this keeps even the order of equal keys. Used for:
   - the delayed models (`RenderModels`). They are sorted over a packed key array
     `{alpha, distance, pointer}`, so a comparison doesn't chase two pointers into scattered
     `CDelayedModel`s. The pointers are written back in sorted order.
   - the translucent polygons (`SortTranslucentPolygons`).
   - the clip-edge vertices (`GenerateClipEdges`).
2. **`ScanOneLine` edge loop.** The edge-transition counters and `re_xCurrentScanI` live in locals
   and are written back on every exit. The float stats counter gets the same sequence of `+1.0f`,
   so it ends with the same value. Before, the stores into the edges forced these through memory
   on every edge. The common `MakeSpan` case (a polygon that already has a span) is inlined
   (`MakeSpanInline`).
3. **Polygon pointer cached in `CActiveEdge`.** It goes in the padding slot, so the size stays
   16 bytes in wasm32. `sed_pspo` is set before an edge is added and never changes while the edge
   is active. The polygon load no longer waits on the `CScreenEdge` load.
4. **Removal and step/resort in one pass.** `RemRemoveListAndStepActiveList`. The surviving edges
   are stepped and insertion-sorted against the same already-placed edges as in the two separate
   passes, so the active list comes out identical.
5. **Span box only for possible mirrors.** `spo_pixMin/Max*` and `spo_pixTotalArea` are read only by
   `CMirror::FinishAdding`, for polygons `AddMirror` put in a mirror. `AddMirror` runs only from
   the first-span path of `MakeSpan`, and only for polygons with `bpp_ubMirrorType!=0`. That first
   span marks such polygons (`spo_ubSpanAdded==2`), and only for them do the later spans grow the
   box.
6. **`ClipOnePolygon` without a checked `Push()` per index.** Each edge gives at most two edge
   vertices, so the worst case is reserved once, written through a pointer, and the count is
   trimmed afterwards. Same contents and order.
7. **Lazy plane depth gradient and mapping vectors.** `PreClipPlanes` still transforms every plane
   and sets visibility. The OoK gradient (three divisions and a virtual call) and the view-space
   mapping vectors are made by `PrepareViewPlane` in `MakeScreenPolygon`, their only reader, on
   first use within the same `AddActiveSector`. Same arithmetic, same projection. Back-facing
   planes, about half, no longer pay for them. This needs one engine field,
   `CWorkingPlane::wpl_bViewMappingReady`, in `Brushes/BrushTransformed.h`, guarded.

## Numbers

perfbench `--check --reps 3`, against the frozen ref (8181), with other tracks' benches running
on the machine (expect noise):

| scenario | ref mean | new mean | ref p50 | new p50 | speedup (mean) |
|---|---|---|---|---|---|
| demo | 0.335 | 0.332 | 0.320 | 0.300 | 1.01x (p50 1.07x) |
| stress500 | 5.782 | 5.690 | 1.915 | 1.925 | 1.02x (noise: not this area) |
| menu | 0.028 | 0.028 | 0.010 | 0.010 | 1.00x |

The demo mean in that run is noisy: one rep of the new build had a p95 of 0.895 ms against ~0.5
for the others. The p50 shows the gain more steadily: ~0.02 ms per frame, ~6%.

A later back-to-back profile run (`--reps 1 --profile`, on a quieter machine) gives demo **0.302 →
0.284 ms mean (1.06x), p50 0.290 → 0.265 (1.09x)**. Self time of the area in that profile:

| function | ref | new |
|---|---|---|
| ScanOneLine (now includes the inlined MakeSpan) | 18.4% | 18.7% |
| MakeSpan (out-of-line: first spans, line ends) | 5.3% | 0.8% |
| AddActiveSector | 10.1% | 9.5% |
| Render | 8.8% | 8.6% |
| ClipToOnePlane | 5.8% | 4.9% |
| MakeScreenPolygon (now makes the plane gradient/mapping) | 1.3% | 2.2% |
| model sort (intro_sort + comparator → IntroSort<DelayedModelKey>) | 3.8% | 1.3% |
| **area total** | **53.5% of 0.313 ms ≈ 0.167 ms** | **~46.6% of 0.290 ms ≈ 0.135 ms** |

So the visibility pass takes ~19% less time. ScanOneLine plus MakeSpan went from 23.7% to 19.5%,
and the model sort from 3.8% to 1.3%.

Behaviour gate: `--check` prints **SAME simulation, 384 ticks**. Frames: `bench.mjs --shots` on ref
and new, then `shotdiff.py`: **8/8 frames ok**, 5 of them bit-identical. Under `--exact`, the other
three (t01100, t01300, t01500) differ in 10 to 60 pixels of particle flames. Two captures of the ref
build differ from each other in the same three frames, so that is run-to-run particle noise, not
this change.

Functional tests against the new build, one at a time: flowtest passes and svtest passes. The
first svtest run failed only in its harness: a screenshot path in the shared temp dir that another
track's run had removed. bottest passes. Its "bots move" check is flaky: the ref build failed the
same check in a run right after.

## Risks

- `FastSort.h` must stay in step with `FastSort.c`. If one changes alone, the sort orders of equal
  keys (models at the same distance, translucent polygons) can change. Both files say so.
- The `ace_pspo` cache relies on `sed_pspo` not changing while an edge is active. True today: it is
  only written in `MakeScreenEdge`/`AddScreenEdges`, before the edge goes into the add list.
- The mirror-box shortcut relies on `AddMirror` being called only from `MakeSpan`'s first-span path,
  and on the box being read only by `CMirror::FinishAdding`. A new reader of `spo_pix*` would see
  stale values for non-mirror polygons.
- Lazy plane mapping relies on `MakeScreenPolygon` being the only reader of `wpl_mvView` and
  `wpl_pgOoK`, and on it being called within the sector's `AddActiveSector`.
- Only the web build compiles these paths. The `#else` branches are the untouched originals.

## Next ideas

- Split the profile properly: link once with wasm-opt inlining turned off, to see where
  `AddActiveSector`'s 10% really goes (vertex transform, polygon visibility, edge setup,
  `AddEntitiesInSector`'s relation walk).
- Cache the view-space transform of a sector between frames when the camera and the brush didn't
  move (menu background, standing still). It would need an invalidation key on the projection.
- `CScreenPolygon` layout: put the fields `ScanOneLine` and the surface stack touch (`spo_bActive`,
  `spo_pgOoK`, `spo_lnInStack`, `spo_iInStack`, `spo_psedSpanStart`, `spo_ubSpanAdded`) in one cache
  line, ahead of the large `ScenePolygon`.
- Keep the edge direction in `CActiveEdge` too (it needs a few more bits in the entry), so the scan
  loop touches `CScreenEdge` only to store `sed_xI`.
- Brush submission (`RenderScene`, `SetOneTextureParameters`, the GL shim) was not touched, to keep
  clear of the model track's work in `gl1shim.c`.
