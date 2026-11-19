# Big ideas: how we'd approach them

Answers to the "insane mods" questions: no loading screens, huge hordes, better graphics, and map
remixing. They share one piece of infrastructure, a **world tool**. It uses the engine's own code to load
`.wld` files, copy and transform entities (and brushes), recompute shadows and save. Several items below
start with it.

## 1. No loading screens between levels ("bridges")

**Today:** `CNetworkLibrary::ChangeLevel_internal` (Engine/Network/Network.cpp):

1. It saves the players.
2. It loads the next `.wld` (`CWorld::Load_t`): brushes, shadow maps, then every entity.
3. It loads that world's textures, models and sounds.
4. It copies the players across (`CWorld::CopyEntities`).

The game is frozen meanwhile, behind the loading screen.

There are three levels of ambition:

1. **Hide the load (cheap, do first).**
   - Prefetch the next level's files during play.
     - This needs lazy data loading and the OPFS cache from the roadmap. The full game currently
       preloads 368 MB.
   - Warm the texture, model and sound caches in idle time on the engine thread. Then the swap is
     only the world parse and entity setup.
   - Cover the swap with an in-world effect (teleport flash, Netricsa transition) instead of a
     loading screen.
   - Needed:
     - a per-level resource list, extracted offline from the `.wld` files;
     - an idle-time preloader;
     - a measurement of what's left. The world parse might take a few hundred ms.
2. **True seamless "bridges" (the real thing).** Merge levels offline into one world per chapter, so
   `ChangeLevel` never happens.
   - The world tool loads level A and level B, then copies all of B's entities into A with an offset.
     Brushes are entities too. This is what the World Editor's paste does (`CWorld::CopyEntities`
     with a placement).
   - It then adds a bridge between them: a corridor brush, an elevator or a teleport.
   - It rewires B's level-exit entity (`WorldLink`) to the next segment.
   - Engine work: per-world singletons become per-zone. These are `WorldSettingsController`, the
     background viewer (sky), fog and haze, and `MusicHolder`. The renderer and music pick the zone's
     values as the player crosses.
   - Costs:
     - bigger saves, more memory, and a longer first load (so do tier 1 too);
     - more entities. Sleeping monsters cost almost nothing; idle monsters measured as free.
   - Bonus: co-op never has to change level in sync.
3. **Stream two live worlds at once:** not recommended. The engine assumes one world everywhere
   (networking, prediction, rendering, physics).

## 2. How many enemies on screen

Measured with `tools/stress.mjs`, on an M-series Mac in Chrome, on Hatshepsut, with the whole horde in
view and shooting:

| Monsters | fps | Engine ms per frame (median / p95) |
|---|---|---|
| 200 | 60 | 2.8 / 10.6 |
| 300 | 57 | 3.8 / 15.6 |
| 500 | 36 | 23.7 / 48 |

- **Comfortable limit:** about 300 on a fast machine. The Mi 8 SE is roughly 4–5× slower, so expect
  around 60–80 there.
- **Where the time goes at 500:**
  - line-of-sight ray casts (each monster checks it can see the player): about 21%;
  - movement collision against the world and each other: about 14%;
  - path-finding: about 7%;
  - game clock reads: about 6%;
  - animating and drawing models: about 9%.
- Collision between neighbours makes the cost grow faster than the monster count.

## 3. 10,000–50,000 enemies

**Not as engine entities.** Every monster is a full entity: an AI state machine, its own ray casts,
swept-sphere collision, path-finding, a vertex-animated model and its own draw. To get there, a horde
gets its own system:

1. **Crowd simulation in Rust,** data-oriented (arrays per field, SIMD).
   - **Flow field:** one grid of the level, built once per player move, shared by all monsters. This
     replaces per-monster path-finding and line-of-sight casts.
   - **Spatial hash** to keep monsters apart.
   - **Ground height and walls** from a navigation grid baked from the level's geometry.
   - **Simple attack rules.**
   - Speed: 10k agents is about 1–2 ms in one thread. For 50k, split the grid across worker threads;
     the build already has pthreads.
2. **Instanced rendering.**
   - One draw call per monster type.
   - Bake the vertex-animation frames into a texture, so the vertex shader animates each instance.
   - Use billboards (impostors) at distance. WebGL2 supports all of this.
   - WebGPU compute could run the crowd simulation on the GPU.
3. **Weapons against the horde:**
   - hitscan rays and projectiles test against the spatial hash;
   - explosions do an area query;
   - kills spawn gibs and XP gems.
4. **Hybrid for feel:** the nearest ~100 monsters become real engine entities, with full AI, animations
   and sounds. The rest are crowd agents. They switch as they come near or fall back.
5. **Multiplayer:** the crowd must be deterministic, so only player inputs are sent (lockstep), not 50k
   states.

**Realistic targets:**
- Desktop: 10k with steps 1–2; 50k with multi-threaded simulation, baked animation and billboards.
- Phones: a few thousand.

## 4. Better graphics (HD/4K textures, effects, ray tracing)

We own the renderer's shaders. `gl1shim` turns the engine's fixed-function GL into our own WebGL2 and
WebGPU shaders, so most of this is new passes rather than engine surgery. In order of value per effort:

1. **Post-processing:** bloom (flares, explosions, lava), tone mapping and colour grading, SSAO,
   FXAA or TAA, sharpening. This is days of work and the biggest visible jump.
2. **Rebaked lighting.** SE1 levels use baked shadow maps (lightmaps).
   - Rebake them offline at higher resolution with path-traced global illumination (bounce light,
     soft shadows), using the world tool.
   - It looks close to ray traced and costs nothing at runtime.
3. **HD textures.**
   - Offline AI upscaling (ESRGAN-style) of the original `.tex` files.
   - Generated normal and specular maps.
   - Ship as compressed GPU textures (KTX2/Basis → BC7, ASTC or ETC2), streamed per level.
   - Memory is the limit, not the GPU.
4. **Per-pixel lighting** on models and walls with those normal maps. Models are vertex-lit today.
5. **Ray tracing.** Browsers have no hardware ray-tracing API.
   - In WebGPU compute: build a BVH of the static level once (it never changes), then trace at low
     resolution with denoising: shadows, AO, reflections on water and polished floors.
   - That's an "Ultra" toggle for strong GPUs, not the default. 60 fps on a potato stays the rule.

**Quality tiers:** potato (today's look), default (post-processing + rebaked lighting), ultra (HD
textures, per-pixel lighting, ray-traced effects).

## 5. Remixing maps (seeded, procedural, LLM)

A `.wld` holds geometry (brush sectors and polygons with textures and shadow maps) and entities
(enemies, spawners, items, triggers, markers). Three tiers:

1. **Seeded content remix (now, no file editing).** After a level loads, the mod walks its entities and,
   with a seed, re-rolls:
   - enemy types, counts and spawner templates;
   - item and secret placement;
   - difficulty.

   Scripted sequences keep working because the triggers stay. The Survivors director is already this
   idea for one arena. A "Remix" mode would apply it to the whole campaign.
2. **Geometry remix (kit-bashing).**
   - Cut levels into rooms and arenas, using sector groups connected by portals and doors.
   - Tag their connectors.
   - Generate new layouts by stitching rooms from different levels with corridors.
   - Uses the world tool (copy with transforms), plus a shadow recompute and new navigation markers.
     The flow field from section 3 could replace the markers.
3. **LLM-designed levels.** An LLM shouldn't output triangles. It writes a small level script that the
   generator from tier 2 realizes:
   - a room graph and a theme;
   - encounters ("arena 3: 40 Kleers from the north gate; at half dead, 2 Werebulls");
   - pickups and secrets;
   - Netricsa texts.

   Then validate automatically: headless bot runs with the existing browser test harness check that
   the level is reachable, can be completed, and how long it takes and how many deaths it causes.

**Order:** tier 1 first. The world tool from bridges also unlocks tier 2, and the LLM script sits on top.
