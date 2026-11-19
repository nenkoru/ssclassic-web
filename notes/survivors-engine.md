# Serious Survivors: engine reference (TFE)

What a mod can spawn and change through the host (port/common/Se1ModHost.cpp). `E/` is
`src/SamTFE/Sources/Entities/`. Asset availability was checked against `data/tfe-demo` and
`data/tfe-full-web`.

## Calling entity code from the host

- `Se1ModHost.cpp` is built into the engine library, which has no entity class layouts. There are two
  ways to set entity properties:
  - **Typed:** add a .cpp to `ENTITIES_EXTRA_SRCS` (`port/SamTFE/sources.cmake`). It can include
    `Entities/StdH/StdH.h` and headers such as `Entities/HealthItem.h`, and it exposes `extern "C"`
    helpers to the host.
  - **Untyped:** `pen->PropertyForName("<editor name>")` with
    `ENTITYPROPERTY(pen, ep_slOffset, T)`.
- **Order:** `CreateEntity_t` → set variant properties → `Initialize(event)` → set health and speed.
  - An enemy's `Main` runs inside `Initialize` until its first wait, and it overwrites health and
    speed set before.
- **Missing assets:** a model, texture or sound missing from the data is a FatalError. Spawn only what
  the active data set has.
- **`host_alive`:** it checks `ENF_ALIVE`, so it is always 0 for items, effects and projectiles. Check
  `!(GetFlags() & ENF_DELETED)` for those.

## Visual effects

- **CBasicEffect** (`Classes\BasicEffect.ecl`).
  - Spawn with `Initialize(ESpawnEffect{betType, vNormal, vDirection, vStretch, colMuliplier})`. The
    misspelled field name `colMuliplier` is the engine's.
  - It is visual and sound only. `vStretch` must be greater than 0.
  - Explosions: `BET_ROCKET` 1, `BET_GRENADE` 3, `BET_BOMB` 18, `BET_CANNON` 13, `BET_LIGHT_CANNON` 40.
  - Rings: `BET_CANNONSHOCKWAVE` 16 scales with `vStretch` and lasts 1.25 s; it is the best area ring.
    `BET_SHOCKWAVE` 6 has a fixed size.
  - Other: `BET_TELEPORT` 17 (with sound), `BET_BLOODEXPLODE` 12.
- **CEffector** (`Classes\Effector.ecl`), with `ESpawnEffector{eetType, vDamageDir, vDestination,
  tmLifeTime, fSize, ctCount, penModel, penModel2}`.
  - `ET_LIGHTNING` draws a bolt from the effector to `vDestination`. For chain lightning use
    `tmLifeTime` 0.3–0.5, `fSize` 2–4 and `ctCount` 4–8. Example: `E/PyramidSpaceShip.es:533`.
  - `ET_HIT_GROUND` is a debris burst. `ET_SIZING_RING_FLARE` and `ET_SIZING_BIG_BLUE_FLARE` are
    flashes.
- **CProjectile** (`Classes\Projectile.ecl`), launched with `ELaunchProjectile{penLauncher, prtType,
  fSpeed}`.
  - It flies along the placement's local -Z. Build its angles with `DirectionVectorToAngles`.
  - Damage is credited to the launcher, so kills count for the player.
  - Player rockets also hurt the player above Easy difficulty.
  - Safe in the demo: `PRT_ROCKET`, `PRT_WALKER_ROCKET`, `PRT_LASER_RAY`, `PRT_HEADMAN_*`,
    `PRT_BONEMAN_FIRE`, `PRT_WOMAN_FIRE`, `PRT_CYBORG_LASER`, `PRT_LAVA_COMET`, `PRT_CATMAN_FIRE`,
    `PRT_HUANMAN_FIRE`.
  - Full data only: grenade, beast, the lava golem's projectiles and the cannonball.
- **Recommendation:** draw abilities with effects and deal damage with `host.damage`, so the player
  never hurts themselves.

## Pickups (`E/Item.es`)

- Spawned items don't respawn (`m_bRespawn` is FALSE by default). They are picked up on `EPass`,
  which needs one of the two to be moving.
- For XP gems, do the collect check in the host instead: within a radius, grant the XP and call
  `Destroy()`. To pull an item toward the player, set its placement every frame.
- Item types:
  - **`CHealthItem`:** `m_EhitType` from `HIT_PILL` 0 (+1, goes over 100, flare) to `HIT_SUPER` 4.
  - **`CArmorItem`:** `m_EaitType` from `ARIT_SHARD` 0 to `ARIT_SUPER`.
  - **`CAmmoItem`:** `m_EaitType` is `AIT_SHELLS` 1, `AIT_BULLETS` 2, `AIT_ROCKETS` 3 or
    `AIT_ELECTRICITY` 5.
  - **`CAmmoPack`:** see `E/AmmoPack.es`.
  - **`CWeaponItem`:** see `E/WeaponItem.es`.
- **Gem looks:** `HIT_PILL` (glowing pill) and `ARIT_SHARD`.
- TFE has no power-up items. The mod has to emulate them.

## Enemies (all `CEnemyBase`, `E/EnemyBase.es`)

| Class | Variant property (editor name) | Values / base HP | Data |
|---|---|---|---|
| Headman (Beheaded) | `m_hdtType` "Type" | firecracker 0, rocketman 1, bomberman 2, kamikaze 3; 19.5 HP | demo |
| Boneman (Kleer) | – | 125 | demo |
| Eyeman (Gnaar) | `m_EecChar` "Character", `m_bInvisible` | soldier 60, sergeant 90 | demo |
| Scorpman (Arachnoid) | `m_smtType` "Type" | soldier 300, general 600 (avoid MONSTER) | demo |
| Walker (Biomechanoid) | `m_EwcChar` "Character" | soldier 150 (small), sergeant 750 | demo |
| Werebull | – | 250 | demo |
| Woman (Harpy) | – | 100 | demo |
| Gizmo (Marsh Hopper) | – | 9.5 | full |
| Beast (Reptiloid) | `m_bcType` "Character" | normal 400, big 2000 | full |
| Elemental (Lava Golem) | `m_EetType` "Type" must be `ELT_LAVA`; `m_EecChar` | small 100, big 800, large 10000 | full |

- **Hunting:** each enemy's Watcher sends `EStart`, then `EWatch` once it sees the player. View angle
  is 360 degrees and the ignore range is 200 m.
  - To force a hunt right after `Initialize`: `m_penEnemy = player; m_ttTarget = TT_HARD;`.
  - Set `m_tmGiveUp` high (default 5 s) so they don't give up when out of sight.
- **Scaling (after Initialize):**
  - Health: `SetHealth(h); m_fMaxHealth = h`.
  - Raise `m_fDamageWounded`, or damage-over-time auras stun-lock Headmen and Harpies.
  - Speed: `m_fWalkSpeed`, `m_fAttackRunSpeed`, `m_fCloseRunSpeed`.
- **Elites:**
  - Size: `m_fStretchMultiplier` before `Initialize`, or `StretchModel` + `ModelChangeNotify` after.
  - Glow: `m_colColor` is added to ambient light (e.g. `0xA0200000` for red).
  - `m_bBoss` shows the HUD boss bar.
  - `m_iScore` sets the kill score.

## Sound

- **Host 2D sound, as the menu does:** after engine init,
  `CSoundObject *pso = new CSoundObject; pso->Play_t(CTFILENAME("..."), SOF_NONGAME)`.
  - `SOF_NONGAME` keeps playing while the game is paused. Use a small pool for overlapping sounds.
- **Demo sounds:**
  - Items: `Sounds\Items\HealthPill.wav`, `ArmourShard.wav`, `Ammo.wav`, `Weapon.wav`.
  - Misc: `Sounds\Misc\chimes.wav`, `Teleport.wav`, `Whoosh.wav`.
  - Menu: `Sounds\Menu\Select.wav`.
  - Explosion: `Sounds\Weapons\_Explosion02.wav`.
  - Sam: `Sounds\Player\Quotes\Groovy.wav`, `Lets_rock_and_roll.wav`, `Yeehaw!!!.wav`,
    `Who_is_next.wav`.

## Damage numbers

- The engine has no floating text, so draw it in the page overlay.
- **Projecting a world position to the screen:**
  - Viewer: the player's `en_plViewpoint`, made absolute with `RelativeToAbsolute`.
  - Field of view: `plr_fFOV` × `_fPlayerFOVAdjuster`.
  - Projection: `CPerspectiveProjection3D`, set up as in `E/PlayerWeapons.es:1169`.
  - Screen y = height − v(2). The point is in front of the camera when v(3) < 0.
