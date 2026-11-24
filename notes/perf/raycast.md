# Perf track B: ray casting (`raycast`)

Branch `t3/raycast-culling`. Area: `src/SamTFE/Sources/Engine/World/WorldRayCasting.cpp`
(`CCastRay::Cast`, `TestBrushSector`, `TestModelCollisionBox`), scenario `stress500`.

## Result

| | stress500 mean | demo mean | ray casting, inclusive share (stress500) |
|---|---|---|---|
| ref | 5.885 ms | 0.304 ms | 20.0% (~1.18 ms per frame) |
| this branch (961f275) | 5.384 ms (1.09x, see the noise note) | 0.303 ms | 7.8% (~0.42 ms per frame) |

Ray casting costs about 2.8x less. Every kept step passed `perfbench --check`:
"SAME simulation, 384 ticks".

Scaling: stress1000 went from 37.876 to 20.963 ms mean (1.81x; p95 73.8 → 35.0 ms; 20 → 33 fps).
That is one rep without the check. Ray casts grow with the monster count times the sectors per
cast, so the culling pays off more as the count rises.

Functional tests against the final build (8202): `svtest`, `bottest` and `flowtest` all pass.

Per-step benches (3 reps each, ref = the frozen build on 8181):

| step | stress500 ref → new | demo ref → new | CastRay inclusive | self: TBS / Cast / TMCB / AddAll |
|---|---|---|---|---|
| ref profile | | | 19.4–20.0% | 9.2 / 9.0 / 1.2 / – |
| 1. brush-only casts walk only brush and terrain entities; sector box cull (745057c) | 5.823 → 5.014 (1.16x) | 0.314 → 0.312 | 9.4% | 5.2 / 2.0 / 1.6 / 0.6 |
| 2. polygon box pre-check before the edge walk (961f275) | 5.862 → 4.985 (1.18x) | 0.323 → 0.327 | 8.4% | 4.6 / … |
| 3. closed edge loops: full-box cull (961f275) | 5.885 → 5.384 | 0.304 → 0.303 | 7.8% | 4.0 / 1.6 / 1.5 / 0.7 |
| 4. packed per-sector planes and entity array (rejected) | 5.967 → 5.448 | 0.321 → 0.314 | 8.2% | 4.1 / 1.1 / 1.5 / 0.7 + 1.0 hash/upkeep |

Noise: the machine was shared with the other tracks' benches, and wall-clock means moved by
±0.3 ms between runs of the same code (step 3 removes work from step 2's code, yet measured
1.09x against step 2's 1.18x). Use the profile shares as the steadier signal.

## What was slow and why

I counted with temporary instrumentation (stress500, per cast):

- About 91% of casts are `TT_NONE` (`CEnemyBase::IsVisible`: brushes only). The rest are
  `TT_COLLISIONBOX` (`IsVisibleCheckAll`, bullets, weapons).
- The world brush is linked into its own sectors, so every cast reaches every world sector
  through `AddAllSectorsOfBrush`: about 17 sectors per cast, 15.5 of them added that way.
- Each sector's entity list was walked in full for every cast: about 450 entities per cast,
  355 of them models. A `TT_NONE` cast ignores models, so that walk was pure overhead and made
  `Cast` self time 9%.
- `TestBrushSector` ran the plane test on every polygon of every reached sector (about 270 per
  cast). It ran the edge walk (`CIntersector`) about 28 times per cast to get about 1 real hit.

## Changes (all in the engine, each guarded only by being exact)

1. **Brush-only casts skip non-brush entities** (`TestThroughSectors`). For `TT_NONE`, the
   per-sector loop walks a cached list of the sector's `RT_BRUSH`/`RT_TERRAIN` entities, in the
   original list order, with the same per-entity body. The cache is checked against:
   - a stamp on `CRelationSrc` (`Base/Relations.*`), bumped by every link and unlink;
   - a global counter bumped where an entity's render type can become or stop being brush or
     terrain (`InitAsBrush`, `InitAsTerrain`, `CEntity::Copy`).

   Other modes keep the original loop.
2. **Sector cull** (`SectorMayBeHit`). A polygon can only be hit if the hit point lies on the
   ray within `cr_fHitDistance`, and if (from `CIntersector`'s crossing rule) it is inside the
   polygon's vertex range on the second major axis and below its max on the first. So a sector
   is skipped when the ray segment `[0, hitdist]` can't enter the box's upper half-slab for any
   of the three major-axis pairs.
   - It works in double, with a relative margin.
   - It is off for degenerate or huge rays and for an infinite hit distance.
3. **Polygon box pre-check.** After the plane test, the same rule is applied to the hit point
   and `bpo_boxBoundingBox` before the edge walk. The box is the exact min/max of the same
   vertices (`CBrushPolygon::CalculateBoundingBox`), and float comparisons against those same
   values are exact. NaN hit points pass through to the intersector as before.
4. **Closed edge loops** (`SectorHasClosedLoops`). If every vertex of every polygon has an
   even edge count, a point left of all vertices has an even crossing count. So the left bound
   is valid too, and the sector cull uses the full box. The result is cached per sector in
   `BSCTF_RAYLOOPS*` temp flags, which are cleared in `CBrushSector::CalculateBoundingBoxes`
   (the only runtime writer of vertex, box and plane data; moving brushes call it).

Hit results are unchanged. Every skipped polygon is one the original code would have rejected,
and the order in which candidates are tested and accepted (which decides ties) is untouched.

Rejected: step 4 kept a packed copy of each sector's planes (for an early plane reject without
the `bpo_pbplPlane` pointer chase) and an all-entities array for the other cast modes. The
results were the same, but the `unordered_map` lookup and upkeep cost more than they saved. The
diff is kept outside the repo.

## Risks

- Brush-only casts rely on the stamp and type counter catching every change to a sector's entity
  list or an entity's render type. Relations change only through `Base/Relations.cpp`, and render
  type changes only through the three places above (the editor's `CSG` paths rebuild sectors).
- The sector cull's margin, `0.01 + 1e-4 * (|origin|max + hitdist)`, is generous compared with
  float error at these scales. A sector that should be tested but is culled would change hits;
  the simulation check and the functional tests show none.
- The map of cached sector lists is cleared above 65536 entries. Stale keys from freed sectors
  are harmless because a new sector's stamp never matches.

## What to try next

- Give `CBrushSector` a direct pointer to its ray cache instead of the hash map. This is what
  made step 4 a wash. With it, the packed planes and the entity array for the other modes could
  pay off (Cast self went 1.6 → 1.1).
- A per-sector polygon BVH, or reusing the sector BSP for the ray: `TestBrushSector` (4.0%) still
  plane-tests about 94 polygons per cast in the sectors that pass the cull.
- At the call site (AI track): `IsVisible` casts from each monster to the player every think, so
  results within one tick for the same origin cell and target could be shared. That only holds if
  it is proven not to change the simulation, so it belongs to whoever owns `EnemyBase.es`.
