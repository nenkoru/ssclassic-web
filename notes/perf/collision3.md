# Perf round 3: collision between movers at 4000 monsters

On top of round 2 (`notes/perf/collision2.md`). Area: `Engine/World/WorldCollision.cpp` and
`WorldCollisionGrid.cpp`. Both changes are under `#ifdef __EMSCRIPTEN__` and keep the simulation
bit-identical. Each was checked with a temporary verify build that ran the old test next to the
new one and counted mismatches.

## Where stress4000 spends its time

At 4000 monsters, they crowd around the player, so each mover's movement box touches many
others. Per `CClipMove` (counting build, stress4000):

| What | Per ClipMove |
|---|---|
| grid records scanned | 228 |
| records whose box touches the movement box | 16 |
| sphere lanes in the SIMD pre-test | 248 |
| scalar sphere clips after the pre-test (round 2) | 69 |

Profile, self time (with a dummy second call site so binaryen keeps the functions apart):
`SE1_FindEntitiesTouchingBox` 32.2%, `ClipModelMoveToModel` 26.7%, `TestModelCollisionBox`
8.8%, `ProjectASpheresToB` 8.1%, `CCastRay::Cast` 3.0%, `ClipMoveToBrushes` 2.9%.

## 1. A tighter SIMD pre-test (commit 99c0012)

The 4-lane pre-test in `ClipModelMoveToModel()` rejected a sphere pair only when it couldn't
touch along the whole movement. Pairs that already overlap at the start passed it and went to
the scalar clip, which then rejects them, because the scalar test takes the lower root
`Min(L1, L2)` and that root is negative. Rounding is monotonic, so `L2 <= L1` holds in float
too, so `Min(L1, L2)` is `L2`. The pre-test now rejects a lane when `D < 0`, `L2 < 0` or
`L2 >= fraction`, which are exactly the scalar test's rejections.

- Scalar clips per 1M ClipMoves: 42.2M before, 2.26M after.
- Verify build: 110M rejected lanes, 0 that the scalar test would have taken.

## 2. The grid scan skips the last row and column (WorldCollisionGrid.cpp)

`BoxToGrid()` rounds the max edges up with `ceil`, so a box inside one 2 m cell scans 2x2 cells.
A record is taken in the cell of its first entry inside the searched rectangle (round 2). A
record whose first cell is past `floor(max/cell)` has `min > max` of the query on that axis, so
the box test after the scan rejects it anyway. `SE1_FindEntitiesTouchingBox()` now ends the
scan at `floor(max/cell)` on x and z. The entities it returns, and their order, are unchanged.

- Verify build (stress4000): 1,048,576 queries, 0 mismatches, 6.47 cells per query before and
  2.42 after.

## Results

perfbench `--check` (demo: SAME simulation, 384 ticks), mean engine ms per frame, 2 reps:

| Scenario | Before (r2b) | After (r3a) | Speedup |
|---|---|---|---|
| stress2000 | 13.35 | 11.97 | 1.12x |
| stress4000 | 60.77 | 47.49 | 1.28x |

The pre-test change was already in r2b. Against the reference engine, r2b measured 1.74x at
stress500, 7.69x at stress1000 and 3.07x at stress2000. The reference engine can't run
stress4000: it is capped at 2047 entity handles.

## Screenshots

`tools/bench.mjs --shots` on r2b against the reference: 8/8 ok, mean difference 0.00, at most
0.001% of pixels changed. None is bit-identical, because the GPU animation path
(`notes/perf/gpuanim.md`) rounds vertex positions differently from the CPU path.

## Not taken: threaded collision prefetch (track L)

Track L (branch `t3/69e5b341`) prefetched the movers' collision candidates on a job pool. It
measured 2-7% slower than the single thread, and it duplicated the brush collision code. Its job
pool may still serve model rendering later.
