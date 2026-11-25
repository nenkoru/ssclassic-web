# Scale track L: more than one CPU core for the engine

This work is on branch `t3/69e5b341`. The perf build is `tools/optbuild.sh` (build-opt). It was
served with `tools/perfsnap.py build-opt threads2 --port 8233` and benched with `tools/perfbench.mjs`
against the shared ref (8181) and the round-1 build r1 (8192).

**Short version: correct, but no speedup yet.**

- I built a fork-join job pool and a parallel collision prefetch for the mover loop, behind
  `?mt=N`. The prefetch's results are bit-exact: `--check` gives SAME, and the serial cross-check
  found 0 mismatches in about 500k checks.
- It doesn't make frames faster. At `?mt=4` it saves about as much engine-thread time as it
  costs.
- The pool is the reusable part. The prefetch shows what the mover loop's ordering allows, and
  what it would take to get more (see the last section).

## Result

This is from `perfbench --check --reps 3`, one run with the builds in the order ref, r1, new. The
numbers are engine ms per frame, the median of three reps. new is this branch: `?mt=1` is the
serial path, and `?mt=4` is 4 threads with the prefetch on.

| scenario | ref | r1 | new `?mt=1` | new `?mt=4` | `?mt=4` vs ref | `?mt=4` vs `?mt=1` |
|---|---|---|---|---|---|---|
| demo | 0.301 | 0.279 | 0.277 | 0.270 | 1.11x | 1.03x (noise) |
| stress1000 | 36.085 | 5.675 | 5.723 | 5.835 | 6.18x | 0.98x |
| stress2000 | 38.022 | 30.757 | 37.093 | 38.964 | 0.98x | 0.95x |
| stress5000 | not measurable | not measurable | | | | |

Check: **SAME simulation** for r1, `?mt=1` and `?mt=4` (demo, 384 ticks, ref final 7d4eb99b).

- **stress2000 is very noisy.** One build's means spread over 26–40 ms between reps, and ref's
  frames alternate (p50 5 ms, p95 140 ms). The medians of frame times (p50) are steadier, so I
  reran with my own base commit included (`base` = 15426e5 without this branch):

  | stress2000 p50 | r1 | base | new `?mt=1` | new `?mt=4` |
  |---|---|---|---|---|
  | ms | 35.0 | 35.5 | 36.6 | 39.1 |

  So the serial path (`?mt=1`) costs nothing measurable over its base, and `?mt=4` is about 7%
  slower. The r1-to-base difference most likely comes from d1634b4 (the collision skip limited to
  flat sectors), which is in my base but not in the r1 snapshot.
- **stress5000 couldn't be measured.** Neither ref nor r1 reached 5000 live monsters within the
  readiness timeout, even tripled to 9 minutes (`SE1_TIMEOUT_SCALE=3`). The stress spawner adds 16
  per frame, and frames get very slow on the way.
- **The ref-relative speedups are round 1's**, not this track's: compare new against r1/base.


## What was slow, and why threads are hard here

These are shares of the engine worker's self time with `?mt=1` at stress1000, from the r1-based
build, 5.6 ms per frame. Collision and visibility track F had already landed.

| function | share |
|---|---|
| `CClipMove::ClipMoveToModel` | 14.6% |
| `CModelObject::RenderModel` | 8.8% |
| `CClipMove::ClipMovingPointToSphere` | 8.1% |
| `CWorld::FindEntitiesNearBox` | 7.8% |
| `put_vertices`, `UnpackFrame` (model rendering) | 9.5% |
| `CCastRay::TestModelCollisionBox`, `Cast` | 6.4% |
| `CClipMove::ClipMoveToBrushes` | 3.9% |
| `CWorld::ClipMove` | 3.0% |

In inclusive time:

- `CSessionState::HandleMovers` is 52.9% of the engine thread;
- `CWorld::ClipMove` and everything under it is 44.3%;
- `CRenderer::RenderModels` is 28.1%.

The simulation's big cost sits in `CSessionState::HandleMovers`. This loop is **serial by
definition**:

- Each mover's `TryToMove()` clips its move against the world as the movers before it left it,
  then moves, possibly pushing others.
- Running movers in parallel changes who sees whom where, which breaks `--check`.

So the only exact way to parallelize it is to compute each mover's work **ahead** on the frozen
world, then check at its serial turn that what it read is still the same.

Other candidates I looked at:

- **Pipelining the tick with rendering.** Rendering runs on the same engine thread right after
  the tick and reads the entities the tick writes. A pipeline would need a full snapshot of the
  render state (placements, model animations, lights) per frame. That is a big cross-cutting
  change in track H's and I's code, so I didn't start it.
- **Parallel per-model rendering.** `RenderModel` / `UnpackFrame` / `put_vertices` write into
  shared static vertex buffers and issue GL calls inline. To split them, the vertex prep first
  has to move out of the draw path, which is track H's area. The pool is ready for it (see
  next steps).
- **Read-only phases inside a tick.** Apart from the movers' collision, the tick's costs are
  entity handlers (AI, timers, rays) that send events and change state, so they aren't read-only.
  Rays and AI are track G's.

## Changes

### 1. Se1Jobs: the job pool (`port/common/Se1Jobs.{h,cpp}`)

- `SE1Jobs_ParallelFor(ct, grain, fn, ctx)` splits an index range over the engine thread and
  N−1 helper pthreads. It returns when all of it is done.
- One section runs at a time. Its parameters sit in two slots chosen by generation parity. A
  helper claims a chunk with a compare-exchange on a 64-bit (generation, next index) word, so a
  helper that wakes late can't run the wrong section's chunk.
- Helpers spin for a short while after a section, then sleep on a futex.
- A nested call, or `?mt=1`, runs inline.
- The thread count comes from `Module.se1Mt`. `port/web/pre.js` sets it from `?mt=N`, capped at
  16. With no `?mt`, no helper starts.
- The single-threaded build always runs jobs inline.
- Jobs may only read shared engine state and write their own slot. The caller applies results in
  index order, so the outcome doesn't depend on the thread count.

### 2. ClipPrefetch: movers' first collision test, ahead and in parallel (`port/common/ClipPrefetch.{h,cpp}`)

**Before the mover loop.** `SE1Clip_BeginMoveLoop` runs after every active mover's `PreMoving()`.
It skips the prefetch unless `?mt` > 1 and there are ≥ 32 model movers. Then, in parallel and for
each mover:

- It predicts the first `ClipMove` the mover's `TryToMove` will make: the next position and
  rotation from the intended and applied placement, exactly as TryToMove computes them.
- It replays the **brush part** exactly, on per-thread copies:
  - `CacheNearPolygons`;
  - `ClipMoveToBrushes` over the mover's sectors, using an array and hash set for the active
    sectors;
  - the zoning-sector walk.
- It runs the **model part** as one independent `ClipMoveToModel` per candidate. Each one starts
  from the brush result, and the job keeps the local hit together with the bits of the
  candidate's state that it read:
  - ID, collision flags, box, placement and rotation;
  - the end placement, if the candidate is movable;
  - its spheres.
- It records only candidates whose box overlaps the move's path box, using the same test that
  `ClipMoveToModel` starts with.
- It gives up a mover, and the serial code runs as before, when the job would have side effects:
  - a pass event;
  - adding a reference mover;
  - terrain;
  - a movable brush the mover stands on.

**At the mover's turn.** `SE1Clip_ClipMove` is called from `CWorld::ClipMove`.

- If the epoch is unchanged and every input matches bitwise, it applies the brush result:
  - the inputs checked are the move's start, end and path box, the collision flags, the cached box
    and its estimate, the spheres, the sector list and any movable brush's next placement;
  - the near-polygon cache is copied in if the job rebuilt it.
- It then walks the real candidate list, the same `FindEntitiesNearBox` call in the same order.
  For each candidate:
  - **box misses the path:** skipped, since `ClipMoveToModel` would return at once;
  - **state bitwise unchanged:** the job's hit is applied if its fraction is strictly below the
    running one, which is the original update rule;
  - **anything else:** `ClipMoveToModel` runs serially, as before.
- The serial update keeps the first strict minimum, and each per-candidate test only depends on
  that candidate and the running fraction. So this merge gives the same hit entity, polygon,
  fraction, plane and clipped line as the serial walk.

**Epoch.** `SE1Clip_WorldChanged` drops every prefetched result when the brush world changes
during the loop:

- a brush `SetPlacement`;
- a non-model's `FindCollisionInfo`;
- a non-model's `Destroy`.

**Test options.**

- `?mtverify=1` also computes every answer serially and compares the two bitwise, printing
  `clipprefetch: MISMATCH` lines.
- `?mtstats=1` prints use counts every 100 ticks, also in `Module.se1ClipStats`.
- `?mtmin=N` changes the 32-mover floor.

### Places touched (all `#ifdef SE1_CLIPPREFETCH`, marked `web port (threads)`)

`SE1_CLIPPREFETCH` is defined only in the threaded build (`SE1_THREADS`, `port/CMakeLists.txt`).
Without `?mt` > 1, every hook is one call that returns at once.

| file | place | what |
|---|---|---|
| `Engine/Network/SessionState.cpp` | `HandleMovers`, after the PreMoving loop / after the move loop | `SE1Clip_BeginMoveLoop` / `SE1Clip_EndMoveLoop` |
| `Engine/World/WorldCollision.cpp` | `CWorld::ClipMove` top | `if (SE1Clip_ClipMove(this, cmMove)) return;` |
| `Engine/World/WorldCollision.cpp` | `GetPositionsOfEntity`, `SendPassEvent` | in a job: don't add the reference mover / don't send the event, mark the result unusable |
| `Engine/World/WorldCollisionGrid.cpp` | new `SE1Clip_GridEntitiesNearBox` | `FindEntitiesNearBox`'s cell scan with no shared writes (for jobs) |
| `Engine/Entities/Entity.cpp` | `SetPlacement_internal` brush branch, `FindCollisionInfo`, `Destroy` | `SE1Clip_WorldChanged()` for brushes / non-models |
| `port/CMakeLists.txt` | | `SE1_CLIPPREFETCH`, the two new sources, `port/common` include dir for engine and engine_safemath |
| `port/web/pre.js` | | `?mt`, `?mtstats`, `?mtverify`, `?mtmin` |

Merge notes for the other tracks:

- **Track F (collision).** It changes `ClipMoveToBrushes`, `CacheNearPolygons` and
  `ClipMoveToModel`. If its brush code changes, the replica in `ClipPrefetch.cpp` (`JobCacheNearPolygons`,
  `JobClipMoveToBrushes`, `JobClipToZoningSector`) has to follow it. `?mtverify=1` catches a
  divergence on the first tick.
- **The model part.** It calls the engine's own `ClipMoveToModel`, so it follows F's model
  changes automatically.

## Correctness

| check | result |
|---|---|
| `perfbench --check`, demo, 384 ticks | ref final 7d4eb99b. r1, `?mt=1`, `?mt=4`, `?mt=6` and `?mt=4&mtmin=1` (prefetch on every loop): all **SAME simulation** |
| `?mt=4&mtverify=1&mtstats=1`, stress1000, 200 ticks | 182,698 answers verified, **0 bad**; 993 of 993 movers per tick prefetched and used |
| `?mt=4&mtverify=1`, stress2000, 200 ticks | 330,997 verified, **0 bad** |
| svtest, bottest, flowtest on `?mt=4&mtmin=1` (prefetch on every tick) | all PASS |

The stress scenarios aren't deterministic from run to run, even at `?mt=1` against itself: the
per-tick hashes of two runs of the same build diverge around tick 57. I didn't chase the cause,
which is outside this track. So `--check` only covers the demo, and stress correctness was checked
with `?mtverify`. That compares each prefetched answer with the serial one inside the same run.

## Why it doesn't pay off

Here are the per-tick stats at stress1000 with `?mt=4`:

- 993 movers prefetched, all used;
- 2434 candidate tests reused, 2314 retested serially;
- the parallel section takes 1.03 ms of wall time.

The profile of the engine thread (`?mt=4` against `?mt=1`) shows the trade:

- `ClipMoveToModel` falls from 14.6% to 10.9%.
- `ClipMovingPointToSphere` falls from 8.1% to 7.5%.
- In exchange, the engine thread takes on:
  - its own share of the jobs (`PrefetchJob`, 4.0%);
  - the wait for the slowest helper;
  - the consume checks (`CWorld::ClipMove` 3.0% → 3.9%);
  - the merge walk (`ClipMoveToModels` 2.2%).
- `FindEntitiesNearBox` is unchanged at 7.8%, because the serial walk still has to run it to get
  the real candidate order.
- In inclusive time, `CWorld::ClipMove` falls from 44.3% to 40.9%. But `HandleMovers`, which
  includes the parallel section, rises from 52.9% to 54.6%.

The deep reason is the loop's ordering:

- About half the neighbours a mover tests have already moved by its turn, so their prefetched
  tests are stale and get retested.
- Only the first `ClipMove` of each mover is prefetched. A mover that hits something retries with
  a new, unpredictable move.
- So at most about a quarter of the collision work leaves the engine thread, and the fork-join
  plus the checks cost about the same.

On this 12-core Mac (6 performance, 6 efficiency) the helpers also share cores with the other
tracks' Chromes, which makes `?mt=N` noisier than `?mt=1`.

## Risks

- **Pointer lifetime.** Prefetched records hold `CEntity*` and polygon pointers taken before the
  loop. A candidate destroyed during the loop:
  - is not in the real candidate list any more, so it is never looked up;
  - can't be freed before the loop ends, because entities are freed at the end of the tick.

  A brush destroyed or rebuilt bumps the epoch.
- **Epoch coverage.** Any new way for brush geometry or sector links to change mid-loop has to
  call `SE1Clip_WorldChanged`. Otherwise the prefetch could read stale data. `?mtverify` is the
  test for this.
- **`?mtverify` itself** runs the serial clip a second time. That can send pass events twice, so
  it is only for tests.
- **Default is off.** Without `?mt` > 1, no helper thread starts and the prefetch never runs.

## Next steps

1. **Predict the neighbours' end state too.** For a candidate that will move before the mover,
   also test against its predicted end placement, which is its own prefetched first move when
   that has no hit. The retest share would fall from about 50% toward the share of movers that
   actually hit something.
2. **Skip the serial `FindEntitiesNearBox`.** When no grid entry in the box changed since the
   prefetch, the job's own candidate list, deduplicated in grid order, is the real one. That needs a
   per-cell generation in the collision grid.
3. **Model rendering on the pool (track H).**
   - The pool is general: rendering could split `RenderModel` into a parallel vertex-prep phase
     (`UnpackFrame`, `put_vertices`, lighting into per-model buffers) and a serial draw phase.
     That is about 28% of the stress1000 engine thread (`RenderModels`, inclusive), and it is embarrassingly parallel. The frames stay
     the same as long as each model's buffer is filled by exactly the code that fills it now.
   - This is likely the biggest gain left for threads, but it is a restructuring in track H's
     code.
4. **Overlap rendering of frame N with the tick of N+1.** This needs a render-state snapshot.
   It is the larger refactor described above.
