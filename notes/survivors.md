# Serious Survivors

A Vampire Survivors-style minigame running on the engine. It takes ideas from the original game and
from wow.aethus.pl, which mixes WoW abilities into the survivors loop. You fight with Sam's normal
weapons; the upgrades you pick add auras and procs on top.

## Play

`http://127.0.0.1:8094/serioussam.html?mode=survivors`

- `&level=Levels/<map>.wld` picks the map. The default is `Levels/KarnakDemo.wld`.
- `&svxp=N` starts with N XP, for testing.
- On a level-up, press 1–3 or click a card. Then click the game to grab the mouse again.

## Rules

- **Spawns:** monsters spawn in a ring 18–30 m around the player.
  - The cap starts at 10 and grows by 6 a minute, up to 60.
  - The spawn interval starts at 1.4 s, drops 0.15 s a minute, and never goes below 0.25 s.
- **Monsters and XP per kill:**

  | Monster   | XP | Appears from         |
  |-----------|----|----------------------|
  | Headman   | 1  | the start            |
  | Boneman   | 2  | 20 s                 |
  | Eyeman    | 2  | 60 s                 |
  | Scorpman  | 6  | 120 s                |
  | Werebull  | 12 | boss, every 90 s     |

- **Levels:** XP needed for the next level = previous × 1.25 + 4.
  - Each level-up pauses the game and offers 3 of the 12 upgrades, new or ranked up.
- **Upgrades** (rank r):

  | Upgrade          | Effect                                                    |
  |------------------|-----------------------------------------------------------|
  | Consecration     | Aura: 8+6r damage/s within 5+1.5r m                       |
  | Chain Lightning  | Bolt for 30+15r that jumps 2+r times                      |
  | Multi-Shot       | Every 1.6 s, hits the 2+r nearest foes for 18+8r          |
  | Arcane Explosion | Nova for 40+20r within 8+r m                              |
  | Serious Bomb     | Clears every foe within 30 m (every 50−6r s, min 20 s)    |
  | Fleet Foot       | Move 12r% faster                                          |
  | Vampiric Touch   | Heal 0.5r per kill                                        |
  | Regeneration     | Regenerate 0.6r health/s                                  |
  | Bloodlust        | Abilities recharge 10r% faster                            |
  | Greed            | 20r% more XP                                              |
  | Armory           | Every weapon, fully loaded                                |
  | Second Wind      | Health and ammo refilled now                              |

- **Death:** shows your level, kills and time. Reload the page to retry.

## Code

- `rust/se1-mod/src/survivors.rs` holds the game logic: spawning, XP, upgrades and procs.
  - It runs every frame through the mod layer.
  - It uses the host API v2 in `port/common/se1mod.h`: player, spawn, damage, pause, page overlay.
- `port/web/survivors.js` handles the page side:
  - it reads the URL options;
  - it draws the HUD and the level-up cards;
  - it sends your choice back with `Module._SE1Mod_UiSend`.
- `tools/svtest.mjs` is the browser test, and `tools/test.sh` runs it on both builds.

## Ideas next

- **More upgrades:** orbiting blades, frost nova (slow), ricochet, pickup magnet. XP gems on the
  ground instead of XP on kill.
- **The arena:** a dedicated open map. Karnak's corridors limit the swarm.
- **Co-op Survivors** over the virtual LAN; this needs the mod running on the host only.
- **Balance:** at about 8–10 minutes the monster cap stops rising, so late runs plateau.
