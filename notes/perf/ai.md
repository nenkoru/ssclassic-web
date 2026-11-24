# Perf track A: AI and path finding

Branch `t3/ai-pathfinding-optimization`. The perf build is `tools/optbuild.sh` (build-opt), served
with `tools/perfsnap.py` on port 8201. The bench is `tools/perfbench.mjs` against the shared ref
on 8181. Every change is guarded so that only the web build (`__EMSCRIPTEN__`) takes it.

## Result

`perfbench --check --reps 3`. The numbers are engine ms per frame (the median of three reps).

| scenario | ref | new | speedup |
|---|---|---|---|
| stress500 | 6.132 | 4.595 | 1.33x |
| stress1000 | 39.504 | 11.082 | 3.56x |
| demo | 0.324 | 0.322 | 1.01x (no change, as expected) |

Check: `SAME simulation`, 384 ticks, ref final 7d4eb99b, after each change.

The functional tests ran one at a time against the final build on 8201, and all passed:

- flowtest: intro, click into a demo, Escape to the menu.
- svtest: level-up, pause, upgrade, spawns, kills, chest evolution.
- bottest: join, nav built, move, fight, the human unaffected.

The ref drifts by about 5% between runs: stress500 ranged 5.6 to 6.3 ms and stress1000 36 to
40 ms over the session. Compare the speedups within one run, not the absolute numbers across runs.

## What was slow

These shares are worker self time in the ref build's profile:

| function | stress500 | stress1000 | why |
|---|---|---|---|
| `CEnemyBase::StartPathFinding` (inlined `FindClosestMarker`) | 9.8% | 19.0% | every call walked every entity in the enemy's sectors |
| `strcmp` (from `IsOfClass`) | 3.2% | 5.0% | 57% of it came from StartPathFinding: an `IsOfClass(pen, "NavigationMarker")` per entity |
| `CDLLEntityClass::HandlerForStateAndEvent` | 3.0% | 3.3% | a linear walk of the class's handler table, then its base classes', for every event |
| `PerformAttack_03` self (inlined `CWorld::AddTimer`) | 1.1% | 2.7% (4.2% after change 2) | a sorted insert that scans from the head of the timer list |
| `CCastRay::Cast` | | 16.4% | about half the rays came from path-finding checks whose result was thrown away |

Each enemy that touches another enemy or a wall in a horde starts path finding. In
FindClosestMarker it walked the entities of each sector it is in (`bsc_rsEntities`), so the cost
was O(enemies × entities in the sector) per tick, with a strcmp for every entity.

## Changes

### 1. Per-sector marker cache and a handler cache (3d8304e)

`Engine/Base/Relations.{h,cpp}` and `Entities/Common/PathFinding.cpp`:

- Each `CRelationSrc` gets a generation number, taken from a global counter. It changes whenever a
  link is added (the three `AddRelationPair*`) or removed (`~CRelationLnk`).
- FindClosestMarker keeps, for each sector, the vector of its NavigationMarker entities, in list
  order. It rebuilds the vector when the sector's generation changes.
- Iterating the vector visits the same markers in the same order as the old loop, with the same
  `<` comparison, so the same marker wins every tie.

`Engine/Entities/EntityClass.cpp`: HandlerForStateAndEvent caches, per (class, state), the handler
the walk found. The cache is direct-mapped, `thread_local`, 2048 entries, keyed by the class
pointer and the state. On a miss it does the original walk. Handler tables never change after a
class loads.

stress500 went from 5.76 to 5.09 ms (1.13x). StartPathFinding fell from 8.9% to 0.2% and
HandlerForStateAndEvent from 3.9% to 0.4%.

### 2. Skip the path-finding ray when no first marker exists (997797d)

`Entities/EnemyBase.es` and `Entities/Common/PathFinding.h`:

- CheckTouchForPathFinding and CheckFallForPathFinding cast `IsVisible(m_penEnemy)` only to choose
  between DT_PATHPERSISTENT and DT_PATHTEMPORARY, then call StartPathFinding.
- Every StartPathFinding (EnemyBase, EnemyFly in the air, EnemyDive) overwrites that choice with
  DT_PLAYERSPOTTED when PATH_FindFirstMarker finds no marker. Neither the ray nor the search has
  side effects.
- The new `NoFirstPathMarker()` runs the search first and skips the ray when it fails.
- Inside an .es function body ecc does not accept `#if`, so the switch is the constant
  `PATH_SKIP_UNUSED_RAYS`, which PathFinding.h sets to 1 under `__EMSCRIPTEN__`.

Instrumentation (since removed) showed about 46k IsVisible calls per 2 s at stress500. 54% of them
were same-tick duplicates, and about 21k of those came from this site.

With changes 1 and 2: stress500 5.80 to 4.33 ms (1.34x), stress1000 37.8 to 11.1 ms (3.42x).

### 3. Insert timers from the tail of the sorted list (bc13eb1)

`Engine/World/World.cpp`, `CWorld::AddTimer`:

- The old code scanned from the head for the first timer with `t >= x` and inserted before it.
  Every enemy re-arms its timer every tick, mostly to the latest time, so with n enemies that
  costs O(n²) per tick.
- `wo_lhTimers` is always sorted non-decreasing:
  - every insert goes through AddTimer;
  - removals (HandleTimers, UnsetTimer, OnInitialize) keep the order;
  - AdjustLateTimers raises an overdue prefix to the current time;
  - loading TMRS restores the saved order;
  - Copy and Read_t go through AddTimer;
  - SetTimerAt writes `en_timeTimer` while the timer is still linked, but AddTimer unlinks it
    before scanning.
- So "after the last timer with `t < x`", found from the tail, is the same place as before.
- A NaN time would break the sorted invariant, so after the first NaN the original scan is used for
  the rest of the run.

At stress1000 the 4.2% of PerformAttack_03 self time became SetTimerAfter at 1.0%, and the speedup
against ref rose from 3.42x to 3.56x. The remaining 1% comes from timers re-armed to shorter delays
than their neighbours', so the tail scan still passes some entries.

## Where the time goes now (stress500, new build)

What is left on the AI path is rays and movement, which belong to the other tracks:

- FireOrHit is 4.6% inclusive, nearly all of it `IsVisibleCheckAll`.
- PerformAttack_01, _02 and _03 are each about 7% inclusive, mostly rays and timers.
- FindClosestMarker is 0.3%, HandlerForStateAndEvent 0.3%, and strcmp no longer shows in the
  profile.
- The biggest self costs are ClipMove, PrepareProjectionsAndSpheres, FindEntitiesNearBox and
  model rendering (UnpackFrame, RenderModel).

## Risks

- **Marker cache:** correctness depends on every link change going through
  `AddRelationPair*` / `~CRelationLnk`. Today it does: `CRelationSrc::Clear` and
  `CRelationDst::Clear` delete their links, and nothing else adds or removes `rl_lnSrc` nodes.
  - The cache is keyed by sector pointer. A freed sector whose address gets reused by a new sector
    is still safe, because the new sector's constructor takes a new generation number.
  - The unordered_map grows by one entry per sector that has ever been searched. That is small
    and bounded by the sectors in the levels played.
- **Handler cache:** it assumes a class's handler tables are fixed once the class is loaded, which
  they are (they are compiled in). Each thread has its own cache.
- **Skipping the ray:** this relies on every `StartPathFinding` override writing
  DT_PLAYERSPOTTED when there is no first marker. A future override that reads `m_dtDestination`
  before that point would break it. The comment on `NoFirstPathMarker()` says so.
- **Timer insert:** it relies on the sorted invariant above. Any new code that writes
  `en_timeTimer` on a linked timer without going through AddTimer would break it, and the
  original code would then misbehave in the same way, just with different ordering.

## Next ideas

- **FireOrHit:** CanHitEnemy and then CanAttackEnemy can cast the identical
  `IsVisibleCheckAll` ray in the same tick when the enemy is in close range but not visible.
  Memoise it between the two calls; nothing runs in between that changes the world. It is about
  1.5k of the 46k rays per 2 s, so under 1%.
- **Shared same-tick visibility:** many enemies cast rays at the same player from nearby spots
  every tick. A per-tick cache keyed by (sector, target) cannot be exact, so this needs a
  ray-track (CCastRay) design.
- **Timers:** a bucketed or heap timer queue would remove the remaining 1%. It must keep the
  FIFO order among equal times.
