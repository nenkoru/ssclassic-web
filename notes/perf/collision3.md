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

## 3. The grid's box test without branches (WorldCollisionGrid.cpp)

Counters at stress4000, per search: 28% of the searches scan cells (the others reuse the last
scan's record list, round 2), 2.5 cells and 167 entries per scan, and every search box-tests
112 records to keep 14 (13 after the mover itself). The scalar test has six data-dependent
branches that mispredict. It is now the same six float comparisons on two 4-lane loads of the
box, `(min x, y, z, max x)` and `(min z, max x, y, z)`, with NaN in the query lanes that have no
test, so they compare false.

- Verify build (stress4000): 167,772,160 box tests, 0 mismatches against the scalar test.

## 4. ProjectASpheresToB() in SIMD (WorldCollision.cpp)

Each pair a ClipMove tests projects the mover's spheres into the other entity's space at the
start and the end of the move, and boxes the path. That was 11.3% self at stress4000. The SIMD
version does the scalar code's operations per lane in its order: `Vector*Matrix` row i is
`(m(i,1)*x + m(i,2)*y) + m(i,3)*z`, then the offset is added. `Min`/`Max` are the template's
`a>b ? b : a` and `a<b ? b : a`, which are wasm `pmin`/`pmax`. `Expand()` adds R to the max and
subtracts it from the min. The web build doesn't use `-ffast-math`, and wasm has no fused
multiply-add, so the scalar code isn't contracted either. A `CMovingSphere` is 16 floats
(`static_assert`); each 4-lane store's spare lane lands on the next field, which the next store
overwrites.

- Verify build (stress4000): 81,423,885 projections, 0 byte mismatches in the two centres and
  the box.

## Results

perfbench `--check` (demo: SAME simulation, 384 ticks), mean engine ms per frame, 2 reps:

| Scenario | Before (r2b) | After (r3a) | Speedup |
|---|---|---|---|
| stress2000 | 13.35 | 11.97 | 1.12x |
| stress4000 | 60.77 | 47.49 | 1.28x |

Then 3 and 4 (r3a is 1 and 2; r3b adds 3; r3c adds 4), mean ms, 2 reps, all SAME on the demo:

| Scenario | r3a | r3b | r3c | r3c vs r3a |
|---|---|---|---|---|
| stress2000 | 11.99 | 11.53 | 11.23 | 1.07x |
| stress4000 | 52.71 | 48.09 | 45.74 | 1.15x |

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

## 5. PrepareProjectionsAndSpheres() in SIMD (round 4)

After track M (`rays3.md`), a profile with the collision functions kept apart (stress4000, main
51645f2) shows `SE1_FindEntitiesTouchingBox` 25.7%, `ClipModelMoveToModel` 23.1%,
`PrepareProjectionsAndSpheres` 11.6%, `PrepareRayModelHits` 6.1%, `ClipMoveToBrushes` 5.8%.
Counters over 4M pairs: in 10.8% of the pairs no sphere box of A touches a sphere of B, and in
81.5% none reaches the scalar clip. So a pair-level reject could skip at most ~11% of the pairs;
the per-pair arithmetic is the cost.

`PrepareProjectionsAndSpheres()` builds `mAToB = MatrixMulT(mB, mA)` and
`vAToB = VectMulT(mB, vA-vB)` for both ends of the move, per pair. Column j of
`MatrixMulT(mB, mA)` is `(row1(mB)*mA(1,j) + row2(mB)*mA(2,j)) + row3(mB)*mA(3,j)`, and
`VectMulT(mB, v)` is `(v1*row1(mB) + v2*row2(mB)) + v3*row3(mB)`. These are the scalar code's
products and sums per lane in its order (multiplication commutes exactly). The columns go straight
into the sphere projection (part 4), and the matrices and vectors are still stored for the code
that reads them.

- Verify build (stress4000): 61,865,984 prepares with 0 mismatches in the matrices and vectors,
  and 247,428,191 projected spheres with 0 mismatches.
- Bench, mean ms, 2 reps, against r4a (main 51645f2), "SAME simulation" on the demo:
  1.10x at stress4000 (41.84 to 37.89) in one run and 1.04x (43.52 to 41.84) in another, under
  load from a parallel track; stress2000 1.01x.

### Not taken: the grid's box test on copied box arrays

The record list that `SE1_FindEntitiesTouchingBox()` keeps between searches (about 122 records per
search at stress4000) had its boxes copied into one array per edge, so that the test takes 4
records per comparison. Records whose box `MoveEntityInCollisionGrid()` changed were copied again
before the test. The verify build had 4,194,304 searches and 0 mismatches. It was no faster
(0.99x at stress4000): 27% of the searches make the list again, and copying the boxes then costs
what the test saves.
