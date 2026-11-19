# Serious Survivors: design research

Research for turning the `?mode=survivors` prototype (see `notes/survivors.md`) into a mode that feels
complete and replayable. It covers Vampire Survivors (VS) and its successors, a close read of
**Azeroth Survivors** (wow.aethus.pl), Serious Sam's own mechanics (with numbers taken from the engine
source in this repo), an evolution table for Sam's guns, Serious-flavoured twists and a prioritized
feature list.

How sure each fact is:
- **[src]** comes from code in this repo (`src/SamTFE/Sources/...`). This is canon.
- **[wiki]** or **[web]** comes from a fetched page, listed under Sources at the end.
- **[aethus]** comes from the English text table inside the game's `wenilla_bg.wasm` (build `056ea9810bc7`, fetched 2026-11-19).
- **[mem]** is from memory and was not re-checked. Treat it as a hypothesis.

---

## 0. TL;DR: what we are missing

The prototype has the loop (spawn → kill → XP → pick 3 cards) but none of the things that make a run *end*,
*pay out* or *look good*. In order of importance:

1. **A run with a shape.** A fixed timer (VS: 30:00, ours: 20:00 suggested), bosses at set minutes that drop
   chests, scripted swarm events, a final boss or Reaper, a victory screen and an endless option.
2. **Pickups on the ground.** XP gems with a 3D magnet, gold, health (Sam's own pills, small, medium,
   large and super health) and rare power-ups (Serious Damage and friends).
3. **Build depth.** Separate weapon and passive slots (VS: 6+6), max ranks, and **evolutions** (max gun +
   paired passive + boss chest after 10:00). Add reroll, skip and banish.
4. **Feedback.** Ability VFX, damage numbers, hit flash, knockback and gibs, a level-up fanfare, a chest
   roulette, and a results screen with a damage-per-weapon table.
5. **Meta.** Gold → permanent PowerUps, characters with a starting gun and a bonus, unlocks gated by
   achievements, stages, and a difficulty ladder (Tourist…Serious…Mental) with reward multipliers.

The XP curve is also a problem today. The prototype's `next = prev × 1.25 + 4` is **exponential**: about
1,440 XP for level 20 alone, against 195 in VS. Runs stall at about level 15. Switch to VS-style linear steps
(section 1.3).

---

## 1. Core loop numbers

### 1.1 Run length and end condition

| Game | Run length | End condition |
|---|---|---|
| Vampire Survivors | 30:00 on most stages; 15:00 or 20:00 on some [wiki] | At 30:00 **The Reaper** spawns: 655,350 HP × player level, deals 65,535 damage, and one more spawns every minute. The run "ends" when it kills you; you still get +500 gold. Killing one before 31:00 counts as a 31-minute survival [wiki]. |
| Brotato | 20 waves: 20, 25 … 55 s for waves 1–8, then 60 s, wave 20 is 90 s. About 17 min of combat [wiki] | Kill the boss (or two) on wave 20 = win. Endless can be turned on [wiki]. |
| 20 Minutes Till Dawn | 20:00 (shorter modes were added later) [mem] | Survive until dawn. |
| Halls of Torment | At most 30:00, 4 bosses per stage, ends at a "tormented lord" [web] | Kill the final lord. |
| DRG: Survivor | A run is several short stages ("depths"), each with mining goals, and you must reach the drop pod within a **30 s extraction timer** [web] | Final stage boss plus extraction. |
| Megabonk (3D) | Each stage has a time limit; find the **boss portal** and kill the boss before time runs out [web] | Boss per stage. |
| Azeroth Survivors | Bosses come at fixed minutes (`"{boss} awaits at {minute}:00"`), then a final boss. "Victory! The zone is saved." → **"Keep fighting (endless)"**. Achievements go up to endless 25/30/40:00 [aethus] | Kill the final boss. Endless is optional. |

**Takeaway:** 15–30 minutes, a visible clock, and a known moment when the run ends. Azeroth's model fits a
mod best: **win at the final boss, then offer endless**. Our current "die eventually" has no climax.

### 1.2 XP pickups

- VS gems: **blue ≤ 2 XP, green ≤ 9 XP, red > 9** [wiki]. If more than **400 gems** are on the ground, new XP goes into
  one red gem instead [wiki]. That keeps the entity count in check, which matters more for us since every gem is an entity.
- Base **Magnet = 30** (VS units). The PowerUp gives +25% per rank, 2 ranks [wiki]. Rare pickups hoover the whole map:
  Vacuum (all gems) [wiki], plus Rosary (screen wipe), Orologion (freeze) and Nduja (fire breath) [mem].
- Azeroth: XP "wisps" and coins fly in from the pickup radius. A **Magnet** object appears with a **pillar of light**
  ("Magnet! Everything on the field comes to you."). Racials and gear add pickup range (Dwarf +30%) [aethus].
- **For us (3D):** use a *cylindrical* pickup radius (horizontal ~3 m base, vertical ±2.5 m) so gems on a ledge or
  under a jumping Sam still count. Gems should fly to the **camera/chest height, not the feet**, with acceleration
  so the pull reads clearly in first person. Give the magnet pickup a tall light beam, since it must be found in 3D.
  Cap gems at about **150** and merge anything beyond into the nearest red gem.

### 1.3 Level curve

- VS: level 1→2 costs **5 XP**, then **+10 per level up to 20**, **+13 to 40**, **+16 after**. There are extra one-off costs
  of 600 XP at level 20 and 2,400 at 40, during which Growth is +100% [wiki]. That is about 1,805 XP total at level 20
  and about 9,886 at level 40 [wiki]. The cost is *quadratic in total* and *linear per level*, so a run reaches level
  60–100+ as enemy XP and density grow with time.
- **Ours today:** `prev × 1.25 + 4` is exponential. A Headman gives 1 XP, so late levels become impossible and the
  run flattens. **Recommendation:** `need(n) = 5 + 10(n−1)` up to 20, then +13 and +16 per level. Scale XP per kill by
  monster tier (Gizmo 1, Headman 1–3, Kleer 4, Gnaar 3, Werebull 10, Arachnoid 15–60, Biomech 20–75) and let
  density carry the rest.

### 1.4 Slots, ranks and choices

| | VS | Brotato | Azeroth | Megabonk |
|---|---|---|---|---|
| Weapon slots | **6** | **6** guns | Spell slots `{n}/{max}`; 3 class spells offered per level | ~4 weapons |
| Passive slots | **6** | unlimited items | Ring and trinket slots, **1 amulet** | ~4 "tomes" |
| Max rank | Weapons usually **8**, passives **5** [mem] | Weapon tiers I–IV; merge 2 of the same tier into the next | "Rank N", rarity decides the strength of each pick | – |
| Choices per level | **3**, a **4th** by Luck [wiki] | 4 stat upgrades per level, 4 shop offers [wiki] | **3** cards (keys 1/2/3); the **Opening Hand** perk deals 4 at the first level-up | – |
| Reroll / skip / banish | PowerUps: Reroll +2 per rank, Skip +2, Banish +2 (max 10 each) [wiki] | Rerolls cost money: first = ⌊0.75 × wave⌋ + ⌊0.4 × wave⌋, then each adds ⌊0.4 × wave⌋ [wiki] | **R** rerolls (free count, then a gold cost), **Skip (+gold)**, **Banish** from account perks (1–3 per run) [aethus] | – |

Two more details:
- **Card rarity** (Azeroth): "Choose a spell. Its rarity decides how strong it is." Common through Legendary changes
  the *size* of the rank-up [aethus]. This is a cheap way to add excitement to the same card.
- **When everything is maxed**, VS offers gold or floor chicken (heal 30) instead [wiki].
- **Recommendation:** 6 "gun ranks" (Sam's guns) plus 4 ability slots plus 6 passive slots. Offer 3 cards, a 4th by
  Luck. Gun ranks max at 5, abilities at 5, passives at 5. Start with 1 reroll; skip gives gold; banish comes from meta.

### 1.5 Chests

- VS chests **drop from bosses**, not from light sources [wiki]. Item count is rolled 5 → 3 → 1 with per-boss odds × Luck.
  Mad Forest's 9:00 Silver Bat uses 5 items 3%, 3 items 10%, 1 item 50%, otherwise a fallback of 1 [wiki].
- Tiers: **Bronze**, before 10:00, no evolution. **Silver**, after 10:00, can evolve. **Gold** can give new weapons.
  **Arcana** (purple) at 11:00 and 21:00 [wiki].
- Gold per chest: 100–200 (1 item), 300–600 (3), 500–1,000 (5) [wiki].
- The first six chests follow the fixed sequence **1-1-3-1-1-5** and can't be skipped. The 5-item animation ends with
  fireworks and has its own jingle [wiki]. That scripted early 5-chest is a deliberate dopamine hook.
- Azeroth: **Battleground Cache**. Right-click to *buy* it with gold; the cost rises; the HUD shows `gold  cache {cost}`.
  It offers a **choice** of ring, trinket or amulet. Guardians and elites drop the same choice [aethus].
  Megabonk also sells chests at rising gold costs [web].
- **For us:** boss chest = VS roulette (1/3/5 items, evolution-capable after 10:00). Add Azeroth-style **gold caches**
  placed in the arena that you buy with the Use key. That gives gold a use inside the run.

### 1.6 Evolutions, unions, arcanas

- VS evolution: **max-level weapon + its paired passive (at any level, sometimes max) + an evolution chest**, usually from a
  boss at or after 10:00. The evolved weapon replaces the base one in the same slot; the passive stays [wiki].
  Examples: Whip + Hollow Heart → Bloody Tear; Magic Wand + Empty Tome → Holy Wand; Knife + Bracer → Thousand Edge;
  Garlic + Pummarola → Soul Eater; Fire Wand + Spinach → Hellfire [wiki].
- **Unions** fuse two max weapons into one slot (Peachone + Ebony Wings → Vandalier) [wiki].
- **Arcanas** are 22+ run-wide rule changers. Pick one at the start, more from the 11:00 and 21:00 bosses, 3 per run [wiki].
  Examples: *Gemini* (weapons gain a counterpart), *Twilight Requiem* (projectiles explode when they expire),
  *Sarabande of Healing* (healing doubled and damages nearby enemies), *Mad Groove* (every 2 min, pulls in all pickups).
- Azeroth has the same idea in two forms:
  - **Legendary amulets** "remake one spell each, so each class has its own." One is offered only once the hero knows
    that spell [aethus]. This is VS evolution, gated by the drop.
  - **Talent milestones** change rules ("Whirlwind and Bloodthirst strike twice", "every 10th kill unleashes a free
    Whirlwind") [aethus].
- DRG:S: **overclocks** at weapon levels **6 and 12 (balanced)** and **18 (unstable)**, e.g. *Death Spiral: +200% fire
  rate, bullets in a spiral* [wiki].

### 1.7 Gold and pickups

- VS: floor chicken heals **30 HP** and drops from light sources (braziers, about 10% per spawn, up to 50% with Luck) [wiki].
  Coins, coin bags and rich coin bags are worth 1 / 10 / 100 [mem]. Gold is spent only in the meta shop.
- Azeroth: gold drops from mobs and buys caches in the run. Gold left at the end goes to the account?
  (`end.gold_earned` is shown on the end screen). **Runes** are timed pickups: **Speed Rune (+60% move)**,
  **Berserker Rune (+50% damage)**, **Restoration Rune** [aethus].
- **For us:** Sam's real pickups *are* the health economy (section 5.4). Use them unchanged.

### 1.8 Waves and spawns

VS stages are **minute-by-minute tables**. Each minute sets the enemy types, a **minimum enemy count** (refilled at once),
a spawn **interval**, an optional **boss** with a chest config, and **map events** [wiki]. Mad Forest examples [wiki]:

| min | enemies | min count | interval | boss | event |
|---|---|---|---|---|---|
| 0 | small bats | 15 | 1.0 s | – | – |
| 1 | zombies, bats | 30 | 1.0 s | Glowing Bat → chest | – |
| 2 | bats | 50 | 0.5 s | – | Bat Swarm ×3 |
| 3 | skeletons | 40 | 0.25 s | Glowing Bat | swarm 10% |
| 7 | bats, mudmen | 80 | 0.5 s | Glowing Bat (Lv2 chest) | Bat Swarm ×6 |
| 10 | mudmen | 10 | 0.5 s | Giant Mantichana (evo chest) | **Flower Wall 60 s** (encirclement) |
| 11 | skeletons | **300** | 0.1 s | Arcana boss | – |
| 13 | werewolves, ghosts | 150 | 0.5 s | – | Ghost Swarm ×21 |
| 15 | werewolves, giant bats, mudmen | 100 | 0.1 s | Giant Werewolf (evo) | Flower Wall |
| 25 | Venus | 100 | 0.1 s | Giant Blue Venus | Flower Wall ×6 |
| 30 | **Reaper** | – | – | – | clears the field |

Patterns worth copying:
- **Minimum count, not a cap.** The game *refills* to the minimum at once. Pressure is constant even when you kill fast.
- **Swarms** are lines of fast enemies that cross the screen and despawn. They test movement, not damage.
- **Encirclement** ("Flower Wall") is a ring of slow, tanky enemies that closes in. You must break out.
- **Calm minutes** (min 5: 10 mudmen) after a spike give a breather and a sense of rhythm.
- Azeroth's announced events: **"Swarm surrounds you!" "A stampede charges through!" "A wall of foes closes in!"
  "A pack hunts you!"**, plus **"An Explosive Orb appears! Destroy it before it bursts!"**, boss yells, and
  **guardians** in lairs: "%s is slain! Its lair yields treasure and its strength, and the other guardians grow
  stronger" [aethus].
- Brotato puts **elite/horde waves** at 11–12, 14–15 and 17–18 on higher dangers [wiki].

**Difficulty curve:** pressure rises in steps (new enemy tier every 2–5 min, then spikes) rather than smoothly.
VS's **Curse** stat (+10% enemy speed, HP, quantity and frequency per rank) is the knob players turn up themselves [wiki].

---

## 2. Meta progression

### 2.1 VS PowerUps (gold shop) [wiki]

Price = `Initial × (1 + bought_of_this) + ⌊20 × 1.1^total_bought⌋`, and the fee is 0 for the very first purchase.
Buying anything makes everything dearer, which nudges the player to pick priorities.

| PowerUp | per rank | ranks | initial cost |
|---|---|---|---|
| Might | +5% damage | 5 | 200 |
| Armor | +1 flat damage reduction | 3 | 600 |
| Max Health | +10% | 3 | 200 |
| Recovery | +0.1 HP/s | 5 | 200 |
| Cooldown | −2.5% | 2 | 900 |
| Area | +5% | 2 | 300 |
| Speed (projectile) | +10% | 2 | 300 |
| Duration | +15% | 2 | 300 |
| Amount | +1 projectile | 1 | 5,000 |
| Move Speed | +5% | 2 | 600 |
| Magnet | +25% | 2 | 300 |
| Luck | +10% | 3 | 600 |
| Growth | +3% XP | 5 | 900 |
| Greed | +10% gold | 5 | 200 |
| **Curse** | +10% enemy speed, HP, quantity, frequency | 5 | 1,666 |
| Revival | +1 revive at 50% HP | 1 | 10,000 |
| Reroll / Skip / Banish | +2 each | 5 | 1,000 / 100 / 100 |

Base stats: 100 HP, Magnet 30, Luck 100%, Amount 0, Cooldown 100% [wiki].

### 2.2 Characters and unlocks

- VS characters have a **starting weapon plus a scaling bonus** [mem]. Examples: Antonio (Whip, +10% Might every 10
  levels), Imelda (Magic Wand, XP bonus), Gennaro (Knife, +1 Amount), Poe (Garlic, +pickup, −HP), Krochi (Cross,
  +1 Revival). They are bought with gold, and each purchase raises the next price by 10% [wiki]. Secret characters
  come from coffins and achievements.
- **About 280–490 unlocks** [wiki]. They follow a handful of patterns:
  - "Survive X minutes with Y", from 1 to 30 minutes: Hollow Heart at 1 min, Peachone at 10 min.
  - Level a weapon to N: King Bible Lv4 → Bracer.
  - Hold 6 weapons → Empty Tome.
  - Evolve X → gold.
  - Kill 3,000 Skeletons → Mortaccio.
  - Earn 5,000 coins in a run → a character.
  - Level 20 on a stage → the next stage.
  - Level 50 with a character → that character's Arcana.

  **Every unlock adds content to the pool.** That is where VS gets its replay value.
- Stages are unlocked in sequence. **Hyper** variants (faster, more gold) unlock by killing a stage's minute-25 boss [wiki].
- **Curse** is the voluntary difficulty-for-reward dial.

### 2.3 Azeroth Survivors' meta, which is deeper than VS's [aethus]

- **Hero = class + race + name.** Gear is kept *per class*.
- **Talents.** Each class has 3 trees named after WoW talent trees (Arms, Fury, Protection, and so on). Points come
  from *talent experience* earned in runs. Each tree has plain % nodes, then **Milestones** (60 in all) that change
  rules, then a **Capstone** (31). A capstone usually "starts every run with spell X" and gives it a defining twist,
  e.g. *Bladestorm: you start every run with Whirlwind… a free Whirlwind every 3 sec*.
- **Account perks** are bought with **achievement points**:
  - Second Thoughts: +1/2/3 free rerolls.
  - Banish: 1/2/3 per run.
  - Skip: pass a hand for gold.
  - Opening Hand: 4 cards at the first level-up.
  - Veteran's Lessons: catch-up XP for weaker classes.
  - Keen Eye: better boss drops.
  - **Companion**: a pet that fetches coins and XP up to 25 yd beyond your pickup radius. Upgrades: Long Leash,
    Quick Paws, and instincts like Gold-sniffer, Wisp-herder and Rune-hound. A Second Companion is available.
- **Gear collection.** Bosses drop the class's armor and weapons "for good" (a collection log with drop tables).
  Pieces are upgraded with **marks** to 5 stars. 4- and 8-piece **set bonuses** apply; all 8 at 5 stars is "empowered".
  Cosmetic tabards and transmog looks come from achievements.
- **Zones** (14): Elwynn, Duskwood, Warsong Gulch, Arathi Basin, Feralas, Gurubashi Arena, Alterac, Blackrock,
  Ahn'Qiraj, Un'Goro, Scarlet Monastery, Scholomance, Naxxramas and more. Each opens by beating the previous zone's
  final boss. Each has about 5 named bosses (Elwynn: Hogger, Mother Fang, Rhahk'Zor, Mr. Smite, Edwin VanCleef) with
  yells and phase lines.
- **Difficulty.**
  - **Heroic I–V** per zone ("Enemy health ×, damage ×, marks ×, loot and talent experience ×"). Heroic tiers also
    raise the star cap on gear.
  - **Run Options** are sliders for enemy density ("more of the horde, each kill worth less"), health, damage and
    speed, with a combined reward multiplier. There is an achievement for winning at full reward.
- **Achievements** cover: kills in a run (2,500 / 6,000), lifetime kills (10k / 100k / 1M), win without buying a cache,
  win with no gear, slay 4 guardians before 8:00, endless 25 / 30 / 40 minutes, every class beating every zone, and
  co-op feats ("Defeat Whitemane with 5 Paladins… Consecration must deliver the killing blow").

### 2.4 Others in one line each

- **Brotato:** no meta shop. Characters (40+) *are* the meta; each changes the rules (e.g. only melee weapons). Danger 0–5 is the ladder [wiki].
- **Halls of Torment:** **Blessings** (gold, permanent stats) plus **quests** (60+) that unlock items and characters.
  You can bring found items back up the **Well** to equip on later runs [web].
- **DRG:S:** minerals bring persistent class and weapon upgrades; overclocks unlock through play; artifacts [web].
- **20MTD:** **Runes** are a permanent tree bought with souls; characters and guns unlock; **Darkness** levels act as the
  difficulty ladder [web, partly mem].

---

## 3. Game feel

| Element | Reference behaviour | First-person notes for us |
|---|---|---|
| **Damage numbers** | VS: optional per-hit floaters, white and small. Azeroth: WoW-style combat text, crits bigger. | Use world-space billboards above the head. **Aggregate per target every 0.2 s** or the screen fills up. Crit/×4 Serious Damage numbers in gold and larger. Keep a toggle in options. |
| **Hit flash** | VS: enemies flash white for 1–2 frames on every hit [mem]. | Tint the model white or red for 60 ms. The engine has per-model colour (`mo_colBlendColor`) [mem]; a minimal entity hook would set it on `ReceiveDamage`. |
| **Knockback** | VS: per-weapon knockback, bosses resist. | The TFE engine already applies damage impulses (`m_fBlowUpAmount`, gibs) [src]. Shotgun pushback reads very well in FP. |
| **Gibs** | – | TFE monsters gib at a damage threshold (Headman 65, Kleer 70, Gnaar 100–130) [src]. That is half of Sam's game feel; keep `gam_bGibs = 1`. |
| **Kill counter** | VS: top-right skull plus count. Azeroth HUD: `Kills`, `Gold`, `next boss in {time}` [aethus]. | Top-centre timer, kill count, gold, and "NEXT BOSS 2:31". |
| **Level-up fanfare** | VS: sting, freeze, light burst, bright card frames by rarity. | Short white flash, a 0.3 s time slow before the pause, Sam's quip, card border colour by rarity. |
| **Chest opening** | VS: chest bounces, coins fountain, slot-machine roulette that stops on items, 1/3/5 jingles, fireworks on 5 [wiki]. | Draw it as a full-screen overlay (pause). Spin weapon icons from the TFE HUD (`TexturesMP/Interface/` weapon icons) [mem]. |
| **Screen flash** | Rosary or bomb: white screen. | TSE's Serious Bomb already does flash and shake (`m_tmSeriousBombFired`) [src]. |
| **Sound** | Gem pickup "tink" pitch rises for rapid pickups; level-up chime; boss warning horn. | Rising pitch ladder on rapid gem pickups. Netricsa beep for announcements. Sam's lines. |
| **Results screen** | VS: survived time, gold, level, kills, plus a **per-weapon table: level, damage, time held, DPS**. Azeroth: Survived, Level, Elites, Guardians, Bosses slain, Damage dealt and taken, Gold earned, Caches opened, then loot "NEW" [aethus]. | Add a per-weapon/ability damage table plus TFE-style **SCORE / KILLS / SECRETS / TIME BONUS** (section 5.6). |
| **Pause screen** | VS: weapons and passives with ranks, full stat sheet. Azeroth: "Run Stats" with each stat explained [aethus]. | Show the build in Esc with each card's rank and the current numbers. |
| **Telegraphs** | Azeroth: boss yells plus banner text ("%s approaches!"); magnet pillar of light. | Essential in FP because threats can be behind you. Add a directional warning arc on the HUD edge for swarms and charging Werebulls. |

---

## 4. Azeroth Survivors (wow.aethus.pl) in detail

**Tech** [aethus/page]. A Rust + Bevy client compiled to a 93 MB wasm that needs WebGPU. It streams original WoW 1.12
assets from `./data` (about 30k files). The page only boots the client; all UI is drawn by the client. Saves live in
`localStorage['rogue.characters']`. There is co-op for up to 5 players (if a player stalls, "a card was taken for it").
It has 10 languages and touch controls. Press coverage: PC Games (DE) and tier-list sites [web].

**Controls:** WASD, or both mouse buttons to run. Space jumps. 1/2/3 pick a card, R rerolls. Right-click buys a cache.
C toggles camera lock. Spells **cast automatically**. Targeting text: "Bosses and elites are targeted first", "the
toughest enemy", "the thickest group" [aethus].

**Classes** (9; each starts with one spell and gets three of its own spells offered per level) [aethus]:

| Class | Spell pool (abilities as survivors "weapons") |
|---|---|
| Warrior | Cleave, Whirlwind, Thunder Clap, Mortal Strike, Execute, Demoralizing Shout, Battle Shout, Bloodthirst, Rend, Shield Slam, Bloodrage |
| Paladin | Consecration, Exorcism, Hammer of Wrath, Holy Shock, Holy Wrath, Judgement, Hammer of Justice, Holy Light, Divine Shield, Holy Shield, Redemption |
| Hunter | Auto Shot, Arcane Shot, Multi-Shot, Serpent Sting, Volley, Explosive/Immolation/Frost Trap, Kill Command, Concussive Shot, Aimed Shot, Hunter's Mark |
| Rogue | Sinister Strike, Eviscerate, Blade Flurry, Rupture, Kidney Shot, Gouge, Ghostly Strike, Adrenaline Rush, Backstab, Slice and Dice, Seal Fate |
| Priest | Smite, SW: Pain, Mind Blast, Holy Nova, PW: Shield, Renew, Holy Fire, Mind Flay, Psychic Scream, Devouring Plague, Lightwell, Penance |
| Shaman | Lightning Bolt, Chain Lightning, Earth/Flame/Frost Shock, Lightning Shield, Magma/Searing Totem, Fire Nova, Healing Wave, Call of Flame, Stormstrike, Rockbiter |
| Mage | Fireball, Frostbolt, Arcane Missiles, Frost Nova, Arcane Explosion, Blizzard, Flamestrike, Fire Blast, Cone of Cold, Blast Wave, Pyroblast, Ice Barrier, Polymorph, Arcane Power |
| Warlock | Shadow Bolt, Corruption, Immolate, Curse of Agony, Rain of Fire, Hellfire, Death Coil, Searing Pain, Drain Life, Fear, Soulfire, Demonic Empowerment |
| Druid | Wrath, Moonfire, Starfire, Hurricane, Insect Swarm, Entangling Roots, Rejuvenation, Regrowth, Thorns, Swipe, Shred, Faerie Fire |

**How WoW abilities map to survivors archetypes:**
- **Aura or tick around you:** Consecration, Hellfire, Arcane Explosion, Thunder Clap, Whirlwind.
- **Auto-target projectile:** Shadow Bolt, Fireball, Arcane Missiles ("fires N missiles at random enemies… all at
  bosses and elites when any are near").
- **Chain:** Chain Lightning, "jumps to up to N more enemies… 8% weaker with each jump".
- **Ground AoE on the densest group:** Blizzard, Rain of Fire, Flamestrike.
- **DoT that stacks:** Corruption, SW:Pain ("Stacks up to N times on one enemy: bosses and elites take every stack first").
- **Execute below 30%:** Execute, Hammer of Wrath.
- **Summons:** pets, totems, Lightwell.
- **Triggered defensives:**
  - Holy Light "cast when you fall below 85% health".
  - Divine Shield "below 35%".
  - PW:Shield "cast again once the shield breaks".
- **Cheat-death:** "A blow that would kill you leaves you at 30% health… once every 90 sec".

**Races** are periodic auto-cast racials plus passives:
- Human: +15% damage for 10 s every 30 s; +20% XP; +20% gold.
- Orc: Blood Fury +35% for 12 s every 40 s.
- Dwarf: shield of 45% max HP every 30 s; +30% pickup range.
- Night Elf / Undead: near-death immunity for 3–4 s on a 60–75 s cooldown.
- Tauren: 2 s stun every 15 s.
- Gnome: root every 20 s; −8% cooldowns.
- Troll: +30% cooldown speed bursts; +1.5 HP/s.

**Run stats** (the full stat sheet, which is a good model for our passives): Health, Damage, Haste, Crit, Crit Dmg,
Armor (60% cap), Area, **Targets** (+N targets to every ability), **Echo** (chance to cast twice; past 100% it can
cast three times), Speed, Regen, Pickup, Lifesteal, Kill Heal, Thorns, Lives, XP, Gold, Luck, Buff Power, DoT Stacks,
DoT Haste, and conditional damage: vs Elites, Execute (<30%), vs Controlled, vs Afflicted, while Shielded.

**In-run jewellery** works as item builds on top of spells. Rings and trinkets take slots and "grow by nearly the
pick's whole worth" when picked again. Amulets: you wear one, and a new one replaces it ("The one you wear now is lost
for good"). Legendary amulets remake a spell. Sources are caches, elites and guardians. A codex collects everything
you have *seen*.

**Ideas worth stealing:**
1. **Targeting priority text.** Auto-abilities prefer bosses and elites, then the most wounded. It makes auto-fire feel smart.
2. **Card rarity scales the same upgrade.** Cheap variety with a big emotional payoff when a Legendary rolls.
3. **Triggered defensive spells** (heal below 85%, immunity below 35%) and **cheat-death with a cooldown**.
   Very good for FP, where you can't see what hits you from behind.
4. **Echo / cast-twice and +Targets as universal stats.** Every ability benefits, so synergies are easy.
5. **Guardian lairs.** Optional mini-bosses that sit on the map. Killing one gives jewellery and makes the others stronger.
   Risk and reward on your own schedule.
6. **Buy-a-cache with gold** in the run, at a rising price, gives gold a purpose before the meta shop exists.
7. **Companion pet** that fetches pickups beyond your radius. In 3D this solves "gems fell behind a pillar".
8. **Explosive Orb** event: a "destroy it before it bursts" target that forces you to aim. Perfect for FP.
9. **Announced events** in plain language ("A wall of foes closes in!").
10. **Run Options sliders** with a reward multiplier, and **Heroic** tiers that raise loot caps.
11. **Endless after victory** as an explicit choice.
12. **Rune pickups** (speed, berserk, restore). That is exactly Serious Sam's power-up family, see section 5.3.

---

## 5. Serious Sam canon (what the engine already has)

The TFE web build compiles `src/SamTFE/Sources/Entities` (`port/SamTFE/sources.cmake`, `ENTITIES_DIR "Entities"`).
**That set has no PowerUpItem and no Serious Bomb.** Those come from TSE (`EntitiesMP`). In TFE the mod must emulate
power-ups (section 6.3).

### 5.1 Weapons (TFE `Entities/PlayerWeapons.es`, `Projectile.es`, `CannonBall.es`) [src]

| # | Weapon | Damage | Rate | Ammo (max) | Feel and role |
|---|---|---|---|---|---|
| 1 | Military knife | 100, range 3 m, 2 m wide | ~0.5 s per slash | – | Panic melee, gib-happy. Single-player value. |
| 2 | Schofield .45 revolver(s) | 10 per shot | anim-bound (~3–4/s), reloads 6 | infinite | Reliable plinker; dual-wield alternates hands. Infinite ammo means always useful. |
| 3 | Single shotgun | 7 pellets × 10 = 70 | 0.375 s single player / 0.5 s co-op | shells 100 | Close-range workhorse, strong pushback. |
| 4 | Double coach gun | 14 pellets × 10 = 140, uses 2 shells | 0.15–0.25 s + reload anim | shells 100 | The iconic up-close deleter. Gibs Kleers. |
| 5 | Tommy gun | 10 per bullet | 0.1 s (10/s) | bullets 500 | Accurate mid-range. Shares ammo with the minigun. |
| 6 | XM214 minigun | 10 per bullet | 1 per tick once spun up (0.5 s spin-up, 3 s spin-down) | bullets 500 | Horde shredder. The spin-up is part of the fantasy. |
| 7 | Rocket launcher | 75 hit + 75 splash (single player), 4 m hot spot, 8 m falloff | anim-bound (~0.6–0.8 s) | rockets 50 | Crowd and mid-boss. Rocket-jump capable. |
| 8 | Grenade launcher | 75 + 100 splash; hold fire to charge launch power | ~0.5 s | grenades 50 | Bouncing artillery over walls of Kleers. |
| 9 | XL2 laser | 20 per bolt | 0.1 s (10/s) | cells 400 | Long-range shredder for Gnaars and Harpies. Green bolts. |
| 10 | SBC cannon (XPML21) | 400–750 by speed; balls roll through enemies; splash 25 / 4 × 4 | hold to charge | iron balls 30 | Bowling for monsters. Ultimate crowd piercer. **The code still has a cut "NukeBall": 600–800 + 13 explosions** (`CannonBall.es`, `MAX_NUKEBALLS` commented out). |
| TSE | Chainsaw | contact damage every 0.05 s | continuous | – | Melee shredder with camera shake. |
| TSE | Flamethrower | per-flame ticks | 0.1 s | napalm 500 | Short-range DoT cone. |
| TSE | Raptor sniper | 90 SP / 300 co-op, zoom | slow | 50 | Precision; pierces in effect. |
| TSE | Serious Bomb | kills everything nearby; screen flash; 4 s lockout; up to 3 held | – | – | The panic button. Our prototype already borrows the name. |

**Ammo economy:**
- Most guns draw from shared pools: shells (100), bullets (500), rockets (50), grenades (50), cells (400),
  cannonballs (30). The revolver is infinite.
- Pickups come in boxes and packs. Weapons dropped by `WeaponItem` give ammo when you already own them [src].
- Ammo scarcity is a real **resource layer** that VS lacks; it is a lever for us (section 7).

### 5.2 Difficulty [src]

- Levels: **Tourist, Easy, Normal, Hard, Serious**, plus the hidden **Mental**, where enemies fade in and out
  (`sp_bMental`, `ent_tmMentalIn/Out/Fade`).
- Tourist regenerates 1 HP/s.
- Easy and Tourist raise the health cap to 300 and the armour cap to 300.

### 5.3 Power-ups (TSE `EntitiesMP/PowerUpItem.es`, `Player.es`) [src]

| Power-up | Duration | Effect | Item respawn |
|---|---|---|---|
| **Serious Damage** | **40 s** | All player damage **×4** (`GetSeriousDamageMultiplier`); yellow particle glow | 40 s |
| **Invulnerability** | **30 s** | No damage; glow | 60 s |
| **Serious Speed** | **20 s** | Fast movement | 40 s |
| **Invisibility** | **30 s** | Enemies lose you; shimmering model | 40 s |
| **Serious Bomb** | pickup (hold up to 3) | Screen wipe, 4 s lockout | 40 s |

### 5.4 Health and armour [src]

| Health | Value | Over 100? | | Armour | Value |
|---|---|---|---|---|---|
| Pill | **+1** | **yes, up to 200** | | Shard | +1 (over cap) |
| Small | +10 | no (cap 100) | | Helm | +5 |
| Medium | +25 | no | | Small | +25 |
| Large | +50 | no | | Medium | +50 |
| **Super** | **+100** | **yes, up to 200** | | Strong | +100 |
| | | | | Super | +200 |

- Caps (Normal and above): **TopHealth 100, MaxHealth 200**; **TopArmor 100, MaxArmor 200**.
- Over-top pickups (pill, super) are the "overheal" fantasy. Use pills as the *common* drop: tiny, many, satisfying.
  That is Serious Sam's own XP-gem-like trickle.

### 5.5 Monsters [src] (TFE `Entities/*.es`)

| Monster (code class) | HP | Score | Signature behaviour | Survivors role |
|---|---|---|---|---|
| Beheaded Firecracker (Headman) | 19.5 | 200 | Shoots firecracker bursts | Fodder with chip damage |
| Beheaded Rocketeer | 19.5 | 100 | Rockets | Fodder at range |
| Beheaded Bomber | 19.5 | 500 | Lobs bombs | Area denial |
| **Beheaded Kamikaze** | 19.5 | **2,500** | **Runs at you screaming, holding bombs, explodes** | The genre's perfect swarm unit. The scream is the audio telegraph. |
| Kleer (Boneman) | 125 | 1,000 | Gallops at 10–13 m/s, **leaps at you** (`JumpOnEnemy`, 20 damage), throws twin fireballs | Fast melee pressure, the "skeleton tide" |
| Gnaar (Eyeman) | 60 / 90 | 500 / 1,000 | Flying one-eyed melee; the purple variant is tougher | Air swarm |
| Marsh Hopper (Gizmo) | **9.5** | 500 | Hops at 15–20 m/s, kamikaze-jumps and pops into goo | Piñata swarm, fun with shotgun and minigun |
| Sirian Werebull | 250 | 2,000 | **Charge at 22–27 m/s**, faster than Sam, and tosses you | Stampede event, mini-boss |
| Arachnoid (Scorpman) soldier / general / monster | 300 / 600 / 1,200 | 1k / 5k / 10k | Slow (4.5–6 m/s) **gatling arm**, hitscan bursts | Elite turret, forces cover |
| Reptiloid (Dragonman) soldier / sergeant / monster | 150 / 450 / 1,350 | – | Homing fireballs, leaps | Elite caster |
| Biomechanoid (Walker) small / big | 150 / **750** | 2,000 / 7,500 | Small fires lasers; **big fires rocket salvoes** | Artillery elite, mini-boss |
| Scythian Harpy (Woman) | 100 | 1,000 | Flies, dives, shoots | Aerial harasser |
| Fish | 30 | 500 | Electric bite in water | Map-specific |
| **Ugh-Zan III (Devil)** | **40,000 × multiplier** | 1,000,000 | Final boss; pulses health back in (`HEALTH_IMPULSE`); huge projectile attacks | The finale or "Reaper" |

**Dynamic music** [src]: `MusicHolder` sums the score of nearby enemies ("fuss score") and switches between calm,
medium (≥100) and heavy (≥1,000) tracks. That gives us **free adaptive music** for swarms and bosses if survivors
spawns are counted in the fuss.

### 5.6 Score and stats screen [src]

- Every kill adds the monster's `m_iScore`.
- At level end: **TIME BONUS = 100 points × (estimated level time − actual time, in whole seconds)**, clamped at 0
  (`Player.es`).
- The stats screen shows **SCORE, KILLS x/y, SECRETS x/y, TIME, TIME BONUS, TOTAL SCORE**, and a high score.
- The Kamikaze's 2,500 points versus 200 for a Firecracker already makes the right "kill the scary one" incentive.

### 5.7 Arena design and voice [mem]

- **Arena lock-ins.** Walls or doors close and waves pour in from markers, often announced by a sound sting.
  This is the series' signature beat.
- **NETRICSA**, Sam's implant AI, files an entry for every new monster, weapon and location: dry,
  pseudo-scientific and funny. It also pops up messages and hints during levels.
- **Sam's quips** are short wisecracks on pickups, kills and secrets; his "Heh heh" laugh is famous. The tone is
  1950s action-hero cheese.
- **Secrets** are hidden pickups (often Super Health, armour or ammo), counted on the stats screen.

---

## 6. Evolutions on Sam's own guns

### 6.1 Rules (VS-style)

- **Gun ranks 1–5** are earned from level-up cards, e.g. "Double Shotgun ★3". Owning a gun means you can rank it;
  cards for unowned guns grant the gun.
- **Evolution trigger:** gun at **★5 (max)**, plus its **paired passive owned (any rank)**, plus **open a boss chest
  after 10:00**. The chest's first roll becomes the evolution, with roulette and fanfare. The evolved gun replaces the
  base one on the same number key.
- The **pair is shown on the card** ("Evolves with: Vampiric Touch"), the way VS's collection lists it.
  Azeroth's codex shows undiscovered evolutions as silhouettes.
- **Unions** (two max items into one) are reserved for the laser plus Chain Lightning and the cannon plus Serious Bomb.

Passives proposed beyond today's five (Fleet Foot, Vampiric Touch, Regeneration, Bloodlust, Greed):
- **Kevlar Vest:** +armour per second, max armour.
- **Big Boom:** +area.
- **Duplicator:** +1 projectile on procs.
- **Lucky Pyramid:** luck.
- **Netricsa Scanner:** pickup radius.
- **Overheal:** health pickups can go over 100.

### 6.2 Evolution table

Rank track = what ★1→★5 improve. Unless noted, each rank is roughly **+20% damage** (via the damage hook) plus the
listed extra.

| Gun | ★1–★5 track | Pair with | Evolved form | What the evolution does |
|---|---|---|---|---|
| **Knife** | +25% damage per rank; ★3: slash heals 1; ★5: 360° swing | **Vampiric Touch** | **Butcher of Thebes** | Every swing also sends a 6 m ring slash that hits all enemies for 150% damage. Knife kills heal 3 and **gib** guaranteed. "Cutting-edge archaeology." |
| **Schofield revolvers** | Damage; ★2: +1 ricochet; ★3: dual Schofields; ★4: crit 15% ×3; ★5: every 6th shot marks | **Fleet Foot** | **High Noon** | While moving, each shot fires **2 bonus homing bullets** at the nearest enemies. Every 6th shot is a **Dead-Eye**: a free shot at each of the 6 nearest enemies (bosses and elites first), with a clock-chime sound. |
| **Single shotgun** | +1 pellet per rank (7→12); ★3: pellets pierce 1; ★5: kills refund a shell | **Kevlar Vest** | **Pump-Action Pharaoh** | Pellets pierce 3. Each shot also blasts a short shock cone that knocks back and staggers. Every kill drops an armour shard. |
| **Double coach gun** | +2 pellets per rank; knockback; ★4: reload −25% (emulated, see 6.3) | **Bloodlust** (cooldown) | **Coach Gun of the Apocalypse** | Enemies killed by it **explode for 30% of their max HP** (chained gib showers). Each blast also fires a **120° shockwave** 8 m out. |
| **Tommy gun** | Damage; ★2: tighter spread; ★3: every 10th bullet incendiary; ★5: ammo regenerates 5/s | **Greed** | **Chicago Typewriter** | Every 5th bullet is a **gold round**: kills drop coins and bonus XP. Infinite bullets while the trigger is held. "Prohibition-era piñata." |
| **XM214 minigun** | Damage; ★2: spin-up −50%; ★3: ricochet 1; ★4: bullets refund on kill; ★5: ammo regen 15/s | **Regeneration** | **Lead Hurricane** | No spin-up. Bullets ricochet twice. While firing, an **8 m bullet-storm aura** shreds everything around Sam (auto-damage ring), and Sam regenerates 2 HP/s. |
| **Rocket launcher** | Damage; ★2: splash +30%; ★3: 2 rockets per shot (spread); ★5: 3 | **Big Boom** (area) | **Rocket Party** | Each rocket **splits into 4 mini-rockets** on impact that home on nearby enemies. Rocket jumps cost no health. |
| **Grenade launcher** | Damage; ★2: +1 bounce; ★3: 2 grenades; ★5: fire pool 3 s | **Duplicator** | **Bouncing Betty Bonanza** | Each grenade bursts into **6 bomblets** that bounce and explode, leaving a 4 s napalm puddle. |
| **XL2 laser** | Damage; ★2: +1 pierce; ★3: twin bolts; ★5: bolts bounce off walls | **Chain Lightning** (union) | **Sirian Storm Cannon** | Bolts **chain to 3 more enemies** (with Chain Lightning visuals). Hitting a Gnaar or Harpy chains for free. Uses no cells. |
| **SBC cannon** | Damage; ★2: charge faster; ★3: balls bounce; ★5: +1 ball per shot | **Serious Bomb** (union) | **Cannon of Mass Destruction** | **Every 3rd ball is a NukeBall** (resurrecting the cut code: 600–800 damage + 13 explosions) and leaves a crater that keeps burning. |
| *TSE* Chainsaw | Damage, reach | Vampiric Touch | **Sawmill of Sirius** | 3 spectral saws orbit Sam (VS King Bible). Lifesteal on contact. |
| *TSE* Flamethrower | Cone width, damage over time | Big Boom | **Napalm on the Nile** | Flames leave burning ground; burning enemies spread fire on death. |
| *TSE* Raptor sniper | Pierce, crit | Lucky Pyramid | **Eye of Horus** | Every shot pierces the whole line. Headshot crits trigger a 6 m holy explosion. |

### 6.3 How to build this without editing weapon code

The mod (`rust/se1-mod`, host API v2 in `port/common/se1mod.h`) can do these things today:
- Run shell commands: the cheat variables `cht_bGod`, `cht_bInvisible`, `cht_fTranslationMultiplier`, `cht_bGiveAll`,
  `cht_bRefresh`, `cht_bKillAll`.
- Spawn by class.
- Damage a handle.
- Heal the player.
- Read the player's position and health.

Evolutions need **five small host hooks**. Add them once in the engine or the base entities, never per weapon:

1. **`on_damage(victim, attacker_is_player, dmt, amount) → amount'`.** Call it from `CEnemyBase::ReceiveDamage`, or
   from the global `InflictDirectDamage` / `InflictRangeDamage`.
   - It gives per-weapon damage multipliers (gun ranks, a Serious Damage ×4 emulation), crit rolls, damage numbers
     and the per-weapon damage table.
   - **Attribution:** the damage type gives most of it.
     - `DMT_CLOSERANGE` = knife.
     - `DMT_BULLET` = revolver, shotguns, tommy gun or minigun; split them by the player's current weapon on that tick.
     - `DMT_PROJECTILE` / `DMT_EXPLOSION` = rocket, grenade or laser; split them by the projectile type of the inflictor.
     - `DMT_CANNONBALL` and `DMT_CANNONBALL_EXPLOSION` = cannon.
2. **`on_kill(victim_class, pos, dmt, weapon)`.** Used for kill-triggered effects (exploding corpses, gold rounds,
   shell refunds), XP gem drops and the kill counter.
3. **`player_view(pos, dir)` + `current_weapon()` + `ammo(type)`.**
   - **Shot detection:** poll ammo each frame; a decrease means a shot was fired. For the revolver (infinite ammo),
     poll the magazine counter or add a tiny `on_fire` hook in `PlayerWeapons` `Fire*` states.
   - **Extra projectiles:** `spawn_projectile(type, pos, dir, owner = player)`, using the TFE `Projectile` types
     `PRT_ROCKET`, `PRT_GRENADE` and `PRT_LASER_RAY` at the player's aim. Bonus bullets are cheapest as direct
     `damage(handle)` calls on the N nearest enemies, with a tracer effect.
4. **`give_ammo(type, n)`** for ammo regeneration and refunds. Send `EAmmoItem` to the player, or set the
   `m_iBullets`-style counters directly.
5. **`spawn_with(class, pos, props)`.** Monster variants such as Headman `m_hdtType = Kamikaze`, Scorpman General,
   big Walker and Eyeman purple. These are entity properties, so they must be set **before** `Initialize`.

Things that need care:
- **Fire rate** is hard-coded in the `autowait()` calls. Without touching weapon code, emulate "faster" with extra
  projectiles or damage. If one exception is allowed, add a single global `wpn_fFireRateMul` shell variable read by
  every `autowait` in `PlayerWeapons.es`. That is a one-time entity patch, not per weapon.
- **Session properties** (`gam_afDamageStrength`, `gam_bInfiniteAmmo`) are copied at session start, so they are
  **not live knobs**. They are fine for run-start difficulty presets, though.
- **Power-ups in TFE:**
  - Serious Damage: a 4× multiplier in `on_damage`.
  - Invulnerability: `cht_bGod = 1` with a timer (already used by the prototype's stress mode).
  - Serious Speed: `cht_fTranslationMultiplier = 2`, which must stack correctly with Fleet Foot.
  - Invisibility: `cht_bInvisible = 1`.
  - Serious Bomb: `damage()` on every handle within 30 m, plus a white flash on the overlay.

---

## 7. Serious twists: Serious Sam identity × survivors mechanics

Each idea has a rough implementation note.

1. **Kamikaze Stampede (signature swarm).** At set minutes, the scream starts **2 s before** they appear, from one
   compass direction. Then 20–40 Beheaded Kamikazes pour in as a wedge. They give 2,500 score each and drop a gem
   cluster. The scream is the telegraph, which is exactly what FP needs.
   *Impl:* `spawn_with(Headman, kamikaze)` along a line 35 m out, behind a HUD direction arrow. Play the kamikaze
   sound at the spawn point first.
2. **Werebull Run (VS bat-swarm analogue).** A line of 8–12 Werebulls *crosses* the arena at 25 m/s and despawns past
   the far edge. Dodge or jump; if you hit them you lose HP. *Impl:* spawn on one side, give them a far waypoint
   (marker) or despawn by distance. Announce with "A stampede charges through!"
3. **Kleer Rain.** Kleers drop from the sky in a ring at 8 m (they leap, after all). It is an encirclement you must
   blast out of, using Flower Wall timing. *Impl:* spawn in a ring with an upward offset; they fall and immediately
   `JumpOnEnemy`.
4. **Marsh Hopper Flood.** 150 Gizmos (9.5 HP each) in 20 s: a pure XP piñata, and the moment shotgun, minigun and
   evolved builds feel godlike. *Impl:* spawn cap override for 20 s; gem merging on.
5. **Arena Lockdown.** The classic TFE beat as a map event. "NETRICSA: Containment field engaged." A ring of fire (a
   damaging circle at 25 m) traps you for 60 s while waves pour in. Kill N to break it and win a silver chest.
   *Impl:* a damage-over-time zone outside the radius, a progress bar on the HUD, and fuss-score music jumping to heavy.
6. **Netricsa as announcer and codex.** Wave banners in Netricsa's dry voice ("Biological scan: 46 Kleer skeletons,
   bearing 270. Recommend: double-barrel."). First kill of each species unlocks a short codex entry. Killing N of a
   species gives a permanent +5% damage against it (VS bestiary meets Netricsa). *Impl:* the page overlay with the
   computer beep; codex in `localStorage`.
7. **Power-up Shrines.** Golden Sirian pedestals (Megabonk charge shrines). Stand inside the 4 m circle for 5 s while
   the horde converges, and receive Serious Damage (40 s, ×4), Invulnerability (30 s), Speed (20 s) or Invisibility
   (30 s), using the canonical durations. One shrine is up at a time and it relocates. *Impl:* a marker with a
   particle pillar; a timer while the player is in range; the effects from section 6.3.
8. **Score Attack and Time Bonus.** Show the TFE score live, top right, with a **combo multiplier** (kills within 1.5 s
   chain ×1…×8). At the end: TFE-style SCORE / KILLS / SECRETS / TIME / TIME BONUS, with the time bonus paid for
   killing bosses faster than par (100 points per second under par, same as `Player.es`). A local high-score table per
   stage and difficulty, and a **daily seed**.
9. **Serious difficulty ladder as the Curse.** Tourist, Easy, Normal, Hard, Serious, then **Mental**. Mental sets
   `sp_bMental` so enemies fade in and out. Each step multiplies HP, damage and density and pays ×gold and ×score
   (like Azeroth's Run Options). Unlock each by winning the one below.
10. **Pill rain and overheal.** Small kills drop **pills (+1, overheal up to 200)**. Elites drop small or medium
    health. Bosses drop **Super Health +100**. Gold armour shards come from the Kevlar line. Use Sam's actual pickups
    and sounds. *Impl:* spawn `HealthItem` entities, or emulate pickups mod-side with `player_heal`.
11. **Ammo crates as a resource.** Guns need ammo, which VS never had. Elites drop the ammo box for the gun you hold.
    "Armory" refills everything. The **Chicago Typewriter and Lead Hurricane evolutions *remove* the ammo constraint**,
    which turns into a felt power spike. Low-ammo warning on the HUD.
12. **Gun Crate roulette.** Boss chests spin Sam's weapon icons like a slot machine. Landing on a new gun plays its
    pickup sound and a Sam quip. A 5-item chest gets fireworks plus a "Heh heh heh". *Impl:* overlay animation, with
    the result decided first.
13. **Ugh-Zan as the Reaper.** At 20:00 the sky darkens and Ugh-Zan III descends (or, if the Devil can't be spawned
    outside its level, a giant Werebull or Biomech stand-in). Deal X damage in 60 s and he "retreats", which is
    victory, then the endless option. Beyond 25:00 he simply hunts you. *Impl:* test `spawn("Classes\\Devil.ecl")`
    on an arena map; it may need markers (`DevilMarker`). Use a stand-in until then.
14. **Secrets in the arena.** 3–5 hidden spots per stage (on rooftops, behind a sphinx) with a relic: Arcana-like rule
    changers, e.g. "Sirian Bracelet: pickups are drawn from twice as far." The end screen shows SECRETS x/5.
    Finding all of them is an achievement.
15. **Biomechanoid barrage.** An elite artillery unit that paints **red ground circles** 1.5 s before its rockets
    land. It turns the FP view up toward the sky, which is fun 3D gameplay VS can't have. *Impl:* spawn a big Walker
    as an elite (+HP tint); ground decals from the mod's overlay or particle markers.
16. **Explosive Orb → "Sirian Bomb Core".** A floating orb with a 10 s fuse that must be **shot** (aim check!) before
    it detonates and drops a Serious Bomb pickup. Taken straight from Azeroth's Explosive Orb.
17. **Serious Bomb as a charged ultimate.** Kills fill a meter; press the bomb key (TSE behaviour: flash, shake, 4 s
    lockout; hold up to 3). The bomb card upgrades the charge rate, not a cooldown.
18. **Character select = multiplayer skins.** Each skin has a starting gun and a bonus.
    - Sam: Schofields, +10% damage every 10 levels.
    - A "Red Rick"-style skin: double shotgun, +1 pellet.
    - A "Mighty Marvin"-style skin: +30% HP, slower.
    - A lighter variant: +15% speed, laser start.

    Unlock by feats ("Kill 1,000 Kleers", "Survive 15:00 with only the knife"). [mem: verify which player models the
    TFE data actually has.]
19. **Fuss-meter music.** Hook survivors spawns into `MusicHolder`'s fuss score (it already switches calm → medium →
    heavy at 100 / 1,000 score). Swarms and bosses then drive the soundtrack with no new code paths.
20. **Sam's quips as the fanfare layer.** Short one-liners on evolutions, 5-item chests, bosses killed and near-death
    saves. They are rate-limited (at most one per 20 s) so they stay funny.
21. **Gold cache = "Sirian Supply Pod".** In-arena boxes you buy with gold at a rising cost, Azeroth style. They give a
    passive or ammo choice. The interact key, not a click, so the mouse stays captured.
22. **Gnaar-eye companion.** The Azeroth companion perk: a tiny friendly Gnaar orbits you and fetches gems and coins
    25 m beyond your radius. In 3D it solves "the gems fell off the ledge". Meta-unlockable, upgraded by fetch range.

---

## 8. Prioritized feature list for a "finished" first-person mode

Legend: **FP+** translates well or even better in FP. **FP~** needs adaptation. **FP−** is awkward; adapt or skip.

### P0: a run that starts, escalates, climaxes and pays out

1. **Run timer + minute-table director + final boss + victory/endless** (sections 1.1, 1.8, 7.13). FP+. Replace the
   "cap +6 per minute" rule with a VS-style table: enemy mix, *minimum* count, interval, events, boss per minute.
   Suggested run: 20:00 with mini-bosses at 4:00, 8:00, 12:00 and 16:00, and a finale at 20:00.
2. **XP gems + 3D magnet + gem merging** (section 1.2). FP~. Cylindrical radius, gems fly to chest height with a pull
   sound; merge above ~150 gems. The Netricsa Scanner passive and Magnet pickup with a light pillar.
3. **Linear XP curve** (section 1.3). Pure numbers: `5 + 10(n−1)`, then +13 and +16; XP by monster tier.
4. **Ability VFX.**
   - Consecration: ground ring decal and particles.
   - Chain Lightning: the engine's `Lightning` entity, or beam particles between victims.
   - Arcane Explosion: an expanding shockwave sprite.
   - Multi-Shot: tracers.

   FP+. Without these, abilities feel like nothing happened.
5. **Hit feedback:** aggregated world-space damage numbers, white hit flash, keep gibs and knockback, kill counter.
   FP+, since the effects are right in your face.
6. **Gun ranks + passive slots + evolutions** (section 6). FP+. This is the replay engine. Needs the `on_damage`,
   `on_kill`, `player_view` and `give_ammo` hooks.
7. **Boss chests with roulette (1/3/5)** and the scripted 1-1-3-1-1-5 sequence for the first six. FP+ as an overlay.
8. **Level-up fanfare + card rarity + reroll / skip / banish.** FP~. **Don't release pointer lock.** Pick with 1–4 and
   the mouse wheel inside the game. Today's "click the game to grab the mouse again" is a real friction point in FP.
9. **Sam's health and armour drops + rare power-ups** (sections 5.3, 5.4, 7.7, 7.10). FP+. They are native assets and
   sounds.
10. **Results screen** with a per-weapon damage table plus TFE SCORE / KILLS / SECRETS / TIME BONUS, and a
    **pause screen with the build summary**. FP+.

### P1: replayability

11. **Gold + meta shop.** VS PowerUp list (section 2.1) reskinned: Might, Armor, Max Health, Recovery, Cooldown, Area,
    Duration, Amount, Move Speed, Magnet, Luck, Growth, Greed, **Curse**, Revival, Reroll, Skip, Banish. Uses VS's
    price formula. Persisted in `localStorage`. FP+.
12. **Characters** (Sam skins) with a starting gun and a scaling bonus. FP+.
13. **Unlock and achievement list** that *adds cards, guns, stages and characters to the pool*. "Survive X with Y",
    "kill N of Z", "evolve G". FP+.
14. **Elites:** ×5–10 HP, tinted or scaled, drop chests or ammo. **Mini-bosses** at minute marks. FP+.
15. **Wave events:** Kamikaze stampede, Werebull run, Kleer rain, Hopper flood, Arena Lockdown (section 7). FP~.
    They need **directional telegraphs** (HUD edge arrows, audio from the spawn side) because the threat may be behind you.
16. **Stages.** Open TFE spaces: Karnak's courtyard, Dunes/Oasis, Moon Mountains, the Great Pyramid plateau for the
    finale. Corridors cripple swarms (`notes/survivors.md` already notes this). Per-stage enemy tables. FP+.
17. **Difficulty ladder** Tourist → Mental with reward multipliers (sections 7.9, 2.3). FP+.

### P2: identity and polish

18. **Netricsa announcer and codex** (section 7.6). FP+.
19. **Shrines, gold caches and the Explosive Orb** (sections 7.7, 7.16, 7.21). FP+, because they turn aiming and
    positioning into decisions.
20. **Score attack, combo meter and daily seed** (section 7.8). FP+.
21. **Gnaar companion** (section 7.22). FP+.
22. **Co-op Survivors** (already in the overnight plan). FP+. Azeroth shows how: the host runs the director, and a
    player who doesn't pick in time gets a card auto-picked.

### What translates and what doesn't

| VS assumption | In first person |
|---|---|
| You see 360° around you | **No.** Spawn mostly outside the view frustum but > 20 m away, give each spawn wave an audio source, add a damage-direction indicator and a "threat ring" HUD. Lower contact damage, or give melee units visible wind-ups. Azeroth's triggered defensives (heal below 85%, immunity below 35%) and cheat-death save you from unseen hits. |
| Weapons auto-aim | Sam's guns stay **player-aimed**. That is the skill expression and the FPS identity, and 20MTD and Vampire Hunters prove it works. **Abilities auto-target** (bosses and elites first, then the most wounded, Azeroth-style), so the survivors fantasy stays. Optional aim assist for the revolver. |
| Pickups on a flat plane | Use a cylindrical magnet with vertical tolerance, gems that glow and bob, a companion fetcher, and the magnet pillar. |
| Screen-filling hordes | The engine entity count is the budget. Measure where frame time breaks (the `tools/stress.mjs` harness exists), likely ~120–200 monsters. Use **minimum-count refills plus fewer, beefier enemies**, gem merging and fast-dying swarms (Gizmos and Kamikazes die in one hit). |
| Screen-clear effects | They read even better in FP: Serious Bomb flash, Rosary-style "wipe". |
| Top-down readability of AoE | Use ground decals for auras and incoming rockets, and keep the camera a bit higher. Tall pillars for objectives. |
| Pausing on level-up | Fine, but keep pointer lock and use number keys. A 0.3 s slow-mo before the pause stops it feeling like a jump cut. |

---

## 9. Suggested starting numbers for Serious Survivors (20-minute run)

| Minute | Mix (spawn weights) | Minimum on field | Interval | Event / boss |
|---|---|---|---|---|
| 0–1 | Firecracker, Gizmo | 12 | 1.0 s | – |
| 1–2 | Firecracker, Rocketeer, Gizmo | 20 | 0.8 s | – |
| 2 | Kleer joins | 25 | 0.6 s | Marsh Hopper Flood (20 s) |
| 3 | Kleer, Gnaar | 30 | 0.6 s | – |
| 4 | Gnaar, Kleer, Bomber | 25 | 0.6 s | **Werebull mini-boss → bronze chest** (scripted 1 item) |
| 5 | calm: Kleer | 15 | 1.0 s | Power-up shrine appears |
| 6 | Kamikaze joins | 40 | 0.4 s | **Kamikaze Stampede** |
| 7 | Arachnoid soldiers (elite) | 40 | 0.4 s | – |
| 8 | Harpy, Gnaar purple | 45 | 0.4 s | **Biomech big → bronze (3-item)** |
| 9 | Werebull, Kleer | 50 | 0.3 s | Werebull Run |
| 10 | Reptiloid | 55 | 0.3 s | **Arena Lockdown 60 s → silver (evolution)** |
| 11–12 | Kleer horde | 70 | 0.25 s | Kleer Rain; **Arachnoid General → silver** |
| 13–14 | mixed | 80 | 0.2 s | Kamikaze Stampede ×2 |
| 15 | Biomech small, Harpy | 80 | 0.2 s | Explosive Orb |
| 16 | everything | 90 | 0.2 s | **Twin Werebull + Biomech → gold (5-item)** |
| 17–19 | everything, elites ×2 | 100 | 0.15 s | Arena Lockdown, Hopper Flood |
| 20 | – | – | – | **Ugh-Zan (or stand-in): victory → endless** |

- XP per kill: Gizmo 1, Firecracker 1, Rocketeer 1, Bomber 2, Kamikaze 3, Kleer 4, Gnaar 3/5, Harpy 5,
  Werebull 10, Reptiloid 8/20, Arachnoid 15/40/80, Biomech 15/60, mini-boss 100.
- Gems: blue ≤ 2, green ≤ 9, red ≥ 10. Merge above 150.
- Magnet: 3 m base, +25% per rank.
- Gold: 1 coin per ~25 kills, 100–1,000 per chest.
- Health drops: pill 3%, small health 1%, medium from elites, super from bosses.
- Power-up drop from elites: 5% (canonical durations).
- Slots: 6 guns (Sam's), 4 abilities, 6 passives, all max ★5. 3 cards, 4th by Luck. 1 reroll per run base.
- Evolution: gun ★5 + passive + silver chest (≥10:00).

---

## Sources

**Azeroth Survivors**
- Game page and client: https://wow.aethus.pl. Text extracted from `wenilla_bg.wasm` (English locale table, about
  3,600 lines), plus `rogue.js`, `boot.js` and the `data/__index` listing.
- PC Games (DE): https://www.pcgames.de/World-of-Warcraft-Spiel-42971/News/Azeroth-Survivors-Browsergame-1557804/
- AxeeTech tier list (v0.120.5): https://axeetech.com/azeroth-survivors-tier-list/
- BuffBuff tier list: https://buffbuff.com/blog/azeroth-survivors-tier-list

**Vampire Survivors wiki**
- PowerUps: https://vampire.survivors.wiki/w/PowerUps
- Treasure Chest: https://vampire.survivors.wiki/w/Treasure_Chest
- Level up: https://vampire.survivors.wiki/w/Level_up
- The Reaper: https://vampire.survivors.wiki/w/The_Reaper
- Experience Gem: https://vampire.survivors.wiki/w/Experience_Gem
- Mad Forest: https://vampire.survivors.wiki/w/Mad_Forest
- Evolution: https://vampire.survivors.wiki/w/Evolution
- Arcana: https://vampire.survivors.wiki/w/Arcana
- Stats: https://vampire.survivors.wiki/w/Stats
- Floor Chicken: https://vampire.survivors.wiki/w/Floor_Chicken
- Unlocks: https://vampire.survivors.wiki/w/Unlocks
- Characters: https://vampire.survivors.wiki/w/Characters

**Other games**
- Brotato wiki, Waves: https://brotato.wiki.spellsandguns.com/Waves
- Brotato wiki, Shop: https://brotato.wiki.spellsandguns.com/Shop
- DRG: Survivor overclocks: https://deeprockgalactic.wiki.gg/wiki/Survivor:Overclocks
- DRG: Survivor salvage and extraction: https://www.gamepressure.com/newsroom/deep-rock-galactic-drg-survivor-salvage-explained/zd6968
- Halls of Torment (developer page): https://www.chasing-carrots.com/?p=3891
- Halls of Torment (Steam): https://store.steampowered.com/app/2218750/Halls_of_Torment/
- 20 Minutes Till Dawn synergies: https://20-minutes-till-dawn.fandom.com/wiki/Synergies
- 20 Minutes Till Dawn tier list: https://invenglobal.com/articles/17637/20-minutes-till-dawn-tier-list-best-characters-weapons-runes-and-skills
- Megabonk review: https://pcgamer.com/games/roguelike/megabonk-review
- Megabonk Chaos Tome and shrines: https://www.gamepressure.com/newsroom/tips-on-how-to-get-chaos-tome-in-megabonk-charging-all-the-shrine/zd8795
- Vampire Hunters (first-person survivors-like): https://gamingonlinux.com/2024/11/vampire-hunters-turns-vampire-survivors-into-an-fps-where-you-stack-14-weapons-together

**Serious Sam source in this repo**
- `src/SamTFE/Sources/Entities/{PlayerWeapons,Projectile,CannonBall,HealthItem,ArmorItem,Player,MusicHolder,Headman,Boneman,Eyeman,Scorpman,Werebull,Gizmo,Dragonman,Walker,Woman,Fish,Devil}.es`
- `src/SamTFE/Sources/EntitiesMP/{PowerUpItem,Player,PlayerWeapons}.es` and `EntitiesMP/Common/Common.cpp` (`GetSeriousDamageMultiplier`)
- `port/SamTFE/sources.cmake` (TFE uses `Entities`, so it has no power-ups)
- `port/common/se1mod.h` (mod host API v2)
