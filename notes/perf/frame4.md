# Perf round 4, the engine-thread frame outside collision

Branch `t3/optimize-crowd-frame-time`, base `bd8642c`. Goal: lower the engine thread's ms per
frame at stress300 and stress500 without changing the simulation by a single bit. Off limits this
round: `WorldCollision.cpp` and `WorldCollisionGrid.cpp` (another track). Tools: `tools/optbuild.sh`,
`tools/perfsnap.py`, `tools/perfbench.mjs --check` (behaviour oracle), and the cpuprofile analysers
described below.

## Where the time went

stress500, base profile (20 s, busy samples, waits excluded), inclusive:

| | % of busy |
|---|---|
| `CGame::GameMainLoop` | 62 |
| `CSessionState::HandleMovers` | 51.6 |
| `DoMoving` → `TryToMove` | 39.6 |
| `CWorld::ClipMove` (25% self; off limits) | 32.7 |
| `HandleSentEvents` | 16.6 |
| of which `CastRay` (`PrepareRayModelHits` 3.6, `TestBrushSector` 2.1) | ~7 |
| of which `CEnemyBase::HandleEvent` self | 1.5 |
| of which `FindClosestMarker` | 1.1 |
| of which the `ETouch` destructor and `free` | 0.8 |
| `CRenderer::Render` | 24.6 |
| of which `RenderModels` | 12.5 |
| of which `ScanOneLine` | 3.8 |
| `PreMoving` (`TestFields` 1.8, `FindLineMinMax` 1.2) | 2.9 |
| `SetPlacement_internal` | 2.5 |

stress300 adds `FilterBitmap` at 1.2% and `UpdateSounds` at 1.1%.

Wall-clock view (waits included). The engine thread also waits on synchronous calls to the page's
main thread:
- `post_hud`: about 50 µs a frame. It is outside the perfbench window (`SE1Mod_Frame` runs after
  the measured part).
- `se1mod_bot_tick`: about 27 µs a frame, about 2.2% of a stress300 frame. It is counted. Even
  with no bots, it read two page options per tick through `MAIN_THREAD_EM_ASM_DOUBLE`.

## What changed

1. **Page options read once per 500 ms; UI posts don't wait** (`port/common/Se1ModHost.cpp`,
   threaded build).
   - `host_page_option(name)` read `Module[name]` with a synchronous call to the main thread. The
     bots' `sync_bots` and `build_nav` ask for `se1Bots` and `se1NavBake` every tick, even with no
     bots. The value is now kept per name for 500 ms (48 names).
   - The page sets these options from the URL at startup (`pre.js`, `survivors.js`,
     `archipelago.js`), so the mod sees the same values. A later change still reaches it within
     500 ms. The Rust test `bots_runtime_accept.rs` changes `se1Bots` at runtime, but it runs the
     mod natively and doesn't use this host function.
   - `host_ui_post` now copies the string and posts it with `MAIN_THREAD_ASYNC_EM_ASM`. The main
     thread frees the copy (`SE1Mod_UiPostDone`). Proxied calls run in order, so posts stay in
     order with each other and with the synchronous calls.
   - The page's answers come back through `SE1Mod_UiSend` and the mod polls them (`ui_poll`), so
     nothing waited on the synchronous return.
   - Effect on the wall-clock profile: `se1mod_bot_tick` went from 0.19% of wall to 0.05%. The
     post_hud part (`SE1Mod_Frame`) is outside the perfbench window.
2. **`FilterBitmap()` middle pixels two at a time in wasm SIMD** (`Graphics.cpp`, portable path).
   - Effect textures (fire, water) are filtered in place every tick
     (`Texture.cpp` `FilterBitmap(td_pulFrames, td_pulFrames)`), and so are the mipmaps in
     `MakeMipmaps`.
   - `FilterMiddlePairInPlace()` loads the 4-pixel windows of the three rows once and extends
     them to 16 bits. Each 16-bit lane then does what the `ExtPix` helpers do for one channel:
     - `extpix_add` and `extpix_mul` keep the low 16 bits (`i16x8.add` / `mul`).
     - `extpix_adds` saturates (`i16x8.add_sat`).
     - `extpix_mulhi` is `(a*b)>>16` in 32 bits (`extmul` plus `shr`, then a signed narrow that
       cannot saturate).
     - `unextend_pixel` clamps to 0..255 (the unsigned saturating narrow).
     - Wrapping sums don't depend on their order, so the corner and edge sums may be added in a
       different order.
   - The in-place hazard: before it filters pixel x, the scalar loop has already written the
     filtered value of the row above at x−1 (`dst[-W] = *rowptr`). The first pixel of a pair
     reads that value from memory, as the scalar code does. The second pixel needs the filtered
     value at x, which the scalar loop would have written just before it. It is still in the row
     buffer (`rowptr[0]`), so the lane takes it from there. Only the in-place case takes this
     path. A copying `FilterBitmap` (src ≠ dst) runs the scalar loop.
   - **Verify:** a temporary build ran the scalar function on a copy before every in-place call
     and compared all texels: **0 mismatches in 34.8M texels** (6.5M stress300, 15.3M stress500,
     13.0M timedemo; 3.1M + 7.4M + 6.3M SIMD pairs).
   - Profile: `FilterBitmap` self time went from 1.50% to 0.30% of stress300 and from 1.14% to
     0.27% of stress500.
3. **Free list for event copies** (`EntityEvent.h`, `Entity.cpp`).
   - `CEntity::SendEvent` heap-copies the event (`MakeCopy`, `new`), and `HandleSentEvents`
     deletes it. In a crowd that means thousands of `ETouch` per tick, through the threaded
     build's locked malloc and free.
   - `CEntityEvent` now has a class `operator new` and a sized `operator delete`. Every event
     class inherits them, and the virtual destructor passes the dynamic size. Blocks are reused
     per 8-byte size class from thread-local free lists (up to 504 bytes and 16384 blocks per
     class). Anything larger, or over the limit, goes to the heap.
   - Only where the memory comes from changes. No code orders or hashes events by address.
   - **Verify:** `perfbench --check`: SAME simulation, 384 ticks.
   - Profile: malloc + free went from 1.07% to 0.21% of stress300 and from 1.52% to 0.28% of
     stress500.
4. **`BSPTree::FindLineMinMax()` memo** (`BSP.h`, `BSP.cpp`).
   - `CMovableEntity::TestFields()` (from `PreMoving`) asks for the min/max line parameters
     inside each sector, for every mover and every sector it touches, every tick. It must ask:
     `UpdateOneSectorForce` uses `dMax−dMin` for every sector.
   - A counting build showed that the same (entity, sector, vMin, vMax) as on the previous tick
     comes back in **78%** of the calls at stress500 (971k of 1.25M) and 77% at stress300.
     Monsters held in the crowd stand still to the bit.
   - The answer is a pure function of the tree's nodes and the two points. So every `BSPTree`
     now carries a stamp (`bt_ulStamp`), taken from a global counter whenever the tree is
     constructed, destroyed, created or read. Nothing outside `BSP.cpp` writes the nodes: a
     search for writes to `bt_pbnRoot` / `bt_abnNodes` found none.
   - `FindLineMinMax` keeps a direct-mapped table of 16384 slots, keyed by (tree pointer, stamp,
     v0 and v1 compared bit for bit). A hit returns the stored `tMin`/`tMax`; a miss runs the
     original recursion and stores the result. A moving brush rebuilds its sectors' trees, which
     gives them a new stamp, and a freed tree can't match because stamps are never reused.
   - **Verify:** a temporary build ran the recursion on every hit as well: **0 mismatches in
     1.65M hits** (1.0M stress500, 0.6M stress300, 50k timedemo). The stamp counter stayed at
     2372 during play, so the trees changed only at load.
