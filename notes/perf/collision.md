# Perf track C: movement collision

Branch `t3/optimize-movement-collision`. Area: `Engine/World/WorldCollision.cpp`,
`WorldCollisionGrid.cpp`, and how `CMovableEntity::TryToMove` (MovableEntity.es) uses
`CWorld::ClipMove`. All changes are under `#ifdef __EMSCRIPTEN__`, with the original code
kept in the `#else` branch or left unchanged.

## What was slow and why

In ref's stress500 profile, `CWorld::ClipMove` with everything it calls took about 25% of
the engine thread. Self time was 8.4% ClipMove (it inlines most of WorldCollision.cpp),
6.7% PrepareProjectionsAndSpheres, 4.5% FindEntitiesNearBox, 2.8% ClipMovingPointToSphere
and 2.3% ClipMovingPointToCylinder. I counted calls with temporary `CPrintF` counters,
because binaryen inlines regardless of `noinline`, so the profile only gives coarse names.
The counts showed where it went:

- **Projections per brush sector.** `ClipMoveToBrushes` ran `PrepareProjectionsAndSpheres`
  (it projects every sphere of A into B's space and builds the boxes) for every sector it
  visited. A mover in the crowd visits about 16 sectors per ClipMove but clips fewer than one
  polygon. Most sectors don't touch the movement box at all.
- **Repeated grid searches.** In about 60% of FindEntitiesNearBox calls the cell range is the
  same as in the previous call and the grid hasn't changed in between. A clipped mover
  retries from the same place (TryToMove's slide and step-up attempts), and each retry scans
  the same ~48 near entities.
- **Edge loops for spheres far from the polygon.** For each polygon that passes the box test,
  every moving sphere runs a cylinder test and a vertex-sphere test per edge, each a full
  quadratic solve. For a crowd over a floor, the upper spheres are well above the plane and
  can never hit an edge.

The model-vs-model part (each mover against the spheres of the ~1-2 near models whose box
it touches) is already box-culled and is not O(n²) in practice: the collision grid keeps
the candidate list local.

## Changes

1. `7b7c01f` perf(collision): defer brush sphere projections, skip missed sectors, reuse
   repeated grid searches.
   - `cm_bBrushProjectionsPending`: `ClipMoveToBrushes` marks the projections pending
     instead of computing them. `ClipMoveToBrushPolygon` (the first polygon that passed the
     box tests) computes them. The inputs (A's and B's placements) don't change in between,
     so the results are the same. The terrain path stays eager.
   - `ClipToNonZoningSector` / `ClipToZoningSector` return early when the sector box misses
     the movement path. The sector box is the union of its polygon boxes
     (`CBrushSector::CalculateBoundingBoxes`), so every polygon would have missed it too.
   - `FindEntitiesNearBox` keeps its previous result plus a grid change counter, bumped in
     `Clear`/`AddEntry`/`RemoveEntry`. For the same grid, the same cell range and no
     change, it returns the stored list: the same entities in the same order.
   - Measured: stress500 5.79 -> 5.35 ms (1.08x), reps 5.
2. `81138d9` perf(collision): skip a brush polygon's edge tests for spheres far from its
   plane.
   - `ClipMovingSphereToBrushPolygon` returns right after the two plane distances when the
     sphere's path stays more than radius + 0.1 in front of the plane, or more than radius
     + 0.1 behind it.
   - Edges and vertices lie in the plane, so no edge cylinder or vertex sphere is reachable.
     The plane hit itself needs `fDistance0>=0 && fDistance1<0`.
   - Trap: `cm_fMovementFraction` starts at **2.0**, so the edge and vertex tests accept
     hits up to fraction 2, beyond the end of the movement. The check has to cover the path
     out to fraction 2 (`fDistance2 = 2*fDistance1-fDistance0`; the distance is linear
     along the path). My first version checked only the two endpoints, and the verification
     build caught 309 dropped cylinder hits.
   - The verification build ran the original code for every skipped sphere and counted
     hits that the skip would drop. stress500: 2,000,000 tests, 38% skipped, 0 dropped. Whole
     demo: 0 dropped. Largest vertex distance from its float plane: 0.00024, against the 0.1
     margin.
   - Measured, same run: mean vs ref 1.05x -> 1.07x. ClipMove inclusive 18.1% -> 17.1%,
     ClipMovingPointToCylinder 2.3% -> 1.4%.

### Tried and dropped

- **Near-entity box cache.** Copy the near entities' `ci_boxCurrent` next to the reused
  FindEntitiesNearBox list, kept exact by a change counter on every `ci_boxCurrent` write in
  Entity.cpp, and reject candidates before touching the entities. Result: SAME simulation,
  but 1.08x vs commit 1's 1.07x in a 6-rep 3-way run (ClipMove self 7.7% -> 7.6%), which is
  noise. Not worth hooks in Entity.cpp.
- **Skipping `GetPositionsOfEntity` for sectors that miss.** The early sector return already
  removes the expensive part; the copy left over is ~100 bytes per sector.

## Results

Final run: `perfbench --check --reps 4 --scenarios stress500,demo,stress1000`, ref vs
`collision` (both commits), engine-thread ms per frame:

| scenario | build | mean ms | p50 | p95 | fps | speedup |
|---|---|---|---|---|---|---|
| stress500 | ref | 6.238 | 2.120 | 15.330 | 60 | 1.00x |
| stress500 | collision | 5.768 | 2.215 | 13.835 | 60 | **1.08x** |
| demo | ref | 0.309 | 0.300 | 0.420 | 3241 | 1.00x |
| demo | collision | 0.319 | 0.300 | 0.425 | 3252 | 0.97x (noise: fps is higher; the demo barely clips) |
| stress1000 | ref | 37.363 | 37.750 | 73.060 | 20 | 1.00x |
| stress1000 | collision | 27.249 | 33.525 | 65.870 | 29 | 1.37x |

stress1000 is saturated: it misses the frame pace, so the per-frame mean mixes tick frames and
render frames differently in each build (29 vs 20 fps). Read it as "collision scales better",
not as a clean 1.37x. In its profile, inclusive ClipMove goes from 28.3% to 20.8%.

Check: `check collision: SAME simulation, 384 ticks` (final ref hash 7d4eb99b). Every intermediate
build kept here also gave SAME.
Functional tests against the served build: svtest, bottest and flowtest all pass (run one at a time).

Share of the stress500 frame (inclusive `CWorld::ClipMove`): 26.2% in ref -> 16.9%, in the same run.
Machine noise is about ±5% (other tracks bench at the same time), so the per-change numbers
above come from runs where builds were interleaved rep by rep.

## Risks

- Change 2 uses a margin, not an exact proof. It assumes brush polygons are planar to
  within 0.1 world units (true by construction: vertices are plane intersections, measured
  ≤0.00024 here) and that rounding of the quadratic solves is far below 0.1 for the
  distances involved. A non-planar polygon in a custom level could change a collision.
- The FindEntitiesNearBox cache relies on every grid change going through
  `Clear`/`AddEntry`/`RemoveEntry` (they are the only writers of the cell lists), and on the
  caller not changing the returned array between calls with the same box. ClipMoveToModels
  only reads it.
- The deferred projections rely on nothing between `ClipMoveToBrushes`' setup and the first
  polygon clip moving A or B. Pass events are queued (`CEntity::SendEvent`), so nothing
  moves mid-clip.

## What I would try next

- **Hoist per-edge math out of the per-sphere loop.** ClipMovingPointToCylinder recomputes
  the edge direction (a sqrt and a division) for each moving sphere. It could be computed
  once per polygon edge with the same expressions, so the results are identical. Worth
  ~0.5-1% now that 38% of the loops are skipped.
- **Model-vs-model sphere tests** (ClipMovingPointToSphere, ~2.5%, 76% of it from
  ClipModelMoveToModel). Hoist `vStartToEnd` and its squared length per A sphere (exact).
  A bigger win needs fewer ClipMove calls: TryToMove retries a blocked move up to several
  times per tick (slide, step up). Caching a failed clip for an unchanged mover and an
  unchanged neighbourhood would remove whole calls, but the hit plane is fed back into the
  next retry, so it needs care.
- **FindEntitiesNearBox misses** (3.1%): the dedupe walks every cell's list and flags
  entities. A per-mover result cache keyed by the cell range would help when many movers
  sit in the same cells. The order (x-major cells, LIFO within a cell, first occurrence
  wins) has to be kept.
- The collision part is now about 17% of stress500. The bigger costs are in other tracks'
  areas (path-finding 12-14%, ray casts ~20%, model rendering).
