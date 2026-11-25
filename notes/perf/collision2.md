# Perf round 2, track F: collision between movers

Branch `t3/04c7d1bd`, on top of round 1 (`notes/perf/collision.md`). Area:
`Engine/World/WorldCollision.cpp` and `WorldCollisionGrid.cpp`. Every change is under
`#ifdef __EMSCRIPTEN__`, with the original code in the `#else` branch or left unchanged. Each
change keeps the simulation bit-identical: the same hit entity, fraction, plane and tie order.
Each was checked with a temporary verify build that ran the old path next to the new one and
counted mismatches.

## What was slow and why

After round 1 (r1), `CWorld::ClipMove` with its callees is still the largest area in the
crowd scenarios: **33.4%** of the engine thread in stress500 and **44.2%** in stress1000
(inclusive, perfbench `--profile`). binaryen inlines after LTO and ignores `noinline`, so the
profile lumps most of WorldCollision.cpp into ClipMove. I used temporary `CPrintF` counting
builds and in-page A/B "doubling" builds to split it up. A doubling build runs one phase
twice, toggled by `clp_iExp`, and averages `Module.se1Perf.work` over 3 s windows. Per
ClipMove in stress500:

| What | Per ClipMove |
|---|---|
| active brush sectors visited | 15.9 |
| non-zoning sectors (of those) | 14.8, of which 0.1 touch the movement box |
| near entities returned by the grid search | 4.6 candidates |
| model-to-model clips | 3.6 |
| brush polygons clipped | 0.7 |

What adds cost at the margin (stress1000, base 5.26 ms, ms added when the phase runs twice):

| Phase | Added ms |
|---|---|
| grid search, cache off and uncached | +0.38 |
| grid search, cache off | +0.22 |
| brush pass | +0.28 |
| PrepareProjectionsAndSpheres | +0.10 |
| ClipModelMoveToModel | +0.10 |
| CClipMove constructor | ~0 |

The three hot spots:

- **Model-to-model sphere pairs.** About 7M sphere-pair tests per window, for 160k hits.
  Each pair runs `ClipMovingPointToSphere`, a full quadratic solve, even when the two
  spheres are far apart along the whole path. `ClipMovingPointToSphere` was 5.5% of the
  stress500 profile.
- **The grid search.** `FindEntitiesNearBox` walks every cell in the movement box's range
  and each cell's entry list (~110 entries). It dedups through the entity's
  `en_ulFlags`/marking and returns ~43 entities, of which ClipMoveToModels keeps ~3 after
  its own box test. Each entry dereferences its entity to read and set
  `ENF_FOUNDINGRIDSEARCH`, so the cost is mostly cache misses on entities. Round 1's
  last-result cache only covers repeats of the same cell range.
- **Brush polygon edges.** For a polygon the sphere path touches, every moving sphere tests
  every edge (a cylinder solve plus a vertex sphere solve). A mover on a floor polygon is
  near only a few of its edges. `ClipMovingPointToCylinder` was 3.6% self in stress1000.

## Changes

1. `c03f934` perf(collision): test four sphere pairs at once before the exact
   model-to-model clip.
   - In `ClipModelMoveToModel`, for B with at most 16 spheres, a wasm SIMD block packs B's
     spheres into SoA chunks of four.
   - Per lane, it runs the box "far" test, then the moving-point-to-sphere quadratic with
     the same IEEE single-precision operations in the same order as the scalar code. So
     each lane gets the scalar code's exact discriminant and roots. A lane is rejected only
     if its discriminant is negative, or both roots are below 0 or at/above the current
     movement fraction.
   - Lanes that may hit go to the unchanged scalar `ClipMovingPointToSphere`, in the
     original order, so the tie order is kept.
   - Verify build: every rejected pair was also run through the scalar path. 0 rejected
     pairs would have hit.
   - `ClipMovingPointToSphere` inclusive fell from 5.5% to 1.6% of the stress500 profile.
2. `7bf7031` perf(collision): find the movers a ClipMove touches from compact grid
   records.
   - The collision grid now keeps one compact record per entity (`CGridObject`: entity,
     box, first cell). It is kept in step by the existing Add/Remove/Move hooks.
   - `SE1_FindEntitiesTouchingBox` scans the cell range. For each entry it applies a
     first-cell rule, `Max(go_iMinX, iMinX)==iX && Max(go_iMinZ, iMinZ)==iZ`, which reports
     each entity once, in the same order as the original walk, without marking. It then
     applies ClipMoveToModels' exact box test on the record's box, so the list it returns is
     the one ClipMoveToModels would have kept.
   - The record indices are cached per (grid, `_ulGridChanges`, cell range), because
     TryToMove's retries search the same range.
   - If a hook ever finds the grid out of step (a missing cell or entry), it marks the grid
     inconsistent and the search falls back to the original `FindEntitiesNearBox` until the
     grid is cleared.
   - Verify build: compared against the original walk plus box test on ~1.8M stress500
     searches plus the timedemo. 0 mismatches, 0 inconsistent.
   - stress500 ClipMove 0.90 → 0.75 ms. stress1000 5.61 → 5.19 ms mean vs r1.
3. `2612fde` perf(collision): skip brush polygon edges whose box misses the movement path.
   - In `ClipMovingSphereToBrushPolygon`, the edge loop first builds the box of the path
     from the start to the current `cm_fMovementFraction`, grown by `ms_fR + 0.1`.
   - An edge whose two vertices both lie outside that box on one axis can't be within `ms_fR`
     of a hit point, so its cylinder and vertex sphere calls are skipped.
   - The fraction only decreases, so the box stays conservative. A NaN compares false and
     never skips.
   - Verify build: 89% of edges skipped, 0 mismatches (~2M edges per window, stress1000,
     plus the timedemo).
   - `ClipMovingPointToCylinder` self time fell from 3.6% to 0.5% (stress1000) and from 3.0%
     to 0.7% (stress500).

Tried and dropped: a box skip for non-zoning sectors before their entity walk. It was exact,
but measured only +0.036 ms (0.7%) by A/B, inside the noise, so I reverted it.

## Results

`perfbench --check --reps 3 --scenarios stress500,stress1000,demo`. ref is the pre-round-1
engine (8181), r1 is round 1 (8192), new is this branch (8221). Mean ms per frame of engine
work:

| Scenario | ref | r1 | new | new vs ref | new vs r1 |
|---|---|---|---|---|---|
| stress500 | 5.984 | 3.549 | 3.397 | 1.76x | 1.04x |
| stress1000 | 35.851 | 5.580 | 5.213 | 6.88x | 1.07x |
| demo | 0.306 | 0.271 | 0.274 | 1.12x | ~same |

ClipMove inclusive share of the profile:

| Scenario | ref | r1 | new |
|---|---|---|---|
| stress500 | 25.4% | 33.4% | 27.7% |
| stress1000 | 29.1% | 44.2% | 37.5% |

Check: `check r1: SAME simulation, 384 ticks` and `check new: SAME simulation, 384 ticks`
(ref final hash 7d4eb99b). svtest, bottest and flowtest all pass against the new build.

## Risks

- Change 2 relies on the grid hooks seeing every add, remove and move. Any path that edits
  `cg_` cells directly would make the records stale. A missing cell or entry found by a hook
  switches the grid to the original search, but a stale record that is never touched again
  would not be caught. The verify build found none across stress and timedemo. The tests
  (svtest, bottest, flowtest) use other maps and modes.
- Change 1 has no margin. It relies on wasm SIMD f32 add/sub/mul/div/sqrt rounding exactly
  like the scalar f32 code. wasm guarantees that (IEEE, no fused multiply-add), and the build
  uses no fast-math. Building with `-ffast-math` or FMA contraction would break it, and the
  reject could then differ from the scalar result by an ulp. The scalar path still decides
  every pair that isn't rejected.
- Change 3's margin is 0.1 world units on top of the sphere radius. The quadratic solves
  round on the order of 1e-5 at map scale, so the margin would only matter for coordinates
  far beyond any map's size.

## What to try next

- **Cold cache dominates.** In stress1000, ClipMove is ~2 ms of a 5.2 ms frame, but the warm
  doubling costs add up to only ~0.8 ms. The rest is first-touch misses on entities, brush
  sectors and polygons. A gain needs data layout work: pack per-ClipMove inputs (A's spheres,
  the near polygons, B's placements) into contiguous arrays, or move fewer bytes per mover.
- **Grid search.** An uncached search still touches ~110 entries and ~43 records to keep ~3.
  Storing each record's box inline in the cell entry list, or using a finer grid for small
  movers, would cut the scan.
- **Non-zoning sector walk.** 14.8 of 15.9 sectors visited are non-zoning and almost none
  touch the box. The walk itself (list nodes per sector) is the cost, not the clip. A
  per-entity cache of the non-zoning sectors whose box touches the entity's extended box
  would skip most of it.
- **Reuse across TryToMove retries.** A blocked mover retries ClipMove from the same start
  with a different direction. The near-polygon list, the projections of A into each B and
  the near-entity list could be kept for the retries of one TryToMove.
