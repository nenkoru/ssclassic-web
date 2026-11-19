# Seeded map remixing — design note

`?remix=<seed>` re-rolls a level's monsters and pickups deterministically from a seed: same seed →
same layout, another seed → another layout, same map plays differently. This note is what an
engineer implements from. Context: `notes/big-ideas.md` §5, tier 1 ("Seeded content remix").

> **Reviewer's note (Claude):** one claim below needs checking before any code is written. A `.wld`
> stores its entities as the editor left them, already initialized (models, states, properties),
> and loading continues from that saved state rather than running `Main` again. So writing a type
> property at level start probably does **not** change the item or monster by itself: each changed
> entity likely needs `CEntity::Reinitialize()` afterwards (what the editor uses after a property
> edit; `src/SamTFE/Sources/Engine/Entities/Entity.h`). The first step of the plan should be a
> one-entity experiment: change a health item's `m_EhitType` at level start, with and without
> `Reinitialize()`, and look at its model and the health it gives.

## How levels place things

### Monsters: placed directly vs created by spawners

A level's `.wld` stores entities in a fixed order. On load, `CWorld::Load_t` reads them into
`wo_cenAllEntities`, and the `ENOR` chunk restores the live container `wo_cenEntities` in the
file's order (`src/SamTFE/Sources/Engine/World/WorldIO.cpp:671-682`). The container is a
`CDynamicContainer<CEntity>` (`src/SamTFE/Sources/Engine/World/World.h:186`), so iteration order is
deterministic and equals the file order. Nothing reorders it at runtime.

Monsters enter a level two ways:

1. **Placed directly.** A `CEnemyBase` subclass entity in the world with `m_bTemplate = FALSE`
   (the default, `src/SamTFE/Sources/Entities/EnemyBase.es:135`). It is a live, damaging,
   countable monster from the start.
2. **Created by spawners.** A `CEnemySpawner` (`src/SamTFE/Sources/Entities/EnemySpawner.es:35`)
   holds a **template entity** in `m_penTarget` (line 41) — a monster in the world with
   `m_bTemplate = TRUE`. Templates are inert: `ReceiveDamage` ignores them
   (`src/SamTFE/Sources/Entities/EnemyBase.es:607-610`), they report count 0 in statistics
   (`src/SamTFE/Sources/Entities/EnemyBase.es:591-595`), and they do nothing in their Main
   (`src/SamTFE/Sources/Entities/EnemyBase.es:2693-2696`). The spawner validates the template
   (`CheckTemplateValid`, `src/SamTFE/Sources/Entities/EnemySpawner.es:87-97`) and, when
   triggered, copies it: `SpawnEntity(TRUE)` calls `GetWorld()->CopyEntityInWorld(*m_penTarget, …)`,
   clears `m_bTemplate` on the copy, sets `m_penSpawnerTarget` for respawners, and `Initialize()`s
   the copy (`src/SamTFE/Sources/Entities/EnemySpawner.es:130-154`).

Spawner types (`EnemySpawnerType`, `src/SamTFE/Sources/Entities/EnemySpawner.es:25-32`):
`EST_SIMPLE` (spawn on trigger), `EST_RESPAWNER`/`EST_RESPAWNERBYONE` (respawn after death),
`EST_DESTROYABLE` (spawn until killed), `EST_TRIGGERED`, `EST_TELEPORTER` (teleport the template
instead of copying — the only type that needs a *non*-template target). Counts come from
`m_ctTotal` (`src/SamTFE/Sources/Entities/EnemySpawner.es:51`), grouped by `m_ctGroupSize`
(line 50), with delays `m_tmDelay`/`m_tmSingleWait`/`m_tmGroupWait` (lines 47-49). `Main`
(`src/SamTFE/Sources/Entities/EnemySpawner.es:337-403`) dispatches on the type; on
`GD_EXTREME` it may double counts (lines 369-372) and swap in `m_penSeriousTarget` (lines 373-375).

**Triggers that activate spawners:** `CTrigger` (`src/SamTFE/Sources/Entities/Trigger.es:22`) has
up to ten targets `m_penTarget1..10` (lines 30-39) with event types `m_eetEvent1..10`
(lines 40-49); `SendEventToTargets` sends each (lines 92-101). A trigger that points at a spawner
with `EET_TRIGGER` starts it. Items can also fire triggers: `CItem` sends
`SendToTarget(m_penTarget, EET_TRIGGER, …)` when collected (`src/SamTFE/Sources/Entities/Item.es:253`),
and `ItemReceived` sends it for `m_bPickupOnce` items (line 271).

**Counting for statistics:** `MakeWorldStatistics` iterates the whole world and calls each
entity's `FillEntityStatistics` (`src/SamTFE/Sources/Entities/WorldBase.es:101-141`); it is a
console symbol (line 624), used for editor/AI stats, not for level completion. Spawners report
their template's stats with `es_ctCount = m_ctTotal` (`src/SamTFE/Sources/Entities/EnemySpawner.es:117-127`).
Secrets are a separate mechanism: a trigger with `m_fScore > 0` sends `ESecretFound` to the player
(`src/SamTFE/Sources/Entities/Trigger.es:110-120`), which increments `ps_iSecrets`
(`src/SamTFE/Sources/Entities/Player.es:5924-5927`).

### Pickups

All pickups derive from `CItem` (`src/SamTFE/Sources/Entities/Item.es:27`). Shared properties:
`m_fValue` (line 37), `m_fRespawnTime` (line 38), `m_bRespawn` (line 39), `m_penTarget`
(line 40, the trigger fired on pickup), `m_bPickupOnce` (line 41). `ItemLoop` calls
`AdjustDifficulty()` once after start (`src/SamTFE/Sources/Entities/Item.es:244`) — subclasses use
it to destroy items when the session disables them (e.g. `!sp_bAllowHealth`), checking
`m_penTarget==NULL` so targeted items survive (`src/SamTFE/Sources/Entities/HealthItem.es:221-226`).
On pickup, `ItemReceived` hides the item and respawns it after `m_fRespawnTime` if `m_bRespawn`
(`src/SamTFE/Sources/Entities/Item.es:267-292`).

Each pickup class has a **type enum property** that its `SetProperties` (called from `Main`,
after `Initialize`) turns into value, model, sound and respawn time:

- `CHealthItem::m_EhitType` — `HIT_PILL/SMALL/MEDIUM/LARGE/SUPER`
  (`src/SamTFE/Sources/Entities/HealthItem.es:25-31`, property line 44; `SetProperties`
  lines 146-219: pill=1/10s, small=10/10s, medium=25/25s, large=50/60s, super=100/120s).
- `CArmorItem::m_EaitType` — `ARIT_SHARD/SMALL/MEDIUM/STRONG/SUPER`
  (`src/SamTFE/Sources/Entities/ArmorItem.es:25-31`, property line 44; `SetProperties`
  lines 144-208: 1/10s, 25/10s, 50/25s, 100/60s, 200/120s).
- `CAmmoItem::m_EaitType` — `AIT_SHELLS/BULLETS/ROCKETS/GRENADES/ELECTRICITY/IRONBALLS/…`
  (`src/SamTFE/Sources/Entities/AmmoItem.es:33-44`, property line 57; `SetProperties`
  lines 232-343: shells=10, bullets=50, rockets=5, grenades=5, electricity=50, ironballs=4,
  all 30s; `AdjustDifficulty` scales by `sp_fAmmoQuantity`, line 345-352).
- `CWeaponItem::m_EwitType` — `WIT_COLT…WIT_CANNON`
  (`src/SamTFE/Sources/Entities/WeaponItem.es:40-53`, property line 72; `SetProperties`
  from line 251; `Precache` precaches the weapon's player-weapon data, lines 197-213).
- `CAmmoPack::m_aptPackType` (`APT_CUSTOM/SERIOUS`, `src/SamTFE/Sources/Entities/AmmoPack.es:25-28`,
  property line 47) plus per-ammo counts `m_iShells…m_iIronBalls` (lines 49-55), clamped in
  `Main` (lines 202-208).
- `CKeyItem::m_kitType` — the ankh keys that open doors
  (`src/SamTFE/Sources/Entities/KeyItem.es:82-89`). **Not remixable** — a key must match the door.
- "PowerUpItem" is not a class in this codebase; the power-ups are the ammo-item types
  `AIT_SERIOUSPACK`/`AIT_BACKPACK` (`src/SamTFE/Sources/Entities/AmmoItem.es:41-42`) and
  `CAmmoPack` (`src/SamTFE/Sources/Entities/AmmoPack.es:42`).

**What references pickups:** `m_penTarget` (a trigger fired on pickup) and, in scripted levels,
triggers/doors whose `m_penTargetN` point at the item. Nothing else points at items; monsters do
not reference them.

### What the mod layer can change, and when

The mod's `se1mod_level_started` is called from `CNetworkLibrary::ChangeLevel_internal` **after**
the world is loaded and the session started (`src/SamTFE/Sources/Engine/Network/Network.cpp:1097-1099`),
forwarded through `SE1Mod_LevelStarted` (`port/common/Se1ModHost.cpp:327`) to the Rust
`se1mod_level_started` (`rust/se1-mod/src/lib.rs:214-228`). At that moment every entity exists in
`wo_cenEntities` with its file values, but **no entity's `Main` has run yet** (the server starts
the tick loop just before, `src/SamTFE/Sources/Engine/Network/Network.cpp:1062`). This is the
remix window: write file-level properties, then let each entity's `Initialize`/`Main` read them
normally — exactly what `SE1ModEnt_SpawnEnemy` already does for spawned monsters, setting
`m_hdtType`/`m_EecChar`/`m_smtType`/`m_EwcChar`/`m_bcType`/`m_EetType` and `m_fStretchMultiplier`
**before** `Initialize` and health/glow **after**
(`port/common/Se1ModEntities.cpp:28-61`). For world entities the same ordering applies: the type
enum must be written before the first tick; `Initialize` and `SetProperties` run during the
entity's first `Main`.

## What can be re-rolled safely

| Entity kind | Property to change | Allowed values | What could break | Rule to avoid it |
|---|---|---|---|---|
| Placed monster (`m_bTemplate==FALSE`, not referenced) | class variant enum (`m_hdtType`, `m_EecChar`, `m_smtType`, `m_EwcChar`, `m_bcType`) | any value of the *same class*'s enum (e.g. Headman Firecracker→Bomberman, `src/SamTFE/Sources/Entities/Headman.es:25-30`) | death-trigger scripts keyed to a specific variant (a Kamikaze exploding on death vs a Firecracker not); stats names | re-roll only within the same class; never touch entities referenced by a trigger's `m_penTargetN` or an item's `m_penTarget` |
| Spawner template (`m_bTemplate==TRUE`) | its variant enum | same as above | a teleporter spawner requires a non-template target (`src/SamTFE/Sources/Entities/EnemySpawner.es:92-96`) — changing a teleporter's target's template flag breaks it; a trigger waiting for a *specific* monster to die (death event, `src/SamTFE/Sources/Entities/EnemyBase.es:134`) | re-roll the variant, keep `m_bTemplate` and the class; if the class has no variant enum (Boneman, Werebull, Kleer…), leave it alone |
| Spawner | `m_ctTotal`, `m_ctGroupSize` (`src/SamTFE/Sources/Entities/EnemySpawner.es:50-51`) | positive ints, keep the total within a factor of the original | `EST_RESPAWNER` levels get harder/easier; `m_ctTotal` is decremented per spawn (line 202) so the count is the level's monster budget | scale counts by the difficulty factor from the seed; never zero a spawner that a scripted sequence depends on (a trigger that fires when its count hits 0) |
| Health item | `m_EhitType` (`src/SamTFE/Sources/Entities/HealthItem.es:44`) | any of `HIT_PILL…HIT_SUPER` | value/respawn/model change with the type (`SetProperties`, lines 146-219); a `HIT_PILL` grants over-top health — fine | re-roll within the class; keep items with `m_penTarget` untouched |
| Armor item | `m_EaitType` (`src/SamTFE/Sources/Entities/ArmorItem.es:44`) | any of `ARIT_SHARD…ARIT_SUPER` | same as health | same as health |
| Ammo item | `m_EaitType` (`src/SamTFE/Sources/Entities/AmmoItem.es:57`) | `AIT_SHELLS/BULLETS/ROCKETS/GRENADES/ELECTRICITY/IRONBALLS` (skip the obsolete/“don't use” ones, lines 39-43) | a rocket item in a level with no rocket launcher is dead weight; `AdjustDifficulty` scales by `sp_fAmmoQuantity` (line 347) | prefer ammo matching weapons present in the level; keep targeted items untouched |
| Weapon item | `m_EwitType` (`src/SamTFE/Sources/Entities/WeaponItem.es:72`) | any of `WIT_COLT…WIT_CANNON` except obsolete (lines 48-51) | `Precache` precaches the weapon (lines 197-213) — all weapons are in the data, safe | keep items that are the level's first weapon untouched (scripted intros) |
| Ammo pack | `m_aptPackType` + counts (`src/SamTFE/Sources/Entities/AmmoPack.es:47-55`) | `APT_CUSTOM` with clamped counts; `APT_SERIOUS` as a jackpot | counts are clamped in `Main` (lines 202-208) | only `APT_CUSTOM` with reasonable counts |
| Key item | — | none | a key must match its door (`src/SamTFE/Sources/Entities/KeyItem.es:88`) | **never** re-roll keys |
| Triggers, doors, `WorldLink`, spawners-as-geometry | — | none | they are the script; moving/retyping them breaks sequences, secrets (`ESecretFound`, `src/SamTFE/Sources/Entities/Trigger.es:119`) | **never** touch any entity that is a target of, or itself a, trigger |

General rules: (1) re-roll only properties a class's `Main`/`SetProperties` reads from the file;
(2) keep per-class counts (or scale them uniformly by a seed-derived factor); (3) never touch
entities referenced by any `CEntityPointer` in the level (triggers' targets, items' `m_penTarget`,
spawners' `m_penTarget`/`m_penSeriousTarget`/`m_penPatrol`); (4) templates stay templates.

## Host API needed

New entries for the `SE1ModHost` table in `port/common/se1mod.h` (bump `SE1MOD_API_VERSION` to 6,
line 19). C signatures:

```c
/* ---- API 6: world enumeration + property writes (remix) ---- */
/* Enumerate entities of a class (exact name, e.g. "Health Item") in the current world, in
   wo_cenEntities order (the .wld file order, deterministic — see WorldIO.cpp:671-682).
   Fills `out` with up to `cap` handles (same handle space as spawn/spawn_item). Returns the
   total number of matches (may exceed cap; call again with a bigger cap). A handle is valid
   until the level changes. */
int  (*world_entities)(const char *class_name, int cap, int *out);

/* Class name of a handle's entity ("Enemy Base", "Health Item", …); 0 if the handle is gone. */
int  (*world_class)(int handle, char *out, int cap);

/* Entity position (x, y, z; y is up); 0 if gone. */
int  (*world_position)(int handle, float *pos3);

/* Is the entity referenced by any other entity's CEntityPointer property (a trigger target, an
   item's m_penTarget, a spawner's template)? 1 = referenced (do not re-roll), 0 = free. */
int  (*world_referenced)(int handle);

/* Write a named file-level property of a known type, before the entity's first Main.
   `type`: 0 = int32 (enum values: variant, m_ctTotal, m_ctGroupSize, m_EhitType, m_EaitType,
   m_EwitType, m_aptPackType, m_iShells…), 1 = float. Returns 1 on success. The property name
   must be one of the class's declared properties; the engine casts through the same per-class
   table SE1ModEnt_SpawnEnemy uses (port/common/Se1ModEntities.cpp:36-43). */
int  (*world_set_property)(int handle, const char *prop, int type, int32_t value);
int  (*world_set_property_f)(int handle, const char *prop, float value);

/* Read back a property (for tests / the deterministic log): 0 if unknown/gone. */
int  (*world_get_property)(int handle, const char *prop, int *out);
```

**When the mod may call them:** only inside `se1mod_level_started`
(`rust/se1-mod/src/lib.rs:214`), i.e. after `CNetworkLibrary::ChangeLevel_internal` has loaded the
world and started the session (`src/SamTFE/Sources/Engine/Network/Network.cpp:1097-1099`) but
before the first tick runs any entity's `Main`. Property writes take effect on the entity's first
`Initialize`/`SetProperties`, exactly like the pre-`Initialize` writes in
`SE1ModEnt_SpawnEnemy` (`port/common/Se1ModEntities.cpp:35-48`).

**Determinism.** Two parts:

1. *Iteration order.* `world_entities` walks `wo_cenEntities`
   (`src/SamTFE/Sources/Engine/World/World.h:186`), whose order is the `ENOR` order from the
   `.wld` file (`src/SamTFE/Sources/Engine/World/WorldIO.cpp:671-682`). The same file always
   yields the same sequence, so entity *i* is always the same entity.
2. *Seed mixing.* The Rust re-roll is a pure function
   `(seed: u64, level_name: &str, entities: &[EntityInfo]) -> Vec<Change>`, where `EntityInfo` is
   `{handle, class, position, current_variant, referenced, …}`. The seed is mixed with the level
   name (FNV-1a over the bytes, then xorshift-64 as in the survivors RNG,
   `rust/se1-mod/src/survivors/mod.rs:301-306`) so the same seed gives the same re-rolls on every
   level but different ones across levels. No engine randomness is used at all — the engine's
   `FRnd` is only relevant to spawners *after* the remix (spawn positions), which is fine: the
   layout (who is where, what they are) is fixed by the mod, and the in-spawn jitter is small
   (`src/SamTFE/Sources/Entities/EnemySpawner.es:164-167`).

The page passes the seed via `Module.se1RemixSeed` (read with `host.page_option("se1RemixSeed")`,
like `se1SurvivorsSeed`, `port/web/survivors.js:18`), set from `?remix=<seed>` in a new
`port/web/remix.js` pre-js.

## Plan

1. **API + pure re-roll function.**
   - Add the API 6 entries to `port/common/se1mod.h` (bump to 6), implement the
     `world_*` functions in `port/common/Se1ModHost.cpp` (enumeration walks
     `_pNetwork->ga_World.wo_cenEntities` exactly like `local_player` does,
     `port/common/Se1ModHost.cpp:60-68`; `world_referenced` scans all entities'
     `CEntityPointer` properties for the target's `en_ulID`); register them in
     `SE1Mod_Init` (`port/common/Se1ModHost.cpp:272-324`); mirror the struct in
     `rust/se1-mod/src/host.rs` (bump `API_VERSION`, line 7).
   - Write `rust/se1-mod/src/remix.rs`: `fn rero ll(seed, level, entities) -> Vec<Change>` —
     pure, no host calls. Unit tests: same seed + same entity list → identical changes;
     different seed → different changes; referenced entities never changed; variant changes
     stay within the class enum range; counts preserved.
   - Tests: `cargo test -p se1-mod` (the pure function needs no engine).
2. **Pickups only.** In `se1mod_level_started`, when `se1RemixSeed > 0`, enumerate
   `Health Item`, `Armor Item`, `Ammo Item`, `Weapon Item`, `Ammo Pack`; apply the pure
   function's changes through `world_set_property`. Never touch `KeyItem`, and never touch an
   entity with `world_referenced == 1`.
   - Tests: a Rust unit test that a fixture level's pickup list re-rolls to values inside the
     allowed enums; a browser smoke that the level loads and items pick up (value changes are
     visible in the console log the mod prints).
3. **Monsters within class.** Enumerate `Enemy Base`-derived classes (`Headman`, `Eyeman`,
   `Scorpman`, `Walker`, `Beast`, `Elemental` — the six with variant enums, per
   `port/common/Se1ModEntities.cpp:37-42`), re-roll the variant enum and (optionally) spawner
   `m_ctTotal`/`m_ctGroupSize` by a seed-derived factor. Skip templates referenced by
   teleporter spawners and everything referenced.
   - Tests: unit tests that a Headman template stays a Headman with a valid `m_hdtType`; that
     spawner totals scale; that unreferenced placed monsters change.
4. **Browser determinism test.** `tools/remixtest.mjs` (copy the harness style of
   `tools/inputtest.mjs:13-74` — Chrome via `tools/chrome.mjs`, `send`/`ev`/`until`, `check`
   lines, kill in `finally`): load `serioussam.html?mute=1&remix=12345&level=Levels/KarnakDemo.wld`
   twice (two tabs or sequential reloads), and with `remix=99999`. The mod posts a JSON
   fingerprint (class + variant + position, rounded to 1 unit, of every re-rolled entity) through
   `Module.se1ModUi`. Check: run 1 == run 2 (same seed), run 1 != run 3 (different seed), and the
   layouts differ only in variant/counts, never in positions.
   - Test: `node tools/remixtest.mjs http://127.0.0.1:PORT/serioussam.html`.

## Risks and open questions

- **`Initialize` ordering per entity.** `se1mod_level_started` fires before any tick, but the
  engine does not batch `Initialize` calls — each entity initializes on its own first tick.
  Property writes are safe (they are read at init), but a `world_get_property` right after a
  write may read the pre-init value for derived fields (`m_fValue`, model). The API must
  document that reads are file-value reads, not post-init.
- **Spawner position randomness.** `SpawnEntity` uses `FRnd` for the spawn circle
  (`src/SamTFE/Sources/Entities/EnemySpawner.es:164-167`), so even a fully deterministic remix
  leaves small per-run position jitter in spawner-created monsters. Acceptable for tier 1; a
  future tier could seed the engine's RNG.
- **`world_referenced` cost.** Scanning every entity's `CEntityPointer` properties for each
  candidate is O(N²) over the level's entities. Levels have a few hundred entities; fine at
  level start, but the implementation should build the reference set once, not per query.
- **Serious-mode swap.** On `GD_EXTREME`, spawners swap `m_penTarget` for `m_penSeriousTarget`
  at `Main` time (`src/SamTFE/Sources/Entities/EnemySpawner.es:373-375`) — *after* the remix
  window. If both templates exist, both must be re-rolled consistently.
- **Which levels are safe.** Scripted levels with death-trigger chains (a trigger that fires when
  a specific monster dies, `src/SamTFE/Sources/Entities/EnemyBase.es:134`) are only safe under
  the "same class, keep counts" rule. A per-level opt-out list (like
  `config.toml`'s `[level.per_world]`, `port/data/SE1Mod/config.toml:19-20`) is the escape hatch.
- **`m_bRespawn` items.** Respawning items re-run `ItemReceived` but not `SetProperties`, so a
  re-rolled type persists across respawns — good. Open question: should `m_fRespawnTime` also be
  re-rollable (it is set by `SetProperties` from the type, so it follows the type for free).
- **Handle space.** `world_entities` returns handles from the same 2048-slot pool as
  `spawn`/`spawn_item` (`port/common/Se1ModHost.cpp:55`). A level with more than ~2048
  re-rollable entities would need the pool extended; KarnakDemo has far fewer.
