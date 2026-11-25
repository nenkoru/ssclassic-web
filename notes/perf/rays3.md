# Perf round 3: model ray casts through the collision grid (`rays3`)

Area: `CCastRay::TestThroughSectors` and `TestModelCollisionBox` (`Engine/World/WorldRayCasting.cpp`),
plus a segment query in `Engine/World/WorldCollisionGrid.cpp`. Everything is under
`#ifdef __EMSCRIPTEN__`; the original code is unchanged and still runs whenever the fast path
can't be used. Scenarios: demo, stress2000, stress4000.

## What was slow

At stress4000, `TestModelCollisionBox` was 8.8% self and `CCastRay::Cast` 3.0% (its inlined
sector loop), 12% inclusive. Nearly all of it came from `TT_COLLISIONBOX` casts:
`CEnemyBase::FireOrHit` -> `CanHitEnemy` / `CanAttackEnemy` -> `IsVisibleCheckAll`
(`Entities/EnemyBase.es`). `TestThroughSectors` walks every entity linked to each sector it visits
and tests each model. In Karnak almost the whole horde sits in one or two sectors, so each cast
tested about as many models as there were monsters: O(monsters) per cast, O(monsters^2) per tick.

Round 2 (`rays2.md`) tried two versions of this and dropped both:
- **Grid candidates with `FindEntitiesNearBox` boxes along the ray, sorted back into list
  order.** It was much slower. The boxes were wide, so the candidate sets were large (~800 per
  ray), and the pointer sort and the per-link order key cost more than the walk saved.
- **A box pre-reject inside the walk.** It was no faster. The walk's cost is the pointer chase
  (link -> entity -> collision info -> box), not the arithmetic.

This version avoids both problems. It never touches the models the ray can't reach, and it needs
no list order.

## The change

1. **Candidates from the grid** (`SE1_FindEntitiesNearSegment`, `WorldCollisionGrid.cpp`). The
   segment runs from origin-testR to origin+hitDistance along the ray, grown by testR plus a
   rounding margin. For each 2 m column of cells the segment's grown band crosses, the query scans
   only the z cells that band covers in that column's x slab. So a long diagonal ray scans a thin
   band of cells, not its bounding rectangle. Each record is taken once (a stamp per record
   index), and kept only if its box, grown the same way, meets the segment (a slab test in
   double). It reads only the grid's own arrays (cells, entries, the compact `CGridObject`
   records from round 2), not the entities.
2. **The best distance per candidate** (`RayModelBoxBest`). This is the arithmetic of
   `TestModelCollisionBox` on the same values: the bounding-sphere test, then the smallest sphere
   distance d with d > -testR. A candidate is kept, once for each sector in its `en_rdSectors`,
   only if it passes the gates of the sector loop and of `TestModel` / `TestSkaModel`
   (`RayTestsModelBox`), and only if its best is below the starting hit distance. In practice
   that leaves the few models the ray actually goes through.
3. **The sector walk stays as it was.** `TestBrushSector`, then the sector's brushes in list order
   from the per-sector cache that `TT_NONE` casts already use (`SectorBrushesAndTerrains`), so
   `_aas` grows in the same order. The sector's model loop is replaced by "take the smallest kept
   best below the current hit distance, if any". A sector falls back to the original loop when
   it holds a terrain, or when two different models tie at the winning value.
4. **The query reaches only a few meters at first.** Nearly every one of these casts hits a model
   a few meters out (an enemy's ray to the player passes through the horde), and a query along
   the whole ray (20-40 m through the horde) collected ~180 candidates and read thousands of grid
   entries per cast. So the first query reaches 4 m (`RAYHITS_FIRST`): it collects every model
   whose best is below 4 m (and the hit distance). A sector with one of those is decided. A sector
   without one, while its hit distance is above the reach, makes the query reach 4x further, or
   to the hit distance, and is tested again. About 1.5% of the casts reach further.
5. **When the original runs instead.** The original walk runs for the whole cast if:
   - the grid is inconsistent (`cg_bInconsistent`);
   - the scan would visit more than 64 + records/2 cells (the original reads each model once);
   - the hit distance is not in (0, 5000), testR is not in [0, 100), the ray is shorter than
     1 m, or a coordinate is beyond 50 km.

## Why it is exact

The result is `cr_penHit`, `cr_fHitDistance` (so `cr_vHit`), `cr_pbscBrushSector`,
`cr_pbpoBrushPolygon`, and the order of `_aas`, which later sectors and `ContinueCast` depend on.

**What the model loop does.** In the sector loop, model tests only lower `cr_fHitDistance` and set
`cr_penHit` (clearing the polygon and sector). Brush entities only append sectors, and nothing
else in the loop has an effect. Within one model, `TestModelCollisionBox` takes each sphere whose
distance d is hit, satisfies d > -testR and is below the running hit distance. So the hit distance
ends at min(hit distance, all such d), and a NaN d qualifies nowhere. That is exactly
`RayModelBoxBest`'s minimum, computed with the same expressions on the same floats. Wasm f32
arithmetic is IEEE with no contraction (no fma), so the inlined copies give the same bits.

**Order and ties.** Over a sector's models in list order, the hit goes to the first model whose
best is the smallest one below the hit distance; later equal values fail the strict `<`. When
exactly one model attains that minimum, the order doesn't matter. When two different models
attain it (including -0 and +0, which compare equal), the original loop runs for that sector.
The state at that point is the same as before the loop: `TestBrushSector` has already run, and
nothing else has. Across sectors, a model linked into several sectors is decided at the first one
visited, as in the walk; after that its best can't be below the hit distance again.

**A short reach.** The query up to `fUpTo` holds every model that passes the gates and whose best
is below both `fUpTo` and the hit distance (the argument below, with `fUpTo` for H0). If the
smallest best in the sector is below `fUpTo`, no unknown model can be smaller or equal, so the
winner and the tie test are the same as with the full set. If none is below `fUpTo` and the hit
distance is at most `fUpTo`, no model can take the hit there. Otherwise the reach grows. It
always ends, because once it equals the hit distance, the first case or the second applies. If a
longer query can't be used (the cell limit), the original loop runs for the rest of the walk,
which is exact in any sector.

**Only candidates can take the hit.** The hit distance never rises during a cast, so a model can
take the hit only at some d with -testR < d < H0 (H0: the hit distance when the walk starts). The
exact point X = O + d*u on the ray is then within R + eps of the sphere center c
(R = sphere radius + testR; eps bounded below). Each sphere center lies inside `ci_boxCurrent`
shrunk by its radius:
- spheres are collinear, with equal radius, between the first and the last (`FromModel`);
- `MakeBoxAtPlacement` is the union of the first and last sphere's boxes at the current placement.

So X is on the segment [O - testR*u, O + H0*u], within testR + eps of `ci_boxCurrent`. The grid
record's box equals `ci_boxCurrent` while `cg_bInconsistent` is clear:
- every change of `ci_boxCurrent` goes through `SetPlacement_internal`, `FindCollisionInfo` or
  `CopyCollisionInfo`, each together with the grid update for non-brush entities;
- a remove or move with a box other than the recorded one sets the flag.

Every entity with collision info that isn't a brush is in the grid. The point of the box nearest X
lies in a cell the entity occupies (`BoxToGrid` spans floor(min/2) .. ceil(max/2)), and the scan
covers every cell within the grown band. A model whose box or placement isn't finite gets a NaN or
-inf distance and can't take the hit.

**Rounding (the margin).** `RayHitsSphere` computes p = (v.a)/(v.v) and q = (a.a - R^2)/(v.v) in
float, where a = O - c, v = target - O, A = |a| and L = |v|. With unit roundoff u = 2^-24:
- the discriminant D = p^2 - q has an absolute error of about 30u(A^2 + R^2)/L^2;
- p has an error of about 7uA/L.

Following that through the root shows that the computed root's exact point X satisfies
|X - c|^2 <= R^2 + 30u(A + R)^2. So |X - c| - R <= min(sqrt(30u)(A + R), 15u(A + R)^2 / R), and
with A <= H + R (H = H0 + testR) that is at most 0.004 H + 1e-5 R. The other errors:
- the float sphere centers and a = O - c: about 1e-7 of the coordinates;
- the float direction of v: about 1e-7 * coordinates * H / L sideways.

The margin used is 0.1 m + 0.01 H (H: the query's reach, see above) + 1e-6 * coordinates + 1e-6 * (coordinates + H)(H + 1)/L: several
times each bound, for any model under 1 km. The first verified version used 0.5 m + 0.01 H.

## Verify

A temporary build (`SE1_RAYS3_VERIFY`, removed before the commit) ran every `TT_COLLISIONBOX`
cast twice from the same start state, comparing `cr_penHit`, `cr_fHitDistance` (bitwise), the
polygon, the sector and the full `_aas` list:
- run 1: the new path;
- run 2: the original loop only, with `_aas`, the sector flags and the hit fields restored first.

| margin | scenario | casts | fast path | mismatches | candidates / cast | tie fallbacks |
|---|---|---|---|---|---|---|
| 0.5 m + 0.01 H | stress2000 | 196,608 | 99.4% | 0 | 141 | 0 |
| 0.1 m + 0.01 H, whole ray | stress4000 | 131,072 | 99.6% | 0 | 180 | 0 |
| 0.1 m + 0.01 reach, 4 m first (final) | stress4000 | 131,072 | 99.6% | 0 | 25 per query (132,569 queries; 1,972 reached further) | 1 |

In both runs 96-98% of the casts hit a model: an enemy's ray to the player passes through the
horde. The first verify run found 12 mismatches in its first 16k casts. They were a bug in the
new query, not in the argument: the dedup stamps were sized by `CAllocationArray::Count()`,
which counts the records in use, while record indices run to the pool size. Fixed
(`sa_Count`) before the runs above.

## Results

`perfbench.mjs --check --reps 3 --scenarios demo,stress2000,stress4000`, base (main at 540a4e7)
against this change, both builds snapshotted with `perfsnap.py`. Check: "SAME simulation, 384 ticks".
Engine-thread CPU ms per frame. Other tracks were using the machine at the same time, so the
runs alternate (A B A B); the new build was faster in every pair.

| scenario | base mean ms | new mean ms | speedup | spread base / new |
|---|---|---|---|---|
| demo | 0.281 | 0.284 | 0.99x (noise) | 0.280-0.282 / 0.281-0.285 |
| stress2000 | 11.959 | 10.827 | 1.10x | 11.88-12.18 / 10.74-11.00 |
| stress4000 | 52.276 | 47.255 | 1.11x | 52.15-52.62 / 46.42-50.37 |

Profiles (self time, one profiled run each):

| | stress2000 base | stress2000 new | stress4000 base | stress4000 new |
|---|---|---|---|---|
| `TestModelCollisionBox` | 11.2% | - | 13.0% | - |
| `CCastRay::Cast` (inlined walk) | 4.5% | 0.5% | 4.8% | 0.3% |
| `PrepareRayModelHits` (grid query, candidate tests inlined) | - | 4.9% | - | 5.0% |
| `TestBrushSector` | 1.7% | 1.7% | 0.9% | 1.1% |

So the model part of these casts went from ~16-18% of the engine thread to ~5%.

The first version queried the whole ray at once (the 0.1 m row in the verify table above). It was
1.01x at stress2000 and 1.17x at stress4000 in a noisier run, with ~180 candidates per cast and
the grid scan inlined into `Cast` at 13.9% / 17.0%. The short first reach (point 4) cut the
candidates to ~25 per query.

What is still hot at stress4000: `CWorld::ClipMove` (50% self), `ProjectASpheresToB` (10%),
`PrepareProjectionsAndSpheres` (4.5%). That is the collision track, not ray casts. Of the ray
casts, what is left is the grid query (`PrepareRayModelHits`, 5%) and `TestBrushSector` (1%).

Rejected:
- the 0.5 m + 0.01 H margin: wider than the bound needs; 0.1 m + 0.01 H also verified with 0 mismatches;
- the whole-ray query (above);
- round 2's sorted-candidates and box pre-reject versions (`rays2.md`).

Also passed: `bench.mjs --shots` + `shotdiff.py` (8/8 frames ok, 5 bit-identical, the rest
<= 0.002% as usual) and `autogunstest.mjs` (all checks).

## Risks

- **New ways to change `ci_boxCurrent`, `en_plPlacement` or `en_mRotation`.** Anything that
  changes them without the grid update would break the box argument, and nothing would detect it.
  The engine has none today: `SetPlacement_internal`, `FindCollisionInfo` and
  `CopyCollisionInfo` are the only writers, and `CreateEntity` sets the placement before any
  collision info exists.
- **Terrains.** A sector with a terrain always runs the original loop (TFE has none).
- **Huge rays.** Long rays fall back to the walk through the cell limit, so they cost what they
  did before.
