# Perf round 2, track G: model ray casts, timers, the rest of the AI (`rays2`)

Branch `t3/da64f05b`. Area: `CCastRay::TestModelCollisionBox` / `CCastRay::Cast`
(`World/WorldRayCasting.cpp`), `CWorld::AddTimer` (`World/World.cpp`), and the AI handlers
(`FindClosestMarker`, `CEnemyBase::HandleEvent`, `PerformAttack_01`). Scenarios: stress500 and
stress1000, plus stress2000 for scaling.

## Result

Kept: one change, `perf(timers)` (3b37b47). The ray-cast experiments were exact but did not beat
r1, so none of them was committed (see "Tried and dropped").

Final bench (4 reps, `perfbench --check`). `base` is this branch's parent (r1 plus d1634b4), built
the same way, so `new` vs `base` isolates this track's change.

| scenario | ref | r1 | base | new | new vs ref |
|---|---|---|---|---|---|
| stress500 mean | 6.175 ms | 3.782 | 3.762 | 3.698 | 1.67x |
| stress1000 mean | 36.279 ms | 5.602 | 5.609 | 5.712 | 6.35x |
| demo mean | 0.305 ms | 0.277 | 0.274 | 0.275 | 1.11x |
| stress2000 mean (3 reps, no check) | 46.257 ms | 30.723 | 30.664 | 33.394 | 1.39x |

Check: "SAME simulation, 384 ticks" for r1, base and new (final 7d4eb99b).

The wall-clock means of `base` and `new` differ by less than their spreads: stress1000 base
5.568–5.691, new 5.650–5.715. At stress2000 the spreads are 30.4–33.2 and 31.3–35.7, and the extra
time sits in `CWorld::ClipMove` (track F's code, which I did not change). The steadier signal is the
profile share of the timer insert:

| profile share | stress500 | stress1000 | stress2000 |
|---|---|---|---|
| r1: `SetTimerAfter` (inlines `AddTimer`) | 1.1% | 1.2% | 1.3% |
| base: `SetTimerAfter` | 1.0% | 1.0% | 1.4% |
| new: `AddTimer` | 0.3% | 0.2% | 0.3% |

That is ~0.8% of the frame at stress1000, about 0.04 ms. That is real but below the wall-clock noise
of a shared machine.

My area's share of the r1 profile (stress1000):
- `CWorld::CastRay` inclusive: 7.7%. `TestModelCollisionBox` self: 4.2–4.9%. `Cast` self: 1.8%.
  `TestBrushSector` self: 1.1–1.4%.
- `SetTimerAfter`: 0.8–1.5%.
- AI self time: `FindClosestMarker` 0.4–0.8%, `CEnemyBase::HandleEvent` 0.7–0.9%,
  `PerformAttack_01` 0.5–0.8%.
- `SetPlacement_internal`: 1.0%, 98% of it from `TryToMove`, so it is movement, not AI.

Functional tests against the final build: `svtest` and `flowtest` pass. `bottest` passes
everything except "bots fight", which is flaky and fails on base too: new passed it 1 of 2 runs,
base failed its run. The check looks at the latest bot status line, and by then the bots had
stopped fighting.

## Timers (kept)

**What was slow.** Round 1 made `AddTimer` scan from the tail instead of the head. With
`SE1_TIMER_VERIFY` counting at stress1000, that scan still stepped over ~165 nodes per insert,
across 491520 inserts. Enemies re-arm to random delays (the attack move frequency, `wait()` in the
AI), so a new due time usually lands deep inside a list of ~1000 timers. Each step is a dependent
pointer chase into a different entity.

**First try: skip runs of equal times.** A direct-mapped table held the first timer of each due
time. It was exact (0 mismatches against the plain scan) but cut only 168 → 102 steps per insert,
about 7 skips each. Due times are mostly distinct, so runs are short.

**The change.** Each 1/64 s bucket of due times remembers the timer last inserted into it
(`_apenTimerHint`, 1024 slots, so 16 s before slots alias).
- **Choosing a hint.** The scan looks at the new time's bucket, then the 3 before it, then the 3
  after it. A hint is used only after checking, on the list as it is now, that it is linked in this
  world's list (`en_pwoWorld`, `IsLinked`) and that its current time falls in the bucket it is
  filed under.
- **Finding the insert point.** If the hint's time is below the new time, the scan walks forward
  while the next node is below the new time. Otherwise it walks back while the node is >= the new
  time, as the tail scan does. In a sorted list both walks end on the last node with t < x, which
  is the node the original scan finds. The list is always sorted: round 1 showed that, and a NaN
  time still switches to the original head scan.
- **Clearing entries.** A new `~CRationalEntity` (under `__EMSCRIPTEN__`) clears the destroyed
  entity's entries, so they never dangle. A stale, moved or colliding entry fails the check, and
  with no usable hint the tail scan runs as before.

**Verified.** `SE1_TIMER_VERIFY=1` at stress1000 runs the plain tail scan next to the new one on
every insert: 491520 inserts, 0 mismatches, 96% hinted, 25 steps per insert instead of 165 (6.6x
fewer).

## Tried and dropped (ray casts)

All three ray experiments gave identical results, and none was faster.

1. **Grid candidates (the WIP from the earlier attempt, finished).**
   - **The idea.** Find the models a `TT_COLLISIONBOX` ray could touch through the collision grid
     (`FindEntitiesNearBox` along the segment, in pieces). Then test only those, sorted back into
     each sector's list order with a per-link order key added to `CRelationLnk`.
   - **Exact.** 235520 casts, 186M sector entities checked, 0 missed.
   - **Much slower.** stress1000 11.97 ms vs r1 5.91; stress500 4.20 vs 3.22. At ~800 monsters per
     ray, preparing the candidates cost far more than the walk: `std::sort` of the pointers was 22%
     self, `FindEntitiesNearBox` 15%, the link sort 4.5%. The rays converge on the player, where
     the horde is densest, so the candidate sets stay large.
   - Reverted, including the `Relations.h` order key and the `InitAs*` grid-type hooks.
2. **Box pre-reject in `TestModelCollisionBox`.**
   - **The idea.** Per cast, build the box of the ray points a sphere hit can be accepted at
     (d in (-testR, hitDist)), grown by testR and generous float margins. Skip models whose
     `ci_boxCurrent` misses it. This is safe because the spheres lie inside the box, the hit
     distance only falls during a cast, and the test has no other effect.
   - **Exact.** `SE1_RAYBOX_VERIFY` at stress1000: 524288 casts, 285M models skipped (~545 of ~800
     per ray), 0 missed.
   - **No faster.** stress1000 5.70 vs r1 5.78, stress500 3.52 vs 3.53. The profile put
     `TestModelCollisionBox` self *higher* (4.9 → 7.0%; branch-free variant 5.1 → 8.4%). The cost
     per model is the memory chase (sector link → entity → collision info → box), not the
     arithmetic the pre-reject saves.
   - Reverted. The diff is kept outside the repo.
3. **Branch-free variant of 2.** Same result as 2.

## Remaining AI

- **`FindClosestMarker`.** It uses `FindSectorsAroundEntityNear`, which rebuilds its sector cache
  only for sectors that changed, so rebuilds are rare. The remaining 0.4–0.8% is the marker loop
  itself; I found no exact win there.
- **`CEnemyBase::HandleEvent` / `PerformAttack_0x`.** Self time is mostly ecc state-machine
  dispatch. Their inclusive time (11–14%) is the ray casts (`FireOrHit` → `CanHitEnemy` /
  `CanAttackEnemy` → `IsVisibleCheckAll`, 7.2% inclusive) and the timers.

## Risks

- **Sorted list.** The timer hint relies on the timer list being sorted, the same assumption as
  round 1's tail scan; a NaN time still switches to the original head scan.
- **Destroyed entities.** Hints point at entities, so any way of destroying a `CRationalEntity`
  that skips its destructor would leave one dangling. All entity deletion goes through the virtual
  destructor.
- **Cost on destruction.** `SE1_TimerEntityGone` loops over the 1024 slots on every entity
  destroyed, ~1 µs each. Projectiles die often, but it doesn't show in the profile.
- **Multiple worlds.** The hint table is global. Hints from another world fail the `en_pwoWorld`
  check.

## Next ideas

- **Model ray casts need fewer memory touches per model, not less arithmetic.** For example, a
  per-sector packed array of (entity, box) for models with collision info, updated in
  `SetPlacement_internal` where `ci_boxCurrent` changes. The ray walk would then read 28 bytes per
  model instead of four scattered cache lines. The catch: the ray must still visit models in the
  sector's link order, so ties go to the first one, and every link add or remove must keep the
  array in step.
- **Fewer `IsVisibleCheckAll` casts per horde member.** `FireOrHit` evaluates `CanHitEnemy` /
  `CanAttackEnemy` only when the distance test passes. Those calls are already lazy, and caching
  results across ticks would change the simulation.
- **ClipMove.** At stress2000 it is two-thirds of the frame (track F).
