//! Serious Survivors tables: monsters, the 20-minute run timeline, upgrades and evolutions.
//! Numbers follow notes/survivors-research.md (sections 6 and 9), tuned for first person.

/// A monster type the director can spawn. `model` is checked with `file_exists` first: the demo
/// data lacks some classes, and spawning one without its model is fatal in this engine.
#[derive(Clone, Copy)]
pub struct Kind {
    pub name: &'static str,
    pub class: &'static str,
    pub model: &'static str,
    pub variant: i32,
    pub xp: f32,
    pub score: u32,
}

pub const HEADMAN: &str = "Models\\Enemies\\Headman\\Headman.mdl";
pub const K_FIRE: usize = 0;
pub const K_ROCKET: usize = 1;
pub const K_BOMBER: usize = 2;
pub const K_KAMI: usize = 3;
pub const K_KLEER: usize = 4;
pub const K_GNAAR: usize = 5;
pub const K_GNAAR2: usize = 6;
pub const K_HARPY: usize = 7;
pub const K_BULL: usize = 8;
pub const K_BIOS: usize = 9;
pub const K_BIOB: usize = 10;
pub const K_ARACH: usize = 11;
pub const K_ARACHG: usize = 12;
pub const K_HOPPER: usize = 13;
pub const K_REPT: usize = 14;
pub const K_REPTB: usize = 15;
pub const K_GOLEM: usize = 16;
pub const K_GOLEMB: usize = 17;

pub const KINDS: &[Kind] = &[
    Kind { name: "Beheaded Firecracker", class: "Classes\\Headman.ecl", model: HEADMAN, variant: 0, xp: 1.0, score: 200 },
    Kind { name: "Beheaded Rocketeer", class: "Classes\\Headman.ecl", model: HEADMAN, variant: 1, xp: 1.0, score: 100 },
    Kind { name: "Beheaded Bomber", class: "Classes\\Headman.ecl", model: HEADMAN, variant: 2, xp: 2.0, score: 500 },
    Kind { name: "Beheaded Kamikaze", class: "Classes\\Headman.ecl", model: HEADMAN, variant: 3, xp: 3.0, score: 2500 },
    Kind { name: "Kleer Skeleton", class: "Classes\\Boneman.ecl", model: "Models\\Enemies\\Boneman\\Boneman.mdl", variant: -1, xp: 4.0, score: 1000 },
    Kind { name: "Gnaar", class: "Classes\\Eyeman.ecl", model: "Models\\Enemies\\Eyeman\\Eyeman.mdl", variant: 0, xp: 3.0, score: 500 },
    Kind { name: "Gnaar Sergeant", class: "Classes\\Eyeman.ecl", model: "Models\\Enemies\\Eyeman\\Eyeman.mdl", variant: 1, xp: 5.0, score: 1000 },
    Kind { name: "Scythian Harpy", class: "Classes\\Woman.ecl", model: "Models\\Enemies\\Woman\\Woman.mdl", variant: -1, xp: 5.0, score: 1000 },
    Kind { name: "Sirian Werebull", class: "Classes\\Werebull.ecl", model: "Models\\Enemies\\Werebull\\Werebull.mdl", variant: -1, xp: 10.0, score: 2000 },
    Kind { name: "Biomechanoid", class: "Classes\\Walker.ecl", model: "Models\\Enemies\\Walker\\Walker.mdl", variant: 0, xp: 15.0, score: 2000 },
    Kind { name: "Major Biomechanoid", class: "Classes\\Walker.ecl", model: "Models\\Enemies\\Walker\\Walker.mdl", variant: 1, xp: 60.0, score: 7500 },
    Kind { name: "Arachnoid", class: "Classes\\Scorpman.ecl", model: "Models\\Enemies\\Scorpman\\Scorpman.mdl", variant: 0, xp: 15.0, score: 1000 },
    Kind { name: "Arachnoid General", class: "Classes\\Scorpman.ecl", model: "Models\\Enemies\\Scorpman\\Scorpman.mdl", variant: 1, xp: 40.0, score: 5000 },
    Kind { name: "Marsh Hopper", class: "Classes\\Gizmo.ecl", model: "Models\\Enemies\\Gizmo\\Gizmo.mdl", variant: -1, xp: 1.0, score: 500 },
    Kind { name: "Reptiloid", class: "Classes\\Beast.ecl", model: "Models\\Enemies\\Beast\\Beast.mdl", variant: 0, xp: 8.0, score: 5000 },
    Kind { name: "Reptiloid Highlander", class: "Classes\\Beast.ecl", model: "Models\\Enemies\\Beast\\Beast.mdl", variant: 1, xp: 20.0, score: 25000 },
    Kind { name: "Lava Golem", class: "Classes\\Elemental.ecl", model: "Models\\Enemies\\ElementalLava\\ElementalLava.mdl", variant: 0, xp: 10.0, score: 5000 },
    Kind { name: "Big Lava Golem", class: "Classes\\Elemental.ecl", model: "Models\\Enemies\\ElementalLava\\ElementalLava.mdl", variant: 1, xp: 40.0, score: 20000 },
];
/// Whether a kind attacks from range (projectiles) vs. melee.
pub fn ranged(kind: usize) -> bool {
    !matches!(KINDS[kind].name,
        "Beheaded Kamikaze" | "Gnaar" | "Gnaar Sergeant" | "Sirian Werebull"
        | "Marsh Hopper" | "Lava Golem" | "Big Lava Golem")
}
/// Stand-ins when a kind's data is missing (demo data): same role, available class.
pub fn fallback(k: usize) -> usize {
    match k {
        K_HOPPER => K_FIRE,
        K_REPT => K_KLEER,
        K_REPTB => K_ARACHG,
        K_GOLEM => K_BULL,
        K_GOLEMB => K_BIOB,
        _ => k,
    }
}

/// One stretch of the run: spawn mix (kind, weight), monsters kept on the field, spawn interval.
pub struct Phase {
    pub from_s: f64,
    pub mix: &'static [(usize, u32)],
    pub min_field: usize,
    pub interval: f64,
}
pub const RUN_S: f64 = 20.0 * 60.0;
pub const PHASES: &[Phase] = &[
    Phase { from_s: 0.0, mix: &[(K_FIRE, 6), (K_HOPPER, 3)], min_field: 7, interval: 1.6 },
    Phase { from_s: 60.0, mix: &[(K_FIRE, 5), (K_ROCKET, 3), (K_HOPPER, 3)], min_field: 13, interval: 1.0 },
    Phase { from_s: 120.0, mix: &[(K_FIRE, 4), (K_ROCKET, 2), (K_KLEER, 3)], min_field: 18, interval: 0.8 },
    Phase { from_s: 180.0, mix: &[(K_KLEER, 4), (K_GNAAR, 4), (K_ROCKET, 2)], min_field: 26, interval: 0.6 },
    Phase { from_s: 240.0, mix: &[(K_GNAAR, 4), (K_KLEER, 3), (K_BOMBER, 3)], min_field: 24, interval: 0.6 },
    Phase { from_s: 300.0, mix: &[(K_KLEER, 5), (K_HARPY, 2)], min_field: 18, interval: 0.9 },
    Phase { from_s: 360.0, mix: &[(K_KAMI, 3), (K_KLEER, 3), (K_GNAAR, 3), (K_REPT, 1)], min_field: 34, interval: 0.45 },
    Phase { from_s: 420.0, mix: &[(K_ARACH, 2), (K_KLEER, 4), (K_HARPY, 3), (K_BOMBER, 2)], min_field: 36, interval: 0.45 },
    Phase { from_s: 480.0, mix: &[(K_HARPY, 4), (K_GNAAR2, 3), (K_KLEER, 3), (K_REPT, 2)], min_field: 40, interval: 0.4 },
    Phase { from_s: 540.0, mix: &[(K_BULL, 2), (K_KLEER, 5), (K_GOLEM, 1), (K_KAMI, 2)], min_field: 44, interval: 0.35 },
    Phase { from_s: 600.0, mix: &[(K_REPT, 3), (K_KLEER, 4), (K_GNAAR2, 3), (K_BIOS, 1)], min_field: 48, interval: 0.32 },
    Phase { from_s: 660.0, mix: &[(K_KLEER, 7), (K_HARPY, 2), (K_ARACH, 1)], min_field: 58, interval: 0.28 },
    Phase { from_s: 780.0, mix: &[(K_KAMI, 4), (K_KLEER, 3), (K_BULL, 1), (K_REPT, 2), (K_BIOS, 1)], min_field: 64, interval: 0.25 },
    Phase { from_s: 900.0, mix: &[(K_BIOS, 2), (K_HARPY, 3), (K_KLEER, 3), (K_GOLEM, 1), (K_ARACH, 1)], min_field: 68, interval: 0.22 },
    Phase { from_s: 960.0, mix: &[(K_KLEER, 3), (K_HARPY, 2), (K_BULL, 2), (K_REPT, 2), (K_ARACH, 1), (K_BIOS, 1), (K_KAMI, 2)], min_field: 74, interval: 0.2 },
    Phase { from_s: 1020.0, mix: &[(K_KLEER, 3), (K_HARPY, 2), (K_BULL, 2), (K_REPTB, 1), (K_ARACH, 2), (K_BIOS, 2), (K_KAMI, 2), (K_GOLEM, 1)], min_field: 80, interval: 0.18 },
];

/// Scripted run events (second, event).
#[derive(Clone, Copy, PartialEq)]
pub enum Event {
    Flood,           // Marsh Hopper flood (Firecrackers in the demo): an XP piñata
    MiniBoss(u8),    // 0..: see MINI_BOSSES
    Relic,           // a power-up relic drops somewhere near
    Stampede,        // Beheaded Kamikaze stampede from one direction
    BullRun,         // a line of Werebulls charges in
    KleerRain,       // Kleers drop in a ring around the player
    Final,           // the final boss
}
pub const EVENTS: &[(f64, Event)] = &[
    (120.0, Event::Flood),
    (240.0, Event::MiniBoss(0)),
    (300.0, Event::Relic),
    (360.0, Event::Stampede),
    (480.0, Event::MiniBoss(1)),
    (540.0, Event::BullRun),
    (600.0, Event::MiniBoss(2)),
    (660.0, Event::Relic),
    (690.0, Event::KleerRain),
    (720.0, Event::MiniBoss(3)),
    (780.0, Event::Stampede),
    (840.0, Event::Stampede),
    (900.0, Event::Relic),
    (930.0, Event::KleerRain),
    (960.0, Event::MiniBoss(4)),
    (1050.0, Event::Flood),
    (1110.0, Event::BullRun),
    (RUN_S, Event::Final),
];
/// Mini-bosses: (kinds, hp multiplier, size, chest items).
pub const MINI_BOSSES: &[(&[usize], f32, f32, u32)] = &[
    (&[K_BULL], 8.0, 1.6, 1),
    (&[K_BIOB], 2.5, 1.0, 3),
    (&[K_ARACHG], 3.0, 1.3, 1),
    (&[K_BULL, K_BULL], 6.0, 1.5, 3),
    (&[K_BIOB, K_ARACHG, K_GOLEMB], 3.0, 1.2, 5),
];

/// Upgrades: Sam's guns, auto-cast abilities (WoW-flavoured), passives. Evolutions come from chests.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Up {
    // guns
    Knife, Revolver, Shotgun, DoubleShotgun, TommyGun, Minigun, RocketLauncher, Laser, Cannon,
    // abilities
    Consecration, ChainLightning, Missiles, ArcaneExplosion, RainOfFire, SeriousBomb,
    // passives
    FleetFoot, VampiricTouch, Regeneration, Bloodlust, Greed, Kevlar, BigBoom, Scanner, Lucky, Overheal,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Cat {
    Gun,
    Ability,
    Passive,
}
pub const ALL: &[Up] = &[
    Up::Knife, Up::Revolver, Up::Shotgun, Up::DoubleShotgun, Up::TommyGun, Up::Minigun, Up::RocketLauncher, Up::Laser, Up::Cannon,
    Up::Consecration, Up::ChainLightning, Up::Missiles, Up::ArcaneExplosion, Up::RainOfFire, Up::SeriousBomb,
    Up::FleetFoot, Up::VampiricTouch, Up::Regeneration, Up::Bloodlust, Up::Greed, Up::Kevlar, Up::BigBoom, Up::Scanner, Up::Lucky, Up::Overheal,
];
pub const MAX_RANK: u32 = 5;
pub const ABILITY_SLOTS: usize = 4;
pub const PASSIVE_SLOTS: usize = 5;

impl Up {
    pub fn cat(self) -> Cat {
        use Up::*;
        match self {
            Knife | Revolver | Shotgun | DoubleShotgun | TommyGun | Minigun | RocketLauncher | Laser | Cannon => Cat::Gun,
            Consecration | ChainLightning | Missiles | ArcaneExplosion | RainOfFire | SeriousBomb => Cat::Ability,
            _ => Cat::Passive,
        }
    }
    pub fn id(self) -> &'static str {
        use Up::*;
        match self {
            Knife => "knife", Revolver => "revolver", Shotgun => "shotgun", DoubleShotgun => "dshotgun", TommyGun => "tommygun",
            Minigun => "minigun", RocketLauncher => "rocket", Laser => "laser", Cannon => "cannon",
            Consecration => "consecration", ChainLightning => "chain", Missiles => "missiles", ArcaneExplosion => "arcane",
            RainOfFire => "rain", SeriousBomb => "bomb",
            FleetFoot => "fleet", VampiricTouch => "vampiric", Regeneration => "regen", Bloodlust => "bloodlust", Greed => "greed",
            Kevlar => "kevlar", BigBoom => "bigboom", Scanner => "scanner", Lucky => "lucky", Overheal => "overheal",
        }
    }
    pub fn name(self) -> &'static str {
        use Up::*;
        match self {
            Knife => "Knife", Revolver => "Schofield Revolver", Shotgun => "Pump Shotgun", DoubleShotgun => "Double Coach Gun",
            TommyGun => "Tommy Gun", Minigun => "XM214 Minigun", RocketLauncher => "Rocket Launcher", Laser => "XL2 Laser",
            Cannon => "SBC Cannon",
            Consecration => "Consecration", ChainLightning => "Chain Lightning", Missiles => "Sirian Missiles",
            ArcaneExplosion => "Arcane Explosion", RainOfFire => "Rain of Fire", SeriousBomb => "Serious Bomb",
            FleetFoot => "Fleet Foot", VampiricTouch => "Vampiric Touch", Regeneration => "Regeneration", Bloodlust => "Bloodlust",
            Greed => "Greed", Kevlar => "Kevlar Vest", BigBoom => "Big Boom", Scanner => "Netricsa Scanner",
            Lucky => "Lucky Pyramid", Overheal => "Overheal",
        }
    }
    /// What the given rank (1-based) does.
    pub fn describe(self, r: u32) -> String {
        use Up::*;
        let rf = r as f32;
        let gun = |extra: &str| format!("+{:.0}% damage{}", 20.0 * (rf - 1.0), extra);
        match self {
            Knife => if r == 1 { "Cutting-edge archaeology".into() } else { format!("+{:.0}% damage; kills heal {}", 25.0 * (rf - 1.0), r / 2) },
            Revolver => if r == 1 { "Sam's trusty sidearms, one in each hand".into() } else { gun(&format!(", {:.0}% crit chance", 5.0 * rf)) },
            Shotgun | DoubleShotgun => if r == 1 { "New gun, with shells".into() } else { gun(&format!(", shells regenerate {:.1}/s", 0.4 * (rf - 1.0))) },
            TommyGun | Minigun => if r == 1 { "New gun, with bullets".into() } else { gun(&format!(", bullets regenerate {:.0}/s", 3.0 * (rf - 1.0))) },
            RocketLauncher => if r == 1 { "New gun, with rockets".into() } else { gun(&format!(", rockets regenerate {:.2}/s{}", 0.15 * (rf - 1.0), if r >= 3 { ", twin rockets" } else { "" })) },
            Laser => if r == 1 { "New gun, with cells".into() } else { gun(&format!(", cells regenerate {:.0}/s", 1.5 * (rf - 1.0))) },
            Cannon => if r == 1 { "New gun, with cannonballs".into() } else { gun(&format!(", cannonballs regenerate {:.2}/s", 0.06 * (rf - 1.0))) },
            Consecration => format!("Holy ground: {:.0} damage/s to foes within {:.1} m", 10.0 + 8.0 * rf, 4.0 + 1.2 * rf),
            ChainLightning => format!("Every {:.1} s a bolt hits for {:.0} and jumps {} times (elites first)", (2.4 - 0.2 * rf).max(1.0), 25.0 + 15.0 * rf, 2 + r),
            Missiles => format!("Every 1.4 s, {} bolts strike the nearest foes for {:.0}", 1 + r, 16.0 + 8.0 * rf),
            ArcaneExplosion => format!("Every {:.1} s blast everything within {:.0} m for {:.0}", (6.0 - 0.6 * rf).max(2.5), 7.0 + rf, 40.0 + 20.0 * rf),
            RainOfFire => format!("Every {:.1} s {} fireballs crash into the thickest crowd for {:.0}", (5.0 - 0.4 * rf).max(2.5), 2 + r, 50.0 + 20.0 * rf),
            SeriousBomb => format!("Every {:.0} s wipe out every foe within 30 m", (55.0 - 6.0 * rf).max(25.0)),
            FleetFoot => format!("Move {:.0}% faster", 10.0 * rf),
            VampiricTouch => format!("Heal {:.1} per kill", 0.4 * rf),
            Regeneration => format!("Regenerate {:.1} health/s", 0.5 * rf),
            Bloodlust => format!("Abilities recharge {:.0}% faster", 8.0 * rf),
            Greed => format!("+{:.0}% XP and gold", 15.0 * rf),
            Kevlar => format!("Armor regenerates {:.1}/s up to {:.0}", 0.6 * rf, 50.0 + 25.0 * rf),
            BigBoom => format!("Abilities hit {:.0}% wider", 12.0 * rf),
            Scanner => format!("Pick up XP from {:.0}% farther", 30.0 * rf),
            Lucky => format!("+{:.0}% luck: crits, drops, a 4th card", 10.0 * rf),
            Overheal => format!("Healing goes up to {:.0} health", 100.0 + 20.0 * rf),
        }
    }
    /// Gun ↔ engine: WeaponType values (Entities/PlayerWeapons.h) and the item type that gives it.
    pub fn weapon_types(self) -> &'static [i32] {
        use Up::*;
        match self {
            Knife => &[1], Revolver => &[2, 3], Shotgun => &[4], DoubleShotgun => &[5], TommyGun => &[6], Minigun => &[7],
            RocketLauncher => &[8], Laser => &[14], Cannon => &[16], _ => &[],
        }
    }
    pub fn weapon_item(self) -> i32 {
        use Up::*;
        match self {
            Revolver => 1, Shotgun => 2, DoubleShotgun => 3, TommyGun => 4, Minigun => 5, RocketLauncher => 6, Laser => 10, Cannon => 12,
            _ => 0,
        }
    }
    /// Ammo slot (bullets, shells, rockets, grenades, cells, ironballs) and AmmoItemType.
    pub fn ammo(self) -> Option<(usize, i32)> {
        use Up::*;
        match self {
            TommyGun | Minigun => Some((0, 2)),
            Shotgun | DoubleShotgun => Some((1, 1)),
            RocketLauncher => Some((2, 3)),
            Laser => Some((4, 5)),
            Cannon => Some((5, 7)),
            _ => None,
        }
    }
    pub fn from_weapon(wt: i32) -> Option<Up> {
        ALL.iter().copied().find(|u| u.weapon_types().contains(&wt))
    }
}

/// Evolutions: gun at max rank + paired upgrade owned + a boss chest after 10:00.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Evo {
    Butcher, HighNoon, Pharaoh, Apocalypse, Typewriter, Hurricane, RocketParty, StormCannon, MassDestruction,
}
pub const EVOS: &[(Evo, Up, Up)] = &[
    (Evo::Butcher, Up::Knife, Up::VampiricTouch),
    (Evo::HighNoon, Up::Revolver, Up::FleetFoot),
    (Evo::Pharaoh, Up::Shotgun, Up::Kevlar),
    (Evo::Apocalypse, Up::DoubleShotgun, Up::Bloodlust),
    (Evo::Typewriter, Up::TommyGun, Up::Greed),
    (Evo::Hurricane, Up::Minigun, Up::Regeneration),
    (Evo::RocketParty, Up::RocketLauncher, Up::BigBoom),
    (Evo::StormCannon, Up::Laser, Up::ChainLightning),
    (Evo::MassDestruction, Up::Cannon, Up::SeriousBomb),
];
impl Evo {
    pub fn name(self) -> &'static str {
        match self {
            Evo::Butcher => "Butcher of Thebes",
            Evo::HighNoon => "High Noon",
            Evo::Pharaoh => "Pump-Action Pharaoh",
            Evo::Apocalypse => "Coach Gun of the Apocalypse",
            Evo::Typewriter => "Chicago Typewriter",
            Evo::Hurricane => "Lead Hurricane",
            Evo::RocketParty => "Rocket Party",
            Evo::StormCannon => "Sirian Storm Cannon",
            Evo::MassDestruction => "Cannon of Mass Destruction",
        }
    }
    pub fn describe(self) -> &'static str {
        match self {
            Evo::Butcher => "Knife kills heal 3 and every slash rips a 6 m ring through the crowd",
            Evo::HighNoon => "Every 6th revolver hit: Dead-Eye on the 6 nearest foes, triple damage",
            Evo::Pharaoh => "Shotgun kills burst into a 4 m blast and drop armor",
            Evo::Apocalypse => "Coach-gun kills explode for 30% of their max health",
            Evo::Typewriter => "Bottomless bullets; every 5th kill drops a gold round (triple XP)",
            Evo::Hurricane => "Bottomless bullets; firing whips an 8 m bullet storm around you, +2 health/s",
            Evo::RocketParty => "Every rocket brings 4 homing friends to the nearest crowd",
            Evo::StormCannon => "Laser hits chain lightning to 3 more foes; cells never run out",
            Evo::MassDestruction => "Every 3rd cannonball is a NukeBall: a 12 m firestorm",
        }
    }
}

/// Characters (Sam's multiplayer skins): starting kit. Unlocks live on the page.
pub struct Character {
    pub name: &'static str,
    pub start: &'static [(Up, u32)],
    pub damage: f32,
    pub speed: f32,
}
pub const CHARACTERS: &[Character] = &[
    Character { name: "Serious Sam", start: &[(Up::Knife, 1), (Up::Revolver, 1)], damage: 1.1, speed: 1.0 },
    Character { name: "Red Rick", start: &[(Up::Knife, 1), (Up::Revolver, 1), (Up::DoubleShotgun, 1), (Up::Kevlar, 1)], damage: 1.0, speed: 1.0 },
    Character { name: "Mighty Marvin", start: &[(Up::Knife, 1), (Up::Revolver, 1), (Up::Overheal, 2), (Up::Regeneration, 1)], damage: 1.0, speed: 0.92 },
    Character { name: "Lucky Larry", start: &[(Up::Knife, 1), (Up::Revolver, 1), (Up::TommyGun, 1), (Up::Lucky, 2)], damage: 1.0, speed: 1.05 },
    Character { name: "Sirian Sam", start: &[(Up::Knife, 1), (Up::Revolver, 1), (Up::Laser, 1), (Up::ChainLightning, 1)], damage: 1.0, speed: 1.0 },
];

/// Difficulty: (name, enemy health, density, rewards).
pub const DIFFICULTIES: &[(&str, f32, f32, f32)] = &[
    ("Tourist", 0.6, 0.7, 0.5),
    ("Normal", 1.0, 1.0, 1.0),
    ("Serious", 1.5, 1.25, 1.6),
    ("Mental", 2.2, 1.5, 2.5),
];

/// XP needed for the next level (Vampire Survivors-like linear steps).
pub fn xp_for_level(level: u32) -> f32 {
    let l = level as f32;
    if level < 20 {
        5.0 + 10.0 * (l - 1.0)
    } else if level < 40 {
        195.0 + 13.0 * (l - 20.0)
    } else {
        455.0 + 16.0 * (l - 40.0)
    }
}

/// Seconds between auto-fire shots for a revolver at the given rank.
pub fn autofire_interval(rank: u32) -> f64 {
    (0.45 - 0.04 * (rank.saturating_sub(1)) as f64).max(0.20)
}

// Engine effect types (Entities/BasicEffects.es)
pub const BET_ROCKET: i32 = 1;
pub const BET_SHOCKWAVE: i32 = 6;
pub const BET_CANNON: i32 = 13;
pub const BET_CANNONSHOCKWAVE: i32 = 16;
pub const BET_TELEPORT: i32 = 17;
pub const BET_BOMB: i32 = 18;
// Projectiles (Entities/Projectile.es)
pub const PRT_ROCKET: i32 = 0;
// Items
pub const ARMOR_ITEM: &str = "Classes\\ArmorItem.ecl";
pub const HEALTH_ITEM: &str = "Classes\\HealthItem.ecl";
pub const AMMO_ITEM: &str = "Classes\\AmmoItem.ecl";
pub const ARIT_SHARD: i32 = 0;
pub const ARIT_MEDIUM: i32 = 2;
pub const HIT_PILL: i32 = 0;
pub const HIT_SMALL: i32 = 1;
pub const HIT_MEDIUM: i32 = 2;
pub const HIT_SUPER: i32 = 4;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_table() {
        assert_eq!(KINDS.len(), 18, "expected 18 monster kinds");
        assert_eq!(K_GOLEMB, KINDS.len() - 1, "K_GOLEMB must index the last kind");
        for k in KINDS {
            assert!(!k.name.is_empty(), "kind has empty name");
            assert!(k.class.ends_with(".ecl"), "{} has non-.ecl class {}", k.name, k.class);
            assert!(k.model.ends_with(".mdl"), "{} has non-.mdl model {}", k.name, k.model);
            assert!(k.xp > 0.0, "{} has no xp", k.name);
            assert!(k.score > 0, "{} has no score", k.name);
        }
        for i in 0..KINDS.len() {
            for j in (i + 1)..KINDS.len() {
                assert_ne!(KINDS[i].name, KINDS[j].name, "duplicate kind name {}", KINDS[i].name);
            }
        }
    }

    #[test]
    fn fallbacks_use_demo_classes() {
        const DEMO: [&str; 7] = [
            "Classes\\Headman.ecl",
            "Classes\\Boneman.ecl",
            "Classes\\Eyeman.ecl",
            "Classes\\Woman.ecl",
            "Classes\\Werebull.ecl",
            "Classes\\Walker.ecl",
            "Classes\\Scorpman.ecl",
        ];
        for k in 0..KINDS.len() {
            let f = fallback(k);
            assert!(f < KINDS.len(), "fallback({k}) = {f} out of range");
            assert!(
                DEMO.contains(&KINDS[f].class),
                "kind {} falls back to non-demo class {}",
                KINDS[k].name,
                KINDS[f].class
            );
        }
        assert_eq!(fallback(K_HOPPER), K_FIRE, "Hopper must fall back to Fire");
        assert_eq!(fallback(K_KLEER), K_KLEER, "Kleer must fall back to itself");
    }

    #[test]
    fn phases_ordered_and_valid() {
        assert!((PHASES[0].from_s - 0.0).abs() < f64::EPSILON, "first phase must start at 0");
        for (i, p) in PHASES.iter().enumerate() {
            if i > 0 {
                assert!(p.from_s > PHASES[i - 1].from_s, "phase {} from_s not increasing", i);
            }
            assert!(p.from_s < RUN_S, "phase {} starts at/after the run end", i);
            assert!(!p.mix.is_empty(), "phase {} has an empty mix", i);
            for (kind, w) in p.mix {
                assert!(*kind < KINDS.len(), "phase {} references kind {kind}", i);
                assert!(*w > 0, "phase {} has zero weight for kind {kind}", i);
            }
            assert!(p.interval > 0.0, "phase {} has non-positive interval", i);
            assert!(p.min_field > 0, "phase {} has zero min_field", i);
        }
    }

    #[test]
    fn events_ordered_and_end_with_final() {
        for (i, (t, _)) in EVENTS.iter().enumerate() {
            assert!(*t > 0.0, "event {i} has non-positive time");
            assert!(*t <= RUN_S, "event {i} is after the run end");
            if i > 0 {
                assert!(*t >= EVENTS[i - 1].0, "event {i} is out of order");
            }
        }
        assert!(EVENTS.last() == Some(&(RUN_S, Event::Final)), "run must end with the Final event");
        let finals = EVENTS.iter().filter(|(_, e)| *e == Event::Final).count();
        assert_eq!(finals, 1, "Final must appear exactly once");
    }

    #[test]
    fn mini_bosses_valid_and_each_used_once() {
        for (i, (kinds, hp, size, chest)) in MINI_BOSSES.iter().enumerate() {
            assert!(!kinds.is_empty(), "mini-boss {i} has no kinds");
            for k in *kinds {
                assert!(*k < KINDS.len(), "mini-boss {i} references kind {k}");
            }
            assert!(*hp > 0.0, "mini-boss {i} has non-positive hp multiplier");
            assert!(*size > 0.0, "mini-boss {i} has non-positive size");
            assert!((1..=5).contains(chest), "mini-boss {i} chest items {chest} out of 1..=5");
        }
        for i in 0..MINI_BOSSES.len() {
            let n = EVENTS
                .iter()
                .filter(|(_, e)| matches!(e, Event::MiniBoss(m) if *m == i as u8))
                .count();
            assert_eq!(n, 1, "mini-boss {i} must be scheduled exactly once");
        }
        for (t, e) in EVENTS {
            if let Event::MiniBoss(m) = e {
                assert!((*m as usize) < MINI_BOSSES.len(), "event at {t}s references unknown mini-boss {m}");
            }
        }
    }

    #[test]
    fn all_upgrades_unique_and_grouped() {
        assert_eq!(ALL.len(), 25, "expected 25 upgrades");
        for i in 0..ALL.len() {
            for j in (i + 1)..ALL.len() {
                assert_ne!(ALL[i], ALL[j], "duplicate upgrade {:?} in ALL", ALL[i]);
            }
        }
        for (i, u) in ALL.iter().enumerate() {
            let want = match i {
                0..9 => Cat::Gun,
                9..15 => Cat::Ability,
                _ => Cat::Passive,
            };
            assert!(u.cat() == want, "upgrade {} {:?} is not in its category block", i, u);
            assert!(!u.id().is_empty(), "{:?} has empty id", u);
            assert!(!u.name().is_empty(), "{:?} has empty name", u);
            for r in 1..=MAX_RANK {
                assert!(!u.describe(r).is_empty(), "{} has empty description at rank {r}", u.name());
            }
        }
        let mut ids = Vec::new();
        for u in ALL {
            assert!(!ids.contains(&u.id()), "duplicate id {}", u.id());
            ids.push(u.id());
        }
    }

    #[test]
    fn gun_weapon_mapping_roundtrips() {
        for u in ALL {
            let t = u.weapon_types();
            if u.cat() == Cat::Gun {
                assert!(!t.is_empty(), "gun {:?} has no weapon types", u);
                for &wt in t {
                    assert!(Up::from_weapon(wt) == Some(*u), "from_weapon({wt}) does not round-trip to {u:?}");
                }
                if *u != Up::Knife {
                    assert!(u.weapon_item() > 0, "gun {:?} has no weapon item", u);
                }
            } else {
                assert!(t.is_empty(), "non-gun {:?} has weapon types", u);
                assert_eq!(u.weapon_item(), 0, "non-gun {:?} has a weapon item", u);
            }
        }
        assert_eq!(Up::from_weapon(0), None, "weapon type 0 must map to nothing");
        assert_eq!(Up::from_weapon(999), None, "weapon type 999 must map to nothing");
    }

    #[test]
    fn ammo_only_for_guns_with_ammo() {
        assert_eq!(Up::Knife.ammo(), None, "Knife must not have ammo");
        assert_eq!(Up::Revolver.ammo(), None, "Revolver must not have ammo");
        for u in ALL {
            if u.cat() != Cat::Gun {
                assert_eq!(u.ammo(), None, "non-gun {:?} has ammo", u);
                continue;
            }
            match u.ammo() {
                None => {
                    assert!(*u == Up::Knife || *u == Up::Revolver, "gun {:?} unexpectedly has no ammo", u);
                }
                Some((slot, item)) => {
                    assert!(slot < 6, "{:?} ammo slot {slot} out of range", u);
                    assert!(item > 0, "{:?} has non-positive ammo item", u);
                }
            }
        }
        let with_ammo = ALL.iter().filter(|u| u.cat() == Cat::Gun && u.ammo().is_some()).count();
        assert_eq!(with_ammo, 7, "expected exactly 7 guns with ammo");
    }

    #[test]
    fn evolutions_cover_every_gun_once() {
        assert_eq!(EVOS.len(), 9, "expected 9 evolutions");
        let guns: Vec<Up> = ALL.iter().copied().filter(|u| u.cat() == Cat::Gun).collect();
        for g in &guns {
            let n = EVOS.iter().filter(|(_, gun, _)| gun == g).count();
            assert_eq!(n, 1, "gun {g:?} must be the base of exactly one evolution");
        }
        let mut second = Vec::new();
        let mut evos = Vec::new();
        let mut names = Vec::new();
        for (evo, gun, pair) in EVOS {
            assert!(gun.cat() == Cat::Gun, "evolution {} is not based on a gun", evo.name());
            assert!(pair.cat() != Cat::Gun, "evolution {} pairs with gun {:?}", evo.name(), pair);
            assert!(!second.contains(pair), "pair {:?} used by two evolutions", pair);
            second.push(*pair);
            assert!(!evos.contains(evo), "duplicate Evo variant");
            evos.push(*evo);
            assert!(!evo.name().is_empty(), "evolution has empty name");
            assert!(!evo.describe().is_empty(), "{} has empty description", evo.name());
            assert!(!names.contains(&evo.name()), "duplicate evolution name {}", evo.name());
            names.push(evo.name());
        }
        assert_eq!(second.len(), EVOS.len(), "second upgrades must be unique");
    }

    #[test]
    fn characters_valid() {
        assert_eq!(CHARACTERS.len(), 5, "expected 5 characters");
        let mut names = Vec::new();
        for c in CHARACTERS {
            assert!(!c.name.is_empty(), "character has empty name");
            assert!(!names.contains(&c.name), "duplicate character name {}", c.name);
            names.push(c.name);
            assert!(
                c.start.contains(&(Up::Knife, 1)),
                "{} start lacks Knife rank 1",
                c.name
            );
            assert!(
                c.start.contains(&(Up::Revolver, 1)),
                "{} start lacks Revolver rank 1",
                c.name
            );
            for (u, r) in c.start {
                assert!(
                    (1..=MAX_RANK).contains(r),
                    "{} start rank {r} out of range for {:?}",
                    c.name,
                    u
                );
            }
            for i in 0..c.start.len() {
                for j in (i + 1)..c.start.len() {
                    assert_ne!(
                        c.start[i].0, c.start[j].0,
                        "{} start lists {:?} twice",
                        c.name,
                        c.start[i].0
                    );
                }
            }
            let abilities = c.start
                .iter()
                .filter(|(u, _)| u.cat() == Cat::Ability)
                .count();
            let passives = c.start.iter().filter(|(u, _)| u.cat() == Cat::Passive).count();
            assert!(
                abilities <= ABILITY_SLOTS,
                "{} has {abilities} abilities > {} slots",
                c.name,
                ABILITY_SLOTS
            );
            assert!(
                passives <= PASSIVE_SLOTS,
                "{} has {passives} passives > {} slots",
                c.name,
                PASSIVE_SLOTS
            );
            assert!(c.damage > 0.0, "{} has non-positive damage", c.name);
            assert!(c.speed > 0.0, "{} has non-positive speed", c.name);
        }
        assert_eq!(CHARACTERS[0].name, "Serious Sam", "first character must be Serious Sam");
    }

    #[test]
    fn difficulties_scale_up() {
        assert_eq!(DIFFICULTIES.len(), 4, "expected 4 difficulties");
        let want = ["Tourist", "Normal", "Serious", "Mental"];
        for (i, (name, _, _, _)) in DIFFICULTIES.iter().enumerate() {
            assert_eq!(*name, want[i], "difficulty {i} must be named {}", want[i]);
        }
        let (_, h, d, r) = DIFFICULTIES[1];
        assert_eq!((h, d, r), (1.0, 1.0, 1.0), "Normal must be (1.0, 1.0, 1.0)");
        for i in 1..DIFFICULTIES.len() {
            let (_, h0, d0, r0) = DIFFICULTIES[i - 1];
            let (n, h1, d1, r1) = DIFFICULTIES[i];
            assert!(h1 > h0, "health does not scale from {} to {}", DIFFICULTIES[i - 1].0, n);
            assert!(d1 > d0, "density does not increase from {} to {}", DIFFICULTIES[i - 1].0, n);
            assert!(r1 > r0, "rewards do not increase from {} to {}", DIFFICULTIES[i - 1].0, n);
        }
    }

    #[test]
    fn xp_curve() {
        assert_eq!(xp_for_level(1), 5.0, "xp(1)");
        assert_eq!(xp_for_level(2), 15.0, "xp(2)");
        assert_eq!(xp_for_level(19), 185.0, "xp(19)");
        assert_eq!(xp_for_level(20), 195.0, "xp(20)");
        assert_eq!(xp_for_level(40), 455.0, "xp(40)");
        for l in 1..100 {
            let a = xp_for_level(l);
            let b = xp_for_level(l + 1);
            assert!(b > a, "xp not increasing at level {l}");
            let step = b - a;
            assert!(
                (10.0..=16.0).contains(&step),
                "xp step at level {l} is {step}, expected 10..=16"
            );
        }
    }

    #[test]
    fn ranged_classifies_all_kinds() {
        let melee = ["Beheaded Kamikaze", "Gnaar", "Gnaar Sergeant", "Sirian Werebull", "Marsh Hopper", "Lava Golem", "Big Lava Golem"];
        for (i, k) in KINDS.iter().enumerate() {
            let expect = !melee.contains(&k.name);
            assert_eq!(ranged(i), expect, "kind {} ({})", i, k.name);
        }
    }

    #[test]
    fn autofire_interval_values() {
        assert!((autofire_interval(1) - 0.45).abs() < 1e-9);
        assert!((autofire_interval(2) - 0.41).abs() < 1e-9);
        assert!((autofire_interval(3) - 0.37).abs() < 1e-9);
        assert!((autofire_interval(4) - 0.33).abs() < 1e-9);
        assert!((autofire_interval(5) - 0.29).abs() < 1e-9);
        // never below 0.20
        assert!((autofire_interval(10) - 0.20).abs() < 1e-9);
        assert!((autofire_interval(100) - 0.20).abs() < 1e-9);
    }
}
