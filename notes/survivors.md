# Serious Survivors

A Vampire Survivors-style mode built on the engine. You aim and fire Sam's own guns. Upgrades rank
those guns up, add auto-cast abilities and passives, and evolve the guns.

Background:
- the design research is in `notes/survivors-research.md` (survivors-likes, Serious Sam,
  wow.aethus.pl);
- the engine reference (what a mod can spawn and change) is in `notes/survivors-engine.md`.

## Play

`http://127.0.0.1:8094/serioussam.html?mode=survivors`

- **Bigger maps and extra monsters** (Marsh Hoppers, Reptiloids, Lava Golems) need the full game
  build:
  `http://127.0.0.1:8096/serioussam.html?mode=survivors&level=Levels/01_Hatshepsut.wld`.
- **Lobby:**
  - pick a character and a difficulty;
  - buy permanent upgrades with gold;
  - press Enter to start.
- **During a run:**
  - **Level-up:** 1–4 picks a card, R rerolls, S skips. The mouse stays captured.
  - **Chests:** Space or Enter continues.
  - **Results:** Enter plays again. After a victory, E continues in endless mode.
- **Saved progress:** gold, upgrades, unlocks and the best score are kept in the browser's
  `localStorage`, under the key `se1sv`.

## The run (20:00)

- **Director** (`PHASES` and `EVENTS` in `rust/se1-mod/src/survivors/data.rs`):
  - Each phase has a spawn mix, a minimum number of monsters on the field and a spawn interval.
  - Monsters spawn 18–32 m away, mostly outside the view.
  - Health grows 6% a minute. After 3:00, 4% of spawns are elites: 6× health, bigger, red glow;
    they drop health and ammo.
- **Events:**

  | Time | Event |
  |---|---|
  | 2:00, 17:30 | Swarm (Marsh Hoppers; Beheaded in the demo) |
  | 4:00, 8:00, 10:00, 12:00, 16:00 | Mini-bosses that drop chests (1, 3, 1, 3, 5 items) |
  | 5:00, 11:00, 15:00 | Sirian relics with Serious power-ups (Damage ×4, Invulnerability, Speed, Invisibility) |
  | 6:00, 13:00, 14:00 | Kamikaze stampedes: a scream and a direction marker 2.5 s ahead |
  | 9:00, 18:30 | Werebull runs |
  | 11:30, 15:30 | Kleer rain |
  | 20:00 | The champion: a big Lava Golem, or a giant Arachnoid General in the demo |

  Killing the champion is a victory, with a time bonus. Then you can carry on in endless mode.
- **XP:**
  - Gems: armor shards, or pills for big ones. They are pulled in by a 3.5 m magnet.
  - Gems merge once 120 are on the ground.
  - The XP curve is linear: 5, 15, 25… per level.

## Builds

- **Guns** (Sam's own; ranks I–V; you can carry every gun):
  - Each rank adds +20% damage (the knife +25%), and Luck and the Revolver's rank add critical
    hits (double damage). This goes through the engine's damage hook (host API v6,
    `se1mod_damage`): every hit on a monster the mod spawned asks the mod first, and the mod
    scales the player's hits by the firing gun's multiplier. For projectiles (rockets,
    cannonballs, laser bolts, grenades) the engine passes the projectile's weapon type
    (`SE1ModEnt_ProjectileWeapon`), so a rocket that lands after the player switched guns is
    still scaled and credited to the rocket launcher. Hit-scan bullets and melee use the
    held gun.
  - Damage numbers, the damage-by-source stats and the gun effects (evolution procs) come from the
    same hook events; enemy health is still read every frame for kills and positions.
  - Ammo regenerates by rank.
  - Rank-specific: twin rockets at III; a second revolver at III.
- **Abilities** (4 slots; auto-cast with visible effects):
  - Consecration (ring);
  - Chain Lightning (bolts, elites first);
  - Sirian Missiles;
  - Arcane Explosion;
  - Rain of Fire (explosions on the thickest crowd);
  - Serious Bomb (screen flash).
- **Passives** (5 slots): Fleet Foot, Vampiric Touch, Regeneration, Bloodlust, Greed, Kevlar Vest,
  Big Boom, Netricsa Scanner, Lucky Pyramid, Overheal.
- **Evolutions:** a gun at rank V, plus its paired upgrade, plus a chest opened after 10:00.

| Gun | Pair | Evolution |
|---|---|---|
| Knife | Vampiric Touch | Butcher of Thebes |
| Revolver | Fleet Foot | High Noon |
| Pump Shotgun | Kevlar Vest | Pump-Action Pharaoh |
| Double Coach Gun | Bloodlust | Coach Gun of the Apocalypse |
| Tommy Gun | Greed | Chicago Typewriter |
| Minigun | Regeneration | Lead Hurricane |
| Rocket Launcher | Big Boom | Rocket Party |
| XL2 Laser | Chain Lightning | Sirian Storm Cannon |
| SBC Cannon (full game) | Serious Bomb | Cannon of Mass Destruction |

- **Auto guns:** every gun you own (rank ≥ 1) fires on its own with its own timer, targeting and
  look (Vampire Survivors style). The player only moves and jumps; the gun in hand still works
  manually. One shared sight cache (up to 8 visible foes within 50 m, refreshed at most every
  0.1 s, at most 10 rays) feeds all guns; no ammo is used, the view is not turned. Off with
  `?svautofire=0`.

  | Gun | Aim | Range | Interval (s) | Dmg/hit | Splash (m) |
  |---|---|---|---|---|---|
  | Knife | ring around the player | — | 0.9 | 45 | 3.5 |
  | Schofield Revolver | nearest visible foe | 35 | 0.45 | 10 | — |
  | Pump Shotgun | nearest visible foe | 18 | 1.2 | 30 | 2.5 |
  | Double Coach Gun | nearest visible foe | 12 | 1.8 | 55 | 3.5 |
  | Tommy Gun | nearest visible foe | 40 | 0.15 | 8 | — |
  | XM214 Minigun | nearest visible foe | 45 | 0.08 | 9 | — |
  | Rocket Launcher | thickest crowd | 45 | 2.0 | 70 | 4.0 |
  | XL2 Laser | nearest visible foe | 50 | 0.18 | 14 | — |
  | SBC Cannon | thickest crowd | 35 | 4.5 | 150 | 5.0 |

  The interval shortens per rank (floor per gun); damage scales with rank, might and the same
  per-rank bonus as manual fire; crits double damage (chance `luck × 0.5`, plus `0.05 × rank` for
  the Revolver). Ranks 3/5 take 2/3 targets; Crowd guns fire extra blasts 2–5 m from the centre
  at those ranks. The Revolver keeps its left/right muzzle alternation; Minigun and Laser use a
  thinner tracer. At most one sound per gun every 0.12 s.

  Worth knowing (2026-11-20):
  - The guns only shoot what the player can see (level geometry blocks the sight rays). The
    KarnakDemo run starts indoors and the director spawns around the player, mostly behind walls,
    so standing still the hitscan guns get few targets; the Rocket Launcher and Cannon aim at the
    crowd centre without a sight check. Moving into the open is what feeds them.
  - A different gun goes first each frame. In table order, the first guns killed every foe in sight
    (Gnaars die in a shot or two) and the Minigun and Laser never fired.
  - The demo data has no Cannon model: a gun card never offers it there, and `?svgive` skips it
    too (giving it was a fatal "Cannot open file Cannon.mdl").
  - Test option `?svring=N` keeps N Kleers within 20 m, spawned in sight 2–18 m away (once a
    second, at most 4 at a time), so every gun has targets (`tools/autogunstest.mjs`).

## Meta progression (page side)

- **Characters,** unlocked by achievements:

  | Character | Unlocked by |
  |---|---|
  | Serious Sam | available from the start |
  | Red Rick | surviving 10:00 |
  | Mighty Marvin | 1000 kills in one run |
  | Lucky Larry | evolving a gun |
  | Sirian Sam | a victory |

- **Difficulties:** Tourist, Normal, Serious, Mental. Each one is unlocked by winning the one before.
  Harder difficulties scale enemy health, monster density and gold.
- **Shop:** Might, Armor, Max Health, Recovery, Cooldown, Area, Magnet, Growth, Greed, Luck, Revival,
  Reroll, Skip.

## Code

- `rust/se1-mod/src/survivors/mod.rs`: the run, the director, damage tracking, abilities, cards,
  chests and page messages.
- `rust/se1-mod/src/survivors/data.rs`: the tables (monsters, phases, events, upgrades, evolutions,
  characters, difficulties).
- **Engine access** (host API v4):
  - `port/common/se1mod.h` and `port/common/Se1ModHost.cpp`;
  - `port/common/Se1ModEntities.cpp` for typed access to entity classes.
- **Page:** `port/web/survivors.js`, for the lobby, HUD, damage numbers, cards, chest roulette and
  results.
  - Messages from the mod: `lobby`, `start`, `hud`, `fx`, `offer`, `chest`, `banner`, `warn`,
    `achv`, `end`.
  - Answers go back through `Module._SE1Mod_UiSend`.
- **Test:** `tools/svtest.mjs` checks the level-up flow, the lobby, abilities and an evolution. It
  runs on both builds in `tools/test.sh`.
- **Debug URL options:**

  | Option | Effect |
  |---|---|
  | `svauto=1` | no lobby |
  | `svxp=N` | start with N XP |
  | `svgive=<bit mask>` (with `svrank=N`) | grant upgrades, in `data::ALL` order |
  | `svtime=<seconds>` | start the clock there |
  | `svchest=N` | open a chest with N items |
  | `svgod=1` | god mode |
  | `svcap=N` | monster cap |
  | `svstress=N` with `svkind=K` | monster stress test (`tools/stress.mjs`) |
  | `svbehind=N` | spawn one enemy of kind N-1 behind the player at run start |
  | `svring=N` | keep N Kleers within 20 m, spawned where the player can see them (auto-gun test) |
  | `svthreats=0` | hide the threat markers and hit glow |
  | `svautofire=0` | disable the auto-fire (on by default) |

## Threat warnings

- **Edge markers** (`threats` in the HUD): nearby enemies outside the view are grouped into 8
  directional sectors. Each sector shows a red marker on the screen edge, sized and brightened by
  the threat level (distance, ranged vs. melee, boss/elite). A count badge appears when more than
  one enemy is in the sector. Markers within 8 m pulse.
- **Hit glow** (`hurt` in the HUD): when the player is hit, a red radial glow appears on the screen
  edge in the direction the damage came from, fading over 1.5 s. The engine records the inflictor's
  position in the damage hook (host API v7, `player_hurt`).
- **Test:** `tools/threattest.mjs` spawns a Beheaded Rocketeer behind the player (`?svbehind=2`)
  and checks that the threat marker and hit glow appear.

## Next

- **Co-op Survivors:** the host runs the director, and every player picks their own cards.
- **Damage hook, next steps:** give Serious Damage to the guns through the hook.
- **Characters:** player models per character.
- **Stages:** a stage select with open arenas from the full game.
- **Music:** feed swarms and bosses into the music holder's intensity level.
- **Balance:** a full 20-minute playtest on Normal; the numbers so far come from the research,
  not from play.
