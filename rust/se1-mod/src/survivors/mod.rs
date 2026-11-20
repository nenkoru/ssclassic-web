//! "Serious Survivors": a Vampire-Survivors-style mode on top of the unchanged engine.
//!
//! `?mode=survivors` (port/web/survivors.js). A 20-minute run:
//! - **Director.** A timeline of spawn mixes, scripted events (Kamikaze stampedes, Werebull runs,
//!   Kleer rain, swarms), mini-bosses that drop chests, and a final boss. After 20:00, endless mode.
//! - **XP.** XP gems on the ground with a pickup magnet; level-ups offer cards for Sam's guns (ranks
//!   1-5), auto-cast abilities and passives.
//! - **Evolutions.** A gun at max rank, plus its paired upgrade, plus a boss chest after 10:00.
//! - **Extras.** Relics with Serious power-ups, damage numbers, and a results screen; meta
//!   progression (gold, shop, characters, difficulty) lives on the page.
//!
//! The mod only uses the host API (port/common/se1mod.h): it spawns and damages entities, reads
//! health, weapons and ammo, and draws effects. Gun ranks use the engine's damage hook (API v5):
//! the hook scales player gun damage by the rank multiplier, and the mod drains the event queue
//! each frame for damage numbers, evolutions and kill detection.
//! Design notes: notes/survivors.md, notes/survivors-research.md.

mod data;

use crate::host::{EnemyOpts, Host};
use data::*;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

/// Damage hook state (API v5). The engine calls `damage_hook` from `se1mod_damage`,
/// which can happen while `se1mod_frame` holds a `&mut` to the mod state (reentrancy:
/// the mod's own `host.damage` calls go through the same engine path). So this hook
/// must not touch the mod state: it only reads/writes these statics.
static HOOK_ON: AtomicBool = AtomicBool::new(false);
/// Per-gun damage multipliers (f32::to_bits), one per gun in `data::ALL` order.
/// Updated every frame from the ranks; the hook reads the one for the gun that
/// fired the projectile (API v6), falling back to the held gun's.
static GUN_MULTS: [AtomicU32; 9] = [
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
];
/// Index (in `data::ALL` order) of the gun the player holds; the hook's fallback.
static HELD_GUN: AtomicU32 = AtomicU32::new(0);
static HOOK_CALLS: AtomicU32 = AtomicU32::new(0);
static HOOK_FROM_PLAYER: AtomicU32 = AtomicU32::new(0);
static HOOK_SCALED: AtomicU32 = AtomicU32::new(0);
/// Per-gun hit counts for the debug log; the hook increments, the frame loop swaps to 0.
static HOOK_GUN_HITS: [AtomicU32; 9] = [
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
    AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0),
];
static QUEUE: Mutex<Vec<DamageEvent>> = Mutex::new(Vec::new());
static CRIT_BITS: AtomicU32 = AtomicU32::new(0); // f32::to_bits of the current gun's crit chance
static CRIT_RNG: AtomicU32 = AtomicU32::new(0x9E37_79B9);

/// xorshift on an atomic: the hook may not touch the mod state (and its rng), see damage_hook
fn hook_rand() -> f32 {
    let mut x = CRIT_RNG.load(Ordering::Relaxed);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    CRIT_RNG.store(x, Ordering::Relaxed);
    (x >> 8) as f32 / (1u32 << 24) as f32
}

/// The engine's damage hook (API v6). Called from `se1mod_damage` in lib.rs.
/// Must not touch the mod state (reentrancy — see above).
/// `weapon` is the WeaponType of the projectile that dealt the damage (0 = hit-scan
/// or not a player projectile). When it maps to a gun, that gun's multiplier is used
/// and the hit is credited to that gun; otherwise the held gun's.
pub fn damage_hook(target: i32, source: i32, dmt: i32, amount: f32, weapon: i32) -> f32 {
    if !HOOK_ON.load(Ordering::Relaxed) {
        return amount;
    }
    HOOK_CALLS.fetch_add(1, Ordering::Relaxed);
    let mut crit = false;
    let gun = if source == 1 && target != 0 {
        // the gun that fired the projectile (API v6), falling back to the held gun
        let g = match weapon {
            0 => HELD_GUN.load(Ordering::Relaxed) as usize,
            w => Up::from_weapon(w).map(|u| ALL.iter().position(|&a| a == u).unwrap()).unwrap_or(HELD_GUN.load(Ordering::Relaxed) as usize),
        };
        let mut mult = f32::from_bits(GUN_MULTS[g].load(Ordering::Relaxed));
        // critical hits (Luck, Lucky Pyramid, the Revolver's rank): double damage
        if hook_rand() < f32::from_bits(CRIT_BITS.load(Ordering::Relaxed)) {
            mult *= 2.0;
            crit = true;
        }
        HOOK_FROM_PLAYER.fetch_add(1, Ordering::Relaxed);
        HOOK_SCALED.fetch_add(1, Ordering::Relaxed);
        HOOK_GUN_HITS[g].fetch_add(1, Ordering::Relaxed);
        Some((g, amount * mult))
    } else {
        None
    };
    let scaled = match &gun {
        Some((_, s)) => *s,
        None => amount,
    };
    if target != 0 {
        let gun_idx = gun.map(|(g, _)| g).unwrap_or(HELD_GUN.load(Ordering::Relaxed) as usize);
        QUEUE.lock().unwrap().push(DamageEvent { target, source, dmt, amount: scaled, crit, gun: gun_idx });
    }
    scaled
}

const TAU: f64 = std::f64::consts::TAU;
const MAX_GEMS: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Lobby,
    Run,
    Offer,
    Chest,
    End,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Src {
    Gun(Up),
    Ability(Up),
    Evo(Evo),
}
impl Src {
    fn name(self) -> &'static str {
        match self {
            Src::Gun(u) | Src::Ability(u) => u.name(),
            Src::Evo(e) => e.name(),
        }
    }
}

struct Enemy {
    h: i32,
    kind: usize,
    hp: f32,
    max_hp: f32,
    pos: [f32; 3],
    elite: bool,
    boss: bool,
    last_src: Src,
    far_since: f64,
}
struct DamageEvent {
    target: i32,
    source: i32,
    dmt: i32,
    amount: f32,
    crit: bool,
    /// Index (in `data::ALL` order) of the gun that dealt this hit (API v6).
    gun: usize,
}
struct Gem {
    h: i32,
    xp: f32,
    pos: [f32; 3],
    pull: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum DropKind {
    Chest(u32),
    Relic,
}
struct Drop {
    h: i32,
    kind: DropKind,
    pos: [f32; 3],
}
#[derive(Clone, Copy)]
enum Card {
    Up(Up),
    Gold,
    Chicken,
}
#[derive(Clone, Copy, PartialEq)]
enum Power {
    SeriousDamage,
    Invulnerability,
    SeriousSpeed,
    Invisibility,
}
impl Power {
    fn name(self) -> &'static str {
        match self {
            Power::SeriousDamage => "Serious Damage",
            Power::Invulnerability => "Invulnerability",
            Power::SeriousSpeed => "Serious Speed",
            Power::Invisibility => "Invisibility",
        }
    }
    fn secs(self) -> f64 {
        match self {
            Power::SeriousDamage => 30.0,
            Power::Invulnerability => 20.0,
            Power::SeriousSpeed => 20.0,
            Power::Invisibility => 25.0,
        }
    }
}

/// Permanent upgrades bought on the page (gold shop), read at run start.
#[derive(Default)]
struct Meta {
    might: f32,
    armor: f32,
    max_hp: f32,
    recovery: f32,
    cooldown: f32,
    area: f32,
    magnet: f32,
    growth: f32,
    greed: f32,
    luck: f32,
    revival: f32,
    reroll: f32,
    skip: f32,
}

pub struct Survivors {
    state: State,
    rng: u64,
    full_data: bool,
    avail: Vec<bool>,
    // run
    last_t: f64,
    time: f64,
    character: usize,
    difficulty: usize,
    meta: Meta,
    pos: [f32; 3],
    eye: [f32; 3],
    view: [f32; 3],
    health: f32,
    enemies: Vec<Enemy>,
    gems: Vec<Gem>,
    drops: Vec<Drop>,
    pub level: u32,
    xp: f32,
    next_xp: f32,
    kills: u32,
    score: u64,
    combo: u32,
    combo_t: f64,
    gold: f32,
    ranks: Vec<(Up, u32)>,
    evolved: Vec<Evo>,
    cooldowns: Vec<(Up, f64)>,
    offer: Vec<Card>,
    rerolls: u32,
    skips: u32,
    revivals: u32,
    chest_items: u32,
    // director
    next_spawn: f64,
    next_event: usize,
    flood_until: f64,
    flood_next: f64,
    stampede: Option<(f64, f64)>,
    final_boss: Option<i32>,
    victory: bool,
    endless: bool,
    // weapons
    weapon: i32,
    ammo: [i32; 6],
    ammo_acc: [f32; 6],
    shots: [u32; 17],
    firing_until: f64,
    revolver_hits: u32,
    typewriter_kills: u32,
    hurricane_t: f64,
    // feedback
    hits: Vec<[f32; 5]>,
    flash: bool,
    stats: Vec<(&'static str, f64)>,
    powers: Vec<(Power, f64)>,
    speed_set: f32,
    hud_t: f64,
    sound_t: f64,
    procs: Vec<String>,
    achieved: Vec<&'static str>,
    dead_posted: bool,
    debug_chest: u32,
    started_at: f64,
    hook_log_t: f64,
    weapons_t: f64,   // last check that every ranked gun is really owned (ensure_weapons)
    hold_colts: u8,   // switching to the dual Schofields: 1 wanted, 2 key pressed (hold_colts)
    autofire_side: u8, // auto-fire: 0 = left gun, 1 = right gun
    // debug / test
    stress: usize,
    stress_kind: usize,
    max_alive: usize, // performance budget (notes/big-ideas.md: ~300 on a fast Mac, fewer on phones)
    hurt: Option<(f32, f32, f64)>,   // (rel_angle, amount, time) of the last hit on the player
}

impl Survivors {
    pub fn new(host: &Host) -> Survivors {
        let t = host.game_time();
        host.shell_execute("cht_bEnable = 1");
        host.shell_execute("cht_fTranslationMultiplier = 1.0");
        host.shell_execute("cht_bGod = 0");
        host.shell_execute("cht_bInvisible = 0");
        let avail: Vec<bool> = KINDS.iter().map(|k| host.file_exists(k.model)).collect();
        let full_data = avail[K_GOLEM] || avail[K_HOPPER];
        let mut s = Survivors {
            state: State::Lobby, rng: 0x9E37_79B9_7F4A_7C15 ^ t.to_bits() ^ (host.page_option("se1SurvivorsSeed") as u64),
            full_data, avail,
            last_t: t, time: 0.0, character: 0, difficulty: 1, meta: Meta::default(),
            pos: [0.0; 3], eye: [0.0; 3], view: [0.0, 0.0, -1.0], health: 100.0,
            enemies: Vec::new(), gems: Vec::new(), drops: Vec::new(),
            level: 1, xp: 0.0, next_xp: xp_for_level(1), kills: 0, score: 0, combo: 0, combo_t: 0.0, gold: 0.0,
            ranks: Vec::new(), evolved: Vec::new(), cooldowns: Vec::new(), offer: Vec::new(),
            rerolls: 0, skips: 0, revivals: 0, chest_items: 0,
            next_spawn: 0.0, next_event: 0, flood_until: -1.0, flood_next: 0.0, stampede: None,
            final_boss: None, victory: false, endless: false,
            weapon: 0, ammo: [0; 6], ammo_acc: [0.0; 6], shots: [0; 17], firing_until: -1.0,
            revolver_hits: 0, typewriter_kills: 0, hurricane_t: 0.0,
            hits: Vec::new(), flash: false, stats: Vec::new(), powers: Vec::new(), speed_set: 1.0,
            hud_t: 0.0, sound_t: 0.0, procs: Vec::new(), achieved: Vec::new(), dead_posted: false, debug_chest: 0, started_at: 0.0, hook_log_t: 0.0, weapons_t: 0.0, hold_colts: 0, autofire_side: 0,
            stress: host.page_option("se1SurvivorsStress").max(0.0) as usize,
            stress_kind: match host.page_option("se1SurvivorsStressKind") as i32 {
                1 => K_KLEER, 2 => K_GNAAR, 3 => K_ARACH, 4 => K_BULL, _ => K_FIRE,
            },
            max_alive: match host.page_option("se1SurvivorsCap") as usize { 0 => 110, n => n.clamp(20, 400) },
            hurt: None,
        };
        host.log(&format!("se1mod: Serious Survivors ready ({} data)", if full_data { "full" } else { "demo" }));
        if s.stress > 0 || host.page_option("se1SurvivorsAuto") > 0.0 {
            s.start_run(host, host.page_option("se1SurvivorsChar").max(0.0) as usize, 1);
        } else {
            host.set_pause(true);
            let chars: Vec<String> = CHARACTERS.iter().map(|c| format!("\"{}\"", c.name)).collect();
            let diffs: Vec<String> = DIFFICULTIES.iter().map(|d| format!("\"{}\"", d.0)).collect();
            host.ui_post(&format!(r#"{{"type":"lobby","full":{},"characters":[{}],"difficulties":[{}]}}"#, full_data, chars.join(","), diffs.join(",")));
        }
        s
    }

    // ------------------------------------------------------------------ helpers
    fn rand(&mut self) -> f64 {
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        (self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn rank(&self, u: Up) -> u32 {
        self.ranks.iter().find(|(x, _)| *x == u).map_or(0, |(_, r)| *r)
    }
    fn evolved(&self, e: Evo) -> bool {
        self.evolved.contains(&e)
    }
    fn power(&self, p: Power) -> bool {
        self.powers.iter().any(|(q, _)| *q == p)
    }
    fn luck(&self) -> f32 {
        0.10 * self.rank(Up::Lucky) as f32 + 0.05 * self.meta.luck
    }
    fn area(&self) -> f32 {
        (1.0 + 0.12 * self.rank(Up::BigBoom) as f32) * (1.0 + 0.05 * self.meta.area)
    }
    fn cooldown(&self, base: f64) -> f64 {
        let m = (1.0 - 0.08 * self.rank(Up::Bloodlust) as f64) * (1.0 - 0.03 * self.meta.cooldown as f64);
        base * m.max(0.4)
    }
    fn might(&self) -> f32 {
        CHARACTERS[self.character].damage * (1.0 + 0.05 * self.meta.might) * if self.power(Power::SeriousDamage) { 4.0 } else { 1.0 }
    }
    fn heal_cap(&self) -> f32 {
        100.0 + 20.0 * self.rank(Up::Overheal) as f32 + 10.0 * self.meta.max_hp
    }
    fn xp_mul(&self) -> f32 {
        (1.0 + 0.15 * self.rank(Up::Greed) as f32) * (1.0 + 0.05 * self.meta.growth)
    }
    fn gold_mul(&self) -> f32 {
        (1.0 + 0.10 * self.rank(Up::Greed) as f32) * (1.0 + 0.10 * self.meta.greed) * DIFFICULTIES[self.difficulty].3
    }
    fn ready(&mut self, u: Up, cd: f64) -> bool {
        let cd = self.cooldown(cd);
        let now = self.time;
        match self.cooldowns.iter_mut().find(|(x, _)| *x == u) {
            Some((_, next)) if now < *next => false,
            Some((_, next)) => {
                *next = now + cd;
                true
            }
            None => {
                self.cooldowns.push((u, now + cd * 0.5));
                false
            }
        }
    }
    fn proc(&mut self, what: String) {
        self.procs.push(what);
        if self.procs.len() > 4 {
            self.procs.remove(0);
        }
    }
    fn banner(&self, host: &Host, text: &str, sound: Option<&str>) {
        host.ui_post(&format!(r#"{{"type":"banner","text":"{}"}}"#, text.replace('"', "'")));
        if let Some(s) = sound {
            host.sound(s, 1.0);
        }
    }
    fn achieve(&mut self, host: &Host, id: &'static str) {
        if !self.achieved.contains(&id) {
            self.achieved.push(id);
            host.ui_post(&format!(r#"{{"type":"achv","id":"{id}"}}"#));
        }
    }
    fn stat(&mut self, src: Src, amount: f32) {
        let n = src.name();
        match self.stats.iter_mut().find(|(x, _)| *x == n) {
            Some((_, v)) => *v += amount as f64,
            None => self.stats.push((n, amount as f64)),
        }
    }
    /// Yaw (radians) of a horizontal direction; and the angle of a world point relative to the view.
    fn rel_angle(&self, p: [f32; 3]) -> f32 {
        let (fx, fz) = norm2(self.view[0], self.view[2]);
        let (dx, dz) = (p[0] - self.pos[0], p[2] - self.pos[2]);
        let (rx, rz) = (-fz, fx);
        (dx * rx + dz * rz).atan2(dx * fx + dz * fz).to_degrees()
    }
    fn view_yaw(&self) -> f64 {
        (self.view[2] as f64).atan2(self.view[0] as f64)
    }

    // ------------------------------------------------------------------ frame
    pub fn frame(&mut self, host: &Host) {
        let gt = host.game_time();
        let dt = (gt - self.last_t).clamp(0.0, 0.25);
        self.last_t = gt;
        match self.state {
            State::Lobby => {
                if let Some(v) = host.ui_poll() {
                    if v >= 1000 {
                        let c = ((v - 1000) / 10) as usize;
                        let d = ((v - 1000) % 10) as usize;
                        self.start_run(host, c.min(CHARACTERS.len() - 1), d.min(DIFFICULTIES.len() - 1));
                    }
                }
            }
            State::Offer => {
                if let Some(v) = host.ui_poll() {
                    self.answer_offer(host, v);
                }
            }
            State::Chest => {
                if host.ui_poll().is_some() {
                    self.resume(host);
                }
            }
            State::End => {
                if host.ui_poll() == Some(30) && self.victory {
                    self.endless = true;
                    self.resume(host);
                    self.banner(host, "ENDLESS: how long can you last?", Some("Sounds\\Player\\Quotes\\Lets_get_serious.wav"));
                }
            }
            State::Run => {
                self.time += dt;
                // update the per-gun multipliers and held gun for the damage hook (API v6)
                for (i, &g) in ALL.iter().enumerate().take(9) {
                    let r = self.rank(g).max(1);
                    let per_rank = if g == Up::Knife { 0.25 } else { 0.20 };
                    GUN_MULTS[i].store((self.might() * (1.0 + per_rank * (r - 1) as f32)).to_bits(), Ordering::Relaxed);
                }
                let held = Up::from_weapon(self.weapon).unwrap_or(Up::Knife);
                HELD_GUN.store(ALL.iter().position(|&a| a == held).unwrap_or(0) as u32, Ordering::Relaxed);
                // crit chance for the held gun (Luck, the Revolver's rank)
                let r = self.rank(held).max(1);
                let crit = self.luck() * 0.5 + if held == Up::Revolver { 0.05 * r as f32 } else { 0.0 };
                CRIT_BITS.store(crit.to_bits(), Ordering::Relaxed);
                // drain the damage hook queue
                let events = std::mem::take(&mut *QUEUE.lock().unwrap());
                if !events.is_empty() {
                    self.drain_events(host, events);
                }
                // debug log every 5 s
                if self.time - self.hook_log_t >= 5.0 {
                    self.hook_log_t = self.time;
                    let calls = HOOK_CALLS.swap(0, Ordering::Relaxed);
                    let from_player = HOOK_FROM_PLAYER.swap(0, Ordering::Relaxed);
                    let scaled = HOOK_SCALED.swap(0, Ordering::Relaxed);
                    // per-gun credit counts for the log line
                    let mut by_gun: Vec<(usize, u32)> = Vec::new();
                    for i in 0..9 {
                        let c = HOOK_GUN_HITS[i].swap(0, Ordering::Relaxed);
                        if c > 0 {
                            by_gun.push((i, c));
                        }
                    }
                    let gun_str = by_gun.iter().map(|&(i, c)| format!("{} {}", ALL[i].name(), c)).collect::<Vec<_>>().join(", ");
                    let tail = if gun_str.is_empty() { String::new() } else { format!(", by gun: {}", gun_str) };
                    host.log(&format!("damage hook: {} calls, {} from player, {} scaled{}", calls, from_player, scaled, tail));
                }
                self.ensure_weapons(host);
                self.hold_colts(host);
                if self.stress > 0 {
                    self.stress_frame(host);
                } else {
                    self.run(host, dt);
                }
            }
        }
    }

    /// Process damage events from the engine's damage hook (API v6).
    /// Called once per frame with the drained queue. For each event whose target is a
    /// tracked enemy: credit the damage to the gun that fired it (ev.gun), push the
    /// damage number, and fire per-hit gun effects. The rank bonus is already applied
    /// by the hook (scaling), so we don't add an extra `host.damage` here.
    fn drain_events(&mut self, host: &Host, events: Vec<DamageEvent>) {
        for ev in events {
            let Some(i) = self.enemies.iter().position(|e| e.h == ev.target) else { continue };
            let e = &self.enemies[i];
            if e.hp <= 0.0 {
                continue;
            }
            if ev.source == 1 {
                // player gun damage: credit to the gun that fired it (API v6)
                let gun = ALL[ev.gun.min(8)];
                self.enemies[i].last_src = Src::Gun(gun);
                self.stat(Src::Gun(gun), ev.amount);
                let p = self.enemies[i].pos;
                self.push_hit(p, ev.amount, if ev.crit { 2.0 } else { 0.0 });
                self.on_gun_hit_effects(host, i, ev.amount, gun);
            }
        }
    }

    /// Once a second: every gun with a rank must really be in the player's hands. The engine can
    /// take weapons away after we gave them (a grant at the very start of a run is undone when the
    /// player's weapons are set up for the level; a respawn resets them too), and a gun card that
    /// leaves the gun unusable is the worst bug a run can have.
    fn ensure_weapons(&mut self, host: &Host) {
        if self.time - self.weapons_t < 1.0 {
            return;
        }
        self.weapons_t = self.time;
        let owned = host.weapons_owned();
        for &(u, r) in self.ranks.iter() {
            if u.cat() != Cat::Gun || r == 0 || u.weapon_item() == 0 {
                continue;
            }
            // the Schofields count only as the pair (WeaponType 3): a second colt pickup makes the pair
            let has = if u == Up::Revolver {
                owned & (1 << (3 - 1)) != 0
            } else {
                u.weapon_types().iter().any(|&wt| owned & (1 << (wt - 1)) != 0)
            };
            if !has {
                host.give_weapon(u.weapon_item());
                if u == Up::Revolver {
                    self.hold_colts = 1;
                }
            }
        }
    }

    /// Switch to the dual Schofields once they are owned (run start, or after the engine reset the
    /// weapons): picking them up switches only when the player's auto-select setting allows. The
    /// select control must stay pressed for a frame for the player to read it, so press now and
    /// release on the next frame. Only from the knife or the single colt: on the pair the same key
    /// would switch back to one gun.
    fn hold_colts(&mut self, host: &Host) {
        match self.hold_colts {
            1 => {
                if host.weapons_owned() & (1 << (3 - 1)) != 0 {
                    if matches!(host.weapon(), 1 | 2) {
                        host.shell_execute("ctl_bSelectWeapon[1] = 1");
                        self.hold_colts = 2;
                    } else {
                        self.hold_colts = 0;
                    }
                }
            }
            2 => {
                host.shell_execute("ctl_bSelectWeapon[1] = 0");
                self.hold_colts = 0;
            }
            _ => {}
        }
    }

    fn start_run(&mut self, host: &Host, character: usize, difficulty: usize) {
        self.character = character;
        self.difficulty = difficulty;
        let o = |n: &str| host.page_option(n).max(0.0) as f32;
        self.meta = Meta {
            might: o("se1SvMight"), armor: o("se1SvArmor"), max_hp: o("se1SvMaxHp"), recovery: o("se1SvRecovery"),
            cooldown: o("se1SvCooldown"), area: o("se1SvArea"), magnet: o("se1SvMagnet"), growth: o("se1SvGrowth"),
            greed: o("se1SvGreed"), luck: o("se1SvLuck"), revival: o("se1SvRevival"), reroll: o("se1SvReroll"), skip: o("se1SvSkip"),
        };
        self.rerolls = 1 + self.meta.reroll as u32;
        self.skips = 1 + self.meta.skip as u32;
        self.revivals = self.meta.revival as u32;
        for &(u, r) in CHARACTERS[character].start {
            for _ in 0..r {
                self.take(host, Card::Up(u), false);
            }
        }
        if self.meta.armor > 0.0 {
            host.armor(25.0 * self.meta.armor, 200.0);
        }
        self.xp = host.page_option("se1SurvivorsXp").max(0.0) as f32;
        self.time = 0.0;
        self.next_spawn = 3.0;
        // debug/test: ?svgive=<bit mask of data::ALL>&svrank=N, ?svtime=<seconds>, ?svchest=<items>, ?svgod=1
        let give = host.page_option("se1SurvivorsGive") as u64;
        let give_rank = match host.page_option("se1SurvivorsGiveRank") as u32 { 0 => MAX_RANK, r => r.min(MAX_RANK) };
        for (i, &u) in ALL.iter().enumerate() {
            if give & (1 << i) != 0 {
                while self.rank(u) < give_rank {
                    self.take(host, Card::Up(u), false);
                }
            }
        }
        let skip_to = host.page_option("se1SurvivorsTime").max(0.0);
        if skip_to > 0.0 {
            self.time = skip_to;
            self.next_spawn = skip_to + 3.0;
            self.next_event = EVENTS.iter().position(|e| e.0 > skip_to).unwrap_or(EVENTS.len());
        }
        self.started_at = self.time;
        self.weapons_t = self.time - 1.0; // check the guns on the first frame (the clock restarted)
        self.debug_chest = host.page_option("se1SurvivorsChest").max(0.0) as u32;
        self.hurt = None;
        let _ = host.player_hurt(); // drop a hit left over from before this run
        // debug/test: ?svbehind=N spawns one enemy of kind N-1 behind the player at run start
        let behind = host.page_option("se1SurvivorsBehind").max(0.0) as usize;
        if behind > 0 && behind <= KINDS.len() {
            let d = host.player_view().unwrap_or([0.0, 0.0, -1.0]);
            let (fx, fz) = norm2(d[0], d[2]);
            let p = [self.pos[0] - fx * 12.0, self.pos[1], self.pos[2] - fz * 12.0];
            self.spawn_at(host, behind - 1, p, 1.0, false, false);
        }
        if host.page_option("se1SurvivorsGod") > 0.0 {
            host.shell_execute("cht_bGod = 1");
        }
        // debug/test: ?svweapon=<WeaponType> selects that weapon at run start
        let w = host.page_option("se1SurvivorsWeapon") as i32;
        self.hold_colts = if w > 0 { 0 } else { 1 };
        if w > 0 {
            let idx = match w {
                2 | 3 => 1, 4 | 5 => 2, 6 | 7 => 3, 8 | 9 => 4, 14 => 6, 16 => 8, _ => 0,
            };
            if idx > 0 {
                host.shell_execute(&format!("ctl_bSelectWeapon[{}] = 1", idx));
                host.shell_execute(&format!("ctl_bSelectWeapon[{}] = 0", idx));
            }
        }
        self.precache(host);
        HOOK_ON.store(true, Ordering::Relaxed);
        for m in GUN_MULTS.iter() {
            m.store(0, Ordering::Relaxed);
        }
        HELD_GUN.store(0, Ordering::Relaxed);
        HOOK_CALLS.store(0, Ordering::Relaxed);
        HOOK_FROM_PLAYER.store(0, Ordering::Relaxed);
        HOOK_SCALED.store(0, Ordering::Relaxed);
        for m in HOOK_GUN_HITS.iter() {
            m.store(0, Ordering::Relaxed);
        }
        QUEUE.lock().unwrap().clear();
        self.hook_log_t = 0.0;
        self.state = State::Run;
        host.set_pause(false);
        host.ui_post(&format!(r#"{{"type":"start","character":"{}","difficulty":"{}"}}"#, CHARACTERS[character].name, DIFFICULTIES[difficulty].0));
        host.sound("Sounds\\Player\\Quotes\\Lets_rock_and_roll.wav", 1.0);
        host.log(&format!("se1mod: survivors run started ({}, {})", CHARACTERS[character].name, DIFFICULTIES[difficulty].0));
    }

    /// Load every monster, effect and pickup the run can use now, not mid-fight (the engine loads
    /// models, textures and sounds on first spawn): spawn each once far below the level and remove it.
    fn precache(&mut self, host: &Host) {
        let far = [self.pos[0], self.pos[1] - 2000.0, self.pos[2]];
        let mut seen: Vec<(&str, i32)> = Vec::new();
        for k in 0..KINDS.len() {
            let kind = &KINDS[k];
            if !self.avail[k] || seen.contains(&(kind.class, kind.variant)) {
                continue;
            }
            seen.push((kind.class, kind.variant));
            let o = EnemyOpts { variant: kind.variant, ..Default::default() };
            if let Some(h) = host.spawn_enemy(kind.class, far, o) {
                host.destroy(h);
            }
        }
        for (cls, t) in [(ARMOR_ITEM, ARIT_SHARD), (ARMOR_ITEM, ARIT_MEDIUM), (HEALTH_ITEM, HIT_PILL), (HEALTH_ITEM, HIT_SMALL), (HEALTH_ITEM, HIT_MEDIUM), (HEALTH_ITEM, HIT_SUPER), (AMMO_ITEM, 1), (AMMO_ITEM, 2), (AMMO_ITEM, 3), (AMMO_ITEM, 5)] {
            if let Some(h) = host.spawn_item(cls, t, far) {
                host.destroy(h);
            }
        }
        for e in [BET_ROCKET, BET_SHOCKWAVE, BET_CANNON, BET_CANNONSHOCKWAVE, BET_TELEPORT, BET_BOMB] {
            host.effect(e, far, 1.0);
        }
        host.lightning(far, [far[0] + 1.0, far[1], far[2]], 1.0, 0.1);
    }

    fn resume(&mut self, host: &Host) {
        self.state = State::Run;
        host.set_pause(false);
        self.post_hud(host);
    }

    fn run(&mut self, host: &Host, dt: f64) {
        let t = self.time;
        if t < self.started_at + 15.0 {
            host.close_computer(); // a run doesn't start on the NETRICSA briefing (it pauses the game)
        }
        let Some((pos, health)) = host.player() else {
            if !self.dead_posted && t > self.started_at + 2.0 {
                self.end(host, false);
            }
            return;
        };
        self.pos = pos;
        self.health = health;
        if let Some((e, d)) = host.player_eye() {
            self.eye = e;
            self.view = d;
        } else {
            self.eye = [pos[0], pos[1] + 1.6, pos[2]];
        }
        if health < 15.0 && self.revivals > 0 {
            self.revivals -= 1;
            host.player_heal(60.0, self.heal_cap());
            self.add_power(host, Power::Invulnerability, 4.0);
            self.banner(host, "REVIVAL! The Sirian amulet pulls you back", Some("Sounds\\Player\\Quotes\\Yeehaw!!!.wav"));
        }
        if self.debug_chest > 0 && self.time > self.started_at + 3.0 {
            let n = std::mem::take(&mut self.debug_chest);
            self.open_chest(host, n);
            return;
        }
        self.track_weapon(host, dt);
        self.update_enemies(host);
        self.update_gems(host, dt);
        self.update_drops(host);
        self.director(host, t);
        self.abilities(host);
        self.passives(host, dt);
        self.update_powers(host);
        if let Some((from, amount)) = host.player_hurt() {
            self.hurt = Some((self.rel_angle(from), amount, self.time));
        }
        if self.combo > 0 && t > self.combo_t + 2.0 {
            self.combo = 0;
        }
        if t >= 600.0 {
            self.achieve(host, "survive10");
        }
        if self.kills >= 1000 {
            self.achieve(host, "kills1000");
        }
        if self.state == State::Run && self.xp >= self.next_xp {
            self.level_up(host);
        }
        if !self.hits.is_empty() || self.flash {
            self.post_fx(host);
        }
        if t - self.hud_t > 0.1 || self.state != State::Run {
            self.hud_t = t;
            self.post_hud(host);
        }
    }

    // ------------------------------------------------------------------ weapons
    fn track_weapon(&mut self, host: &Host, dt: f64) {
        let w = host.weapon();
        let (ammo, max) = host.ammo();
        let gun = Up::from_weapon(w);
        if let Some(g) = gun {
            if let Some((slot, _)) = g.ammo() {
                if w == self.weapon && ammo[slot] < self.ammo[slot] {
                    let n = (self.ammo[slot] - ammo[slot]) as u32;
                    self.shots[w as usize] += n;
                    self.firing_until = self.time + 0.35;
                    for _ in 0..n.min(3) {
                        self.on_shot(host, g);
                    }
                }
            }
        }
        self.weapon = w;
        self.ammo = ammo;
        // ammo regeneration from gun ranks, bottomless evolutions
        for &g in &[Up::Shotgun, Up::DoubleShotgun, Up::TommyGun, Up::Minigun, Up::RocketLauncher, Up::Laser, Up::Cannon] {
            let r = self.rank(g);
            if r < 2 {
                continue;
            }
            let (slot, ait) = g.ammo().unwrap();
            let per_s = match g {
                Up::Shotgun | Up::DoubleShotgun => 0.4,
                Up::TommyGun | Up::Minigun => 3.0,
                Up::RocketLauncher => 0.15,
                Up::Laser => 1.5,
                _ => 0.06,
            } * (r - 1) as f32;
            self.ammo_acc[slot] += per_s * dt as f32;
            if self.ammo_acc[slot] >= 1.0 {
                let n = self.ammo_acc[slot] as i32;
                self.ammo_acc[slot] -= n as f32;
                if ammo[slot] < max[slot] {
                    host.give_ammo(ait, n);
                }
            }
        }
        let bottomless = [(Evo::Typewriter, 0usize, 2), (Evo::Hurricane, 0, 2), (Evo::StormCannon, 4, 5)];
        for (e, slot, ait) in bottomless {
            if self.evolved(e) && ammo[slot] < max[slot] / 2 {
                host.give_ammo(ait, max[slot] - ammo[slot]);
                self.ammo[slot] = max[slot];
            }
        }
    }

    fn on_shot(&mut self, host: &Host, g: Up) {
        let w = self.weapon as usize;
        match g {
            Up::RocketLauncher => {
                if self.rank(g) >= 3 {
                    // twin rocket: a second one beside the aim
                    let side = norm3([-self.view[2], 0.0, self.view[0]]);
                    let p = add3(add3(self.eye, scale3(self.view, 1.2)), scale3(side, 0.6));
                    host.projectile(PRT_ROCKET, p, self.view, 0.0);
                }
                if self.evolved(Evo::RocketParty) {
                    // four friends drop on the nearest crowd from above (away from the player: no self-damage)
                    let targets: Vec<[f32; 3]> = self.near(self.pos, 45.0).into_iter().filter(|&(_, d)| d > 8.0).take(4).map(|(i, _)| self.enemies[i].pos).collect();
                    for q in targets {
                        let from = [q[0] + (self.rand() as f32 - 0.5) * 2.0, q[1] + 9.0, q[2] + (self.rand() as f32 - 0.5) * 2.0];
                        host.projectile(PRT_ROCKET, from, norm3(sub3([q[0], q[1] + 0.5, q[2]], from)), 0.0);
                    }
                }
            }
            Up::Cannon if self.evolved(Evo::MassDestruction) && self.shots[w] % 3 == 0 => {
                // NukeBall: the densest crowd in front of the player
                if let Some(c) = self.crowd_center(30.0, true) {
                    for k in 0..5 {
                        let a = k as f64 / 5.0 * TAU;
                        host.effect(BET_CANNON, [c[0] + (a.cos() * 4.0) as f32, c[1] + 0.5, c[2] + (a.sin() * 4.0) as f32], 1.5);
                    }
                    let dmg = 300.0 * self.might();
                    self.blast(host, c, 12.0, dmg, Src::Evo(Evo::MassDestruction), true);
                    self.proc("NUKEBALL!".into());
                }
            }
            _ => {}
        }
    }

    /// Per-hit gun effects (evolution specials). The rank bonus is applied by the damage
    /// hook (API v5), not here.
    fn on_gun_hit_effects(&mut self, host: &Host, i: usize, delta: f32, gun: Up) {
        match gun {
            Up::Revolver if self.evolved(Evo::HighNoon) => {
                self.revolver_hits += 1;
                if self.revolver_hits % 6 == 0 {
                    let targets = self.priority_targets(self.pos, 40.0, 6);
                    let dmg = 60.0 * self.might();
                    for j in targets {
                        let p = self.enemies[j].pos;
                        host.lightning(self.eye, [p[0], p[1] + 1.0, p[2]], 0.6, 0.25);
                        self.hit(host, j, dmg * 3.0, Src::Evo(Evo::HighNoon), true);
                    }
                    self.proc("High Noon: Dead-Eye!".into());
                }
            }
            Up::Laser if self.evolved(Evo::StormCannon) => {
                let from = self.enemies[i].pos;
                let mut prev = from;
                let targets: Vec<usize> = self.near(from, 10.0).into_iter().filter(|&(j, _)| j != i).take(3).map(|(j, _)| j).collect();
                for j in targets {
                    let p = self.enemies[j].pos;
                    host.lightning([prev[0], prev[1] + 1.0, prev[2]], [p[0], p[1] + 1.0, p[2]], 1.0, 0.3);
                    self.hit(host, j, 30.0 * self.might(), Src::Evo(Evo::StormCannon), false);
                    prev = p;
                }
            }
            Up::Knife if self.evolved(Evo::Butcher) => {
                host.effect(BET_SHOCKWAVE, [self.pos[0], self.pos[1] + 0.5, self.pos[2]], 1.0);
                let dmg = (delta * 1.5).max(40.0);
                self.blast(host, self.pos, 6.0, dmg, Src::Evo(Evo::Butcher), false);
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------------ enemies
    /// Damage enemy i (our own damage: abilities, gun bonuses); records stats and a damage number.
    fn hit(&mut self, host: &Host, i: usize, amount: f32, src: Src, crit: bool) -> f32 {
        let e = &self.enemies[i];
        if e.hp <= 0.0 || amount <= 0.0 {
            return 0.0;
        }
        let (h, before, p) = (e.h, e.hp, e.pos);
        host.damage(h, amount);
        let after = host.health(h);
        let dealt = (before - after).max(0.0);
        let e = &mut self.enemies[i];
        e.hp = after;
        e.last_src = src;
        if dealt > 0.0 {
            self.stat(src, dealt);
            self.push_hit(p, dealt, if crit { 2.0 } else if matches!(src, Src::Gun(_)) { 0.0 } else { 1.0 });
        }
        dealt
    }
    fn push_hit(&mut self, p: [f32; 3], amount: f32, kind: f32) {
        if self.hits.len() < 40 {
            self.hits.push([p[0], p[1] + 1.4, p[2], amount, kind]);
        }
    }
    /// Damage everything within `radius` of `c` (bosses take a share if `bosses_full` is false).
    fn blast(&mut self, host: &Host, c: [f32; 3], radius: f32, dmg: f32, src: Src, bosses_full: bool) -> u32 {
        let mut n = 0;
        for (i, d) in self.near(c, radius) {
            let _ = d;
            let amount = if self.enemies[i].boss && !bosses_full { dmg * 0.5 } else { dmg };
            if self.hit(host, i, amount, src, false) > 0.0 {
                n += 1;
            }
        }
        n
    }
    /// Live enemies within `r` of `p`, nearest first (by index into `enemies`).
    fn near(&self, p: [f32; 3], r: f32) -> Vec<(usize, f32)> {
        let mut v: Vec<(usize, f32)> = self.enemies.iter().enumerate().filter(|(_, e)| e.hp > 0.0).map(|(i, e)| (i, dist(p, e.pos))).filter(|&(_, d)| d <= r).collect();
        v.sort_by(|a, b| a.1.total_cmp(&b.1));
        v
    }
    /// Up to n targets within r: bosses and elites first, then nearest.
    fn priority_targets(&self, p: [f32; 3], r: f32, n: usize) -> Vec<usize> {
        let mut v = self.near(p, r);
        v.sort_by(|a, b| {
            let (ea, eb) = (&self.enemies[a.0], &self.enemies[b.0]);
            ((eb.boss || eb.elite) as u8).cmp(&((ea.boss || ea.elite) as u8)).then(a.1.total_cmp(&b.1))
        });
        v.into_iter().take(n).map(|(i, _)| i).collect()
    }
    /// Center of the densest crowd within r (optionally only in front of the player).
    fn crowd_center(&self, r: f32, in_front: bool) -> Option<[f32; 3]> {
        let cand: Vec<usize> = self
            .near(self.pos, r)
            .into_iter()
            .filter(|&(i, _)| !in_front || self.rel_angle(self.enemies[i].pos).abs() < 50.0)
            .map(|(i, _)| i)
            .collect();
        let mut best = None;
        let mut best_n = 0;
        for &i in cand.iter().take(40) {
            let p = self.enemies[i].pos;
            let n = cand.iter().filter(|&&j| dist(p, self.enemies[j].pos) < 5.0).count();
            if n > best_n {
                best_n = n;
                best = Some(p);
            }
        }
        best
    }

    fn update_enemies(&mut self, host: &Host) {
        let mut i = 0;
        while i < self.enemies.len() {
            let h = self.enemies[i].h;
            let hp = host.health(h);
            if let Some(p) = host.position(h) {
                self.enemies[i].pos = p;
            }
            self.enemies[i].hp = hp;
            // stuck far away (spawned out of the map, or left behind): recycle
            let d = dist(self.enemies[i].pos, self.pos);
            if self.enemies[i].hp > 0.0 && !self.enemies[i].boss {
                if d > 80.0 {
                    if self.enemies[i].far_since < 0.0 {
                        self.enemies[i].far_since = self.time;
                    } else if self.time - self.enemies[i].far_since > 8.0 {
                        host.destroy(h);
                        self.enemies.swap_remove(i);
                        continue;
                    }
                } else {
                    self.enemies[i].far_since = -1.0;
                }
            }
            if self.enemies[i].hp <= 0.0 || !host.alive(h) {
                let e = self.enemies.swap_remove(i);
                self.on_kill(host, e);
                continue;
            }
            i += 1;
        }
    }

    fn on_kill(&mut self, host: &Host, e: Enemy) {
        host.release(e.h);
        let k = &KINDS[e.kind];
        self.kills += 1;
        if self.time - self.combo_t < 2.0 {
            self.combo += 1;
        } else {
            self.combo = 1;
        }
        self.combo_t = self.time;
        let mult = 1 + (self.combo / 10).min(7) as u64;
        self.score += k.score as u64 * mult * if e.elite { 3 } else { 1 } * if e.boss { 5 } else { 1 };
        let vamp = 0.4 * self.rank(Up::VampiricTouch) as f32 + if e.last_src == Src::Gun(Up::Knife) && self.evolved(Evo::Butcher) { 3.0 } else { 0.0 };
        if vamp > 0.0 {
            host.player_heal(vamp, self.heal_cap());
        }
        // XP gem (elites are worth 5, gold rounds 3)
        let mut xp = k.xp * self.xp_mul() * if e.elite { 5.0 } else { 1.0 };
        if e.last_src == Src::Gun(Up::TommyGun) && self.evolved(Evo::Typewriter) {
            self.typewriter_kills += 1;
            if self.typewriter_kills % 5 == 0 {
                xp *= 3.0;
                self.gold += 1.0;
            }
        }
        if !e.boss {
            self.drop_gem(host, e.pos, xp);
        } else {
            self.xp += xp;
        }
        // drops
        let luck = 1.0 + self.luck();
        let r = self.rand() as f32;
        if e.boss {
            let items = self.chest_items.max(1);
            self.spawn_drop(host, e.pos, DropKind::Chest(items));
            self.banner(host, &format!("{} destroyed! It dropped a chest", k.name), Some("Sounds\\Player\\Quotes\\Who_is_next.wav"));
        } else if e.elite {
            host.spawn_item(HEALTH_ITEM, HIT_MEDIUM, up(e.pos, 0.5));
            self.drop_ammo(host, e.pos);
        } else if r < 0.012 * luck {
            host.spawn_item(HEALTH_ITEM, HIT_SMALL, up(e.pos, 0.5));
        } else if r < 0.035 * luck {
            self.drop_ammo(host, e.pos);
        }
        if (self.rand() as f32) < 0.06 * luck {
            self.gold += 1.0 + (self.rand() * 2.0) as f32;
        }
        // kill effects
        match e.last_src {
            Src::Gun(Up::DoubleShotgun) if self.evolved(Evo::Apocalypse) => {
                host.effect(BET_ROCKET, up(e.pos, 1.0), 1.0);
                let dmg = (0.3 * e.max_hp).max(40.0) * self.might();
                self.blast(host, e.pos, 6.0 * self.area(), dmg, Src::Evo(Evo::Apocalypse), false);
            }
            Src::Gun(Up::Shotgun) if self.evolved(Evo::Pharaoh) => {
                host.effect(BET_ROCKET, up(e.pos, 0.8), 0.6);
                self.blast(host, e.pos, 4.0 * self.area(), 60.0 * self.might(), Src::Evo(Evo::Pharaoh), false);
                host.spawn_item(ARMOR_ITEM, ARIT_SHARD, up(e.pos, 0.5));
            }
            _ => {}
        }
        if self.final_boss == Some(e.h) {
            self.final_boss = None;
            self.victory = true;
            self.achieve(host, "victory");
            self.end(host, true);
        }
    }

    fn drop_ammo(&mut self, host: &Host, p: [f32; 3]) {
        let ait = Up::from_weapon(self.weapon).and_then(|g| g.ammo()).map_or(2, |(_, a)| a);
        host.spawn_item(AMMO_ITEM, ait, up(p, 0.5));
    }

    // ------------------------------------------------------------------ gems and drops
    fn drop_gem(&mut self, host: &Host, p: [f32; 3], xp: f32) {
        if self.gems.len() >= MAX_GEMS {
            let i = (self.rand() * self.gems.len() as f64) as usize % self.gems.len();
            self.gems[i].xp += xp; // merge into an existing gem
            return;
        }
        let q = up(p, 0.4);
        let h = if xp >= 10.0 { host.spawn_item(HEALTH_ITEM, HIT_PILL, q) } else { host.spawn_item(ARMOR_ITEM, ARIT_SHARD, q) };
        match h {
            Some(h) => self.gems.push(Gem { h, xp, pos: q, pull: false }),
            None => self.xp += xp,
        }
    }
    fn update_gems(&mut self, host: &Host, dt: f64) {
        let radius = 3.5 * (1.0 + 0.3 * self.rank(Up::Scanner) as f32) * (1.0 + 0.2 * self.meta.magnet);
        let target = [self.eye[0], self.eye[1] - 0.7, self.eye[2]];
        let mut collected = 0.0;
        let mut i = 0;
        while i < self.gems.len() {
            let g = &mut self.gems[i];
            let gone = !host.exists(g.h); // touched by the player: the engine picked it up
            if !gone && !g.pull {
                let (dx, dz) = (g.pos[0] - self.pos[0], g.pos[2] - self.pos[2]);
                if (dx * dx + dz * dz).sqrt() < radius && (g.pos[1] - self.pos[1]).abs() < 4.0 {
                    g.pull = true;
                }
            }
            let mut take = gone;
            if !gone && g.pull {
                let d = sub3(target, g.pos);
                let l = len3(d);
                if l < 1.2 {
                    take = true;
                } else {
                    let step = (16.0 * dt as f32).min(l);
                    g.pos = add3(g.pos, scale3(d, step / l));
                    host.set_position(g.h, g.pos);
                }
            }
            if take {
                collected += g.xp;
                let h = g.h;
                if !gone {
                    host.destroy(h);
                } else {
                    host.release(h);
                }
                self.gems.swap_remove(i);
                continue;
            }
            i += 1;
        }
        if collected > 0.0 {
            self.xp += collected;
            if self.time - self.sound_t > 0.09 {
                self.sound_t = self.time;
                host.sound("Sounds\\Items\\ArmourShard.wav", 0.35);
            }
        }
    }
    fn spawn_drop(&mut self, host: &Host, p: [f32; 3], kind: DropKind) {
        let h = match kind {
            DropKind::Chest(_) => host.spawn_item(HEALTH_ITEM, HIT_SUPER, up(p, 0.5)),
            DropKind::Relic => host.spawn_item(ARMOR_ITEM, ARIT_MEDIUM, up(p, 0.5)),
        };
        if let Some(h) = h {
            host.effect(BET_TELEPORT, up(p, 0.5), 1.5);
            self.drops.push(Drop { h, kind, pos: p });
        }
    }
    fn update_drops(&mut self, host: &Host) {
        let mut i = 0;
        while i < self.drops.len() {
            if host.exists(self.drops[i].h) {
                i += 1;
                continue;
            }
            let d = self.drops.swap_remove(i);
            host.release(d.h);
            match d.kind {
                DropKind::Chest(n) => self.open_chest(host, n),
                DropKind::Relic => {
                    let p = [Power::SeriousDamage, Power::Invulnerability, Power::SeriousSpeed, Power::Invisibility][(self.rand() * 4.0) as usize % 4];
                    self.add_power(host, p, p.secs());
                    self.banner(host, &format!("{}!", p.name().to_uppercase()), Some("Sounds\\Player\\Quotes\\Groovy.wav"));
                }
            }
        }
    }

    // ------------------------------------------------------------------ power-ups
    fn add_power(&mut self, host: &Host, p: Power, secs: f64) {
        let until = self.time + secs;
        match self.powers.iter_mut().find(|(q, _)| *q == p) {
            Some((_, u)) => *u = u.max(until),
            None => self.powers.push((p, until)),
        }
        match p {
            Power::Invulnerability => host.shell_execute("cht_bGod = 1"),
            Power::Invisibility => host.shell_execute("cht_bInvisible = 1"),
            _ => {}
        }
    }
    fn update_powers(&mut self, host: &Host) {
        let now = self.time;
        let expired: Vec<Power> = self.powers.iter().filter(|(_, u)| now >= *u).map(|(p, _)| *p).collect();
        self.powers.retain(|(_, u)| now < *u);
        for p in expired {
            match p {
                Power::Invulnerability => host.shell_execute("cht_bGod = 0"),
                Power::Invisibility => host.shell_execute("cht_bInvisible = 0"),
                _ => {}
            }
        }
        let speed = CHARACTERS[self.character].speed * (1.0 + 0.10 * self.rank(Up::FleetFoot) as f32) * if self.power(Power::SeriousSpeed) { 1.6 } else { 1.0 };
        if (speed - self.speed_set).abs() > 0.001 {
            self.speed_set = speed;
            host.shell_execute(&format!("cht_fTranslationMultiplier = {speed:.3}"));
        }
    }

    // ------------------------------------------------------------------ director
    fn director(&mut self, host: &Host, t: f64) {
        let diff = DIFFICULTIES[self.difficulty];
        let ph = PHASES.iter().rev().find(|p| t >= p.from_s).unwrap_or(&PHASES[0]);
        let minutes = (t / 60.0) as f32;
        let endless = if t > RUN_S { 1.0 + ((t - RUN_S) / 90.0) as f32 } else { 1.0 };
        let min_field = ((ph.min_field as f32 * diff.2 * endless.sqrt()) as usize).min(self.max_alive);
        let hp_mul = diff.1 * (1.0 + 0.06 * minutes) * endless;
        let alive = self.enemies.len();
        // keep the field filled; extra spawns on the interval
        if alive < self.max_alive && (alive < min_field || t >= self.next_spawn) {
            self.next_spawn = t + ph.interval / diff.2 as f64;
            let n = if alive < min_field { (min_field - alive).min(4) } else { 1 + (minutes as usize / 5).min(2) };
            for _ in 0..n {
                let k = self.pick(ph.mix);
                let elite = t >= 180.0 && self.rand() < 0.04;
                self.spawn(host, k, hp_mul, elite, false, None);
            }
        }
        // swarm
        if t < self.flood_until && t >= self.flood_next && self.enemies.len() < self.max_alive + 30 {
            self.flood_next = t + 0.25;
            for _ in 0..3 {
                self.spawn(host, K_HOPPER, diff.1, false, false, None);
            }
        }
        // stampede after its warning scream
        if let Some((at, yaw)) = self.stampede {
            if t >= at {
                self.stampede = None;
                let n = 16 + (minutes as usize).min(14);
                for i in 0..n {
                    let row = (i / 6) as f32;
                    let col = (i % 6) as f64 - 2.5;
                    let a = yaw + col * 0.07;
                    let d = 34.0 + row * 3.0;
                    let p = [self.pos[0] + (a.cos() as f32) * d, self.pos[1] + 1.0, self.pos[2] + (a.sin() as f32) * d];
                    self.spawn_at(host, K_KAMI, p, hp_mul, false, false);
                }
            }
        }
        // scripted events
        while self.next_event < EVENTS.len() && t >= EVENTS[self.next_event].0 && !(self.endless && EVENTS[self.next_event].1 == Event::Final) {
            let ev = EVENTS[self.next_event].1;
            self.next_event += 1;
            self.event(host, ev, hp_mul);
        }
        if self.endless && t >= self.next_spawn + 60.0 {
            self.next_spawn = t;
        }
    }

    fn event(&mut self, host: &Host, ev: Event, hp_mul: f32) {
        let yaw = self.view_yaw() + std::f64::consts::PI + (self.rand() - 0.5) * 2.0; // mostly from behind
        match ev {
            Event::Flood => {
                self.flood_until = self.time + 12.0;
                let name = if self.avail[K_HOPPER] { "Marsh Hoppers" } else { "Beheaded" };
                self.banner(host, &format!("NETRICSA: a swarm of {name} is closing in!"), Some("Sounds\\Player\\Quotes\\I_smell_an_ambush.wav"));
            }
            Event::MiniBoss(i) => {
                let (kinds, mul, stretch, items) = MINI_BOSSES[i as usize];
                self.chest_items = items;
                let mut names = Vec::new();
                for (j, &k) in kinds.iter().enumerate() {
                    let a = yaw + j as f64 * 0.5;
                    let p = [self.pos[0] + (a.cos() as f32) * 28.0, self.pos[1] + 1.0, self.pos[2] + (a.sin() as f32) * 28.0];
                    let k = self.resolve(k);
                    names.push(KINDS[k].name);
                    self.spawn_boss(host, k, p, hp_mul * mul, stretch);
                }
                self.banner(host, &format!("NETRICSA: hostile {} approaching. Recommend: everything you've got", names.join(" + ")), Some("Models\\Enemies\\Werebull\\Sounds\\Sight.wav"));
            }
            Event::Relic => {
                let a = self.view_yaw() + (self.rand() - 0.5) * 1.5;
                let d = 14.0 + self.rand() as f32 * 8.0;
                let p = [self.pos[0] + (a.cos() as f32) * d, self.pos[1], self.pos[2] + (a.sin() as f32) * d];
                self.spawn_drop(host, p, DropKind::Relic);
                self.banner(host, "NETRICSA: Sirian relic detected nearby: grab it for a Serious power-up", Some("Sounds\\Misc\\Teleport.wav"));
            }
            Event::Stampede => {
                self.stampede = Some((self.time + 2.5, yaw));
                let p = [self.pos[0] + (yaw.cos() as f32) * 30.0, self.pos[1], self.pos[2] + (yaw.sin() as f32) * 30.0];
                let a = self.rel_angle(p);
                host.ui_post(&format!(r#"{{"type":"warn","angle":{a:.0},"text":"KAMIKAZE STAMPEDE!"}}"#));
                self.banner(host, "BEHEADED KAMIKAZE STAMPEDE! Listen for the screams", Some("Models\\Enemies\\Headman\\Sounds\\AttackKamikaze.wav"));
            }
            Event::BullRun => {
                let n = 6 + (self.time / 300.0) as usize;
                let side = [-(yaw.sin() as f32), (yaw.cos() as f32)];
                for i in 0..n {
                    let off = (i as f32 - n as f32 / 2.0) * 3.5;
                    let p = [self.pos[0] + (yaw.cos() as f32) * 32.0 + side[0] * off, self.pos[1] + 1.0, self.pos[2] + (yaw.sin() as f32) * 32.0 + side[1] * off];
                    self.spawn_at(host, K_BULL, p, hp_mul, false, false);
                }
                let p = [self.pos[0] + (yaw.cos() as f32) * 30.0, self.pos[1], self.pos[2] + (yaw.sin() as f32) * 30.0];
                let a = self.rel_angle(p);
                host.ui_post(&format!(r#"{{"type":"warn","angle":{a:.0},"text":"WEREBULL RUN!"}}"#));
                self.banner(host, "A Werebull herd is charging. Dodge!", Some("Models\\Enemies\\Werebull\\Sounds\\Sight.wav"));
            }
            Event::KleerRain => {
                let n = 12 + (self.time / 120.0) as usize;
                for i in 0..n {
                    let a = i as f64 / n as f64 * TAU;
                    let p = [self.pos[0] + (a.cos() as f32) * 9.0, self.pos[1] + 5.0, self.pos[2] + (a.sin() as f32) * 9.0];
                    self.spawn_at(host, K_KLEER, p, hp_mul, false, false);
                }
                self.banner(host, "It's raining Kleers! You're surrounded", Some("Models\\Enemies\\Boneman\\Sounds\\Sight.wav"));
            }
            Event::Final => {
                let k = if self.avail[K_GOLEMB] { K_GOLEMB } else { K_ARACHG };
                let (mul, stretch) = if k == K_GOLEMB { (8.0, 1.3) } else { (20.0, 2.2) };
                let p = [self.pos[0] + (yaw.cos() as f32) * 30.0, self.pos[1] + 1.0, self.pos[2] + (yaw.sin() as f32) * 30.0];
                self.chest_items = 5;
                self.final_boss = self.spawn_boss(host, k, p, hp_mul * mul, stretch);
                for j in 0..2 {
                    let a = yaw + if j == 0 { 0.4 } else { -0.4 };
                    let q = [self.pos[0] + (a.cos() as f32) * 30.0, self.pos[1] + 1.0, self.pos[2] + (a.sin() as f32) * 30.0];
                    self.spawn_at(host, K_BIOB, q, hp_mul, true, false);
                }
                self.banner(host, "NETRICSA: Mental's champion has arrived. Destroy it to win!", Some("Sounds\\Player\\Quotes\\Lets_get_serious.wav"));
            }
        }
    }

    fn resolve(&self, k: usize) -> usize {
        if self.avail[k] {
            k
        } else {
            let f = fallback(k);
            if self.avail[f] { f } else { K_FIRE }
        }
    }
    fn pick(&mut self, mix: &[(usize, u32)]) -> usize {
        let total: u32 = mix.iter().map(|m| m.1).sum();
        let mut x = (self.rand() * total as f64) as u32;
        for &(k, w) in mix {
            if x < w {
                return k;
            }
            x -= w;
        }
        mix[0].0
    }
    /// Spawn on a ring 18-32 m away, mostly outside the view (first person: no 360-degree view).
    fn spawn(&mut self, host: &Host, k: usize, hp_mul: f32, elite: bool, boss: bool, at: Option<[f32; 3]>) -> Option<i32> {
        let p = at.unwrap_or_else(|| {
            let yaw = self.view_yaw();
            let a = if self.rand() < 0.7 { yaw + 1.0 + self.rand() * (TAU - 2.0) } else { yaw + (self.rand() - 0.5) * 2.0 };
            let d = 18.0 + self.rand() as f32 * 14.0;
            let k2 = self.resolve(k);
            let fly = matches!(k2, K_GNAAR | K_GNAAR2 | K_HARPY);
            [self.pos[0] + (a.cos() as f32) * d, self.pos[1] + if fly { 3.0 } else { 1.0 }, self.pos[2] + (a.sin() as f32) * d]
        });
        self.spawn_at(host, k, p, hp_mul, elite, boss)
    }
    fn spawn_at(&mut self, host: &Host, k: usize, p: [f32; 3], hp_mul: f32, elite: bool, boss: bool) -> Option<i32> {
        let k = self.resolve(k);
        let kind = &KINDS[k];
        let mut o = EnemyOpts { variant: kind.variant, hp_mul, ..Default::default() };
        if elite {
            o.hp_mul *= 6.0;
            o.stretch = 1.35;
            o.glow = 0x9010_0000;
        }
        o.boss = boss;
        let h = host.spawn_enemy(kind.class, p, o)?;
        let hp = host.health(h);
        let max_hp = host.max_health(h).max(hp);
        self.enemies.push(Enemy { h, kind: k, hp, max_hp, pos: p, elite, boss, last_src: Src::Gun(Up::Knife), far_since: -1.0 });
        Some(h)
    }
    fn spawn_boss(&mut self, host: &Host, k: usize, p: [f32; 3], hp_mul: f32, stretch: f32) -> Option<i32> {
        let kind = &KINDS[k];
        let o = EnemyOpts { variant: kind.variant, hp_mul, stretch, glow: 0x8060_0000, boss: true };
        let h = host.spawn_enemy(kind.class, p, o)?;
        host.effect(BET_TELEPORT, p, 3.0);
        let hp = host.health(h);
        self.enemies.push(Enemy { h, kind: k, hp, max_hp: host.max_health(h).max(hp), pos: p, elite: true, boss: true, last_src: Src::Gun(Up::Knife), far_since: -1.0 });
        Some(h)
    }

    // ------------------------------------------------------------------ abilities
    /// The twin Schofields fire at the nearest visible enemy on their own (Vampire Survivors style).
    fn auto_fire(&mut self, host: &Host) {
        let r = self.rank(Up::Revolver);
        if r < 1 || host.page_option("se1SurvivorsAutofire") < 0.5 {
            return;
        }
        // sight rays only when a shot is due (this runs every frame)
        if self.cooldowns.iter().any(|(u, next)| *u == Up::Revolver && self.time < *next) {
            return;
        }
        // nearest visible enemy within 35 m (check at most 6, nearest first)
        let cands: Vec<usize> = self.near(self.eye, 35.0).into_iter().take(6).map(|(i, _)| i).collect();
        let target = cands.into_iter().find(|&i| host.ray(self.eye, [self.enemies[i].pos[0], self.enemies[i].pos[1] + 1.0, self.enemies[i].pos[2]], false).is_none());
        let Some(i) = target else { return }; // no target: no shot, no cooldown spent
        if !self.ready(Up::Revolver, data::autofire_interval(r)) {
            return;
        }
        let chest = [self.enemies[i].pos[0], self.enemies[i].pos[1] + 1.0, self.enemies[i].pos[2]];
        // alternate left/right muzzle
        let side = self.autofire_side as f32 * 2.0 - 1.0; // -1 left, +1 right
        self.autofire_side = (self.autofire_side + 1) % 2;
        let muzzle = [self.eye[0] + 0.25 * side, self.eye[1] - 0.2, self.eye[2]];
        host.lightning(muzzle, chest, 0.25, 0.06);
        host.sound("Models\\Weapons\\Colt\\Sounds\\Fire.wav", 0.6);
        // same scaling as the manual revolver hit: base 10 × gun multiplier, crit ×2
        let dmg = 10.0 * self.might() * (1.0 + 0.20 * (r - 1) as f32);
        let crit = (self.rand() as f32) < self.luck() * 0.5 + 0.05 * r as f32;
        self.hit(host, i, dmg * if crit { 2.0 } else { 1.0 }, Src::Gun(Up::Revolver), crit);
    }
    fn abilities(&mut self, host: &Host) {
        self.auto_fire(host);
        let p = self.pos;
        let might = self.might();
        let area = self.area();
        let feet = [p[0], p[1] + 0.15, p[2]];
        let r = self.rank(Up::Consecration);
        if r > 0 && self.ready(Up::Consecration, 0.5) {
            let radius = (4.0 + 1.2 * r as f32) * area;
            let dmg = (10.0 + 8.0 * r as f32) * 0.5 * might;
            self.blast(host, p, radius, dmg, Src::Ability(Up::Consecration), true);
            if ((self.time * 2.0) as i64) % 2 == 0 {
                host.effect(BET_CANNONSHOCKWAVE, feet, radius * 0.3);
            }
        }
        let r = self.rank(Up::ChainLightning);
        if r > 0 && self.ready(Up::ChainLightning, (2.4 - 0.2 * r as f64).max(1.0)) {
            if let Some(&first) = self.priority_targets(p, 25.0, 1).first() {
                let dmg = (25.0 + 15.0 * r as f32) * might;
                let mut hit = vec![first];
                let mut from = self.eye;
                let mut cur = first;
                for _ in 0..(3 + r) {
                    let q = self.enemies[cur].pos;
                    host.lightning(from, [q[0], q[1] + 1.0, q[2]], 2.0, 0.35);
                    self.hit(host, cur, dmg, Src::Ability(Up::ChainLightning), false);
                    from = [q[0], q[1] + 1.0, q[2]];
                    match self.near(q, 10.0).into_iter().find(|(j, _)| !hit.contains(j)) {
                        Some((j, _)) => {
                            hit.push(j);
                            cur = j;
                        }
                        None => break,
                    }
                }
            }
        }
        let r = self.rank(Up::Missiles);
        if r > 0 && self.ready(Up::Missiles, 1.4) {
            let targets: Vec<usize> = self.near(p, 30.0).into_iter().take(1 + r as usize).map(|(i, _)| i).collect();
            for i in targets {
                let q = self.enemies[i].pos;
                host.lightning(self.eye, [q[0], q[1] + 1.0, q[2]], 0.7, 0.25);
                self.hit(host, i, (16.0 + 8.0 * r as f32) * might, Src::Ability(Up::Missiles), false);
            }
        }
        let r = self.rank(Up::ArcaneExplosion);
        if r > 0 && self.ready(Up::ArcaneExplosion, (6.0 - 0.6 * r as f64).max(2.5)) {
            let radius = (7.0 + r as f32) * area;
            if !self.near(p, radius).is_empty() {
                host.effect(BET_CANNONSHOCKWAVE, [p[0], p[1] + 1.0, p[2]], radius * 0.3);
                host.effect(BET_SHOCKWAVE, [p[0], p[1] + 0.5, p[2]], 1.0);
                let n = self.blast(host, p, radius, (40.0 + 20.0 * r as f32) * might, Src::Ability(Up::ArcaneExplosion), true);
                self.proc(format!("Arcane Explosion hits {n}"));
            }
        }
        let r = self.rank(Up::RainOfFire);
        if r > 0 && self.ready(Up::RainOfFire, (5.0 - 0.4 * r as f64).max(2.5)) {
            if let Some(c) = self.crowd_center(35.0, false) {
                for k in 0..(2 + r) {
                    let a = self.rand() * TAU;
                    let d = if k == 0 { 0.0 } else { 1.0 + self.rand() as f32 * 3.0 };
                    let q = [c[0] + (a.cos() as f32) * d, c[1] + 0.3, c[2] + (a.sin() as f32) * d];
                    host.effect(BET_ROCKET, q, 1.0);
                    self.blast(host, q, 4.0 * area, (50.0 + 20.0 * r as f32) * might, Src::Ability(Up::RainOfFire), true);
                }
            }
        }
        let r = self.rank(Up::SeriousBomb);
        if r > 0 && self.ready(Up::SeriousBomb, (55.0 - 6.0 * r as f64).max(25.0)) {
            host.effect(BET_BOMB, [p[0], p[1] + 1.5, p[2]], 3.0);
            for k in 0..6 {
                let a = k as f64 / 6.0 * TAU;
                host.effect(BET_CANNON, [p[0] + (a.cos() as f32) * 10.0, p[1] + 0.5, p[2] + (a.sin() as f32) * 10.0], 1.5);
            }
            let mut n = 0;
            for (i, _) in self.near(p, 30.0) {
                let dmg = if self.enemies[i].boss { 0.2 * self.enemies[i].max_hp } else { 1.0e6 };
                if self.hit(host, i, dmg, Src::Ability(Up::SeriousBomb), false) > 0.0 {
                    n += 1;
                }
            }
            self.flash = true;
            self.proc(format!("SERIOUS BOMB! {n} vaporized"));
        }
        // Lead Hurricane: a bullet storm while the minigun fires
        if self.evolved(Evo::Hurricane) && self.weapon == 7 && self.time < self.firing_until && self.time >= self.hurricane_t {
            self.hurricane_t = self.time + 0.25;
            self.blast(host, p, 8.0 * area, 10.0 * might, Src::Evo(Evo::Hurricane), true);
            host.player_heal(0.5, self.heal_cap());
        }
    }

    fn passives(&mut self, host: &Host, dt: f64) {
        let regen = 0.5 * self.rank(Up::Regeneration) as f32 + 0.2 * self.meta.recovery;
        if regen > 0.0 {
            host.player_heal(regen * dt as f32, self.heal_cap());
        }
        let r = self.rank(Up::Kevlar);
        if r > 0 {
            host.armor(0.6 * r as f32 * dt as f32, 50.0 + 25.0 * r as f32);
        }
    }

    // ------------------------------------------------------------------ levels, cards, chests
    fn level_up(&mut self, host: &Host) {
        self.xp -= self.next_xp;
        self.level += 1;
        self.next_xp = xp_for_level(self.level);
        self.offer = self.roll_offer();
        self.state = State::Offer;
        host.set_pause(true);
        host.sound("Sounds\\Misc\\chimes.wav", 0.8);
        self.post_offer(host);
    }
    fn can_take_new(&self, u: Up) -> bool {
        match u.cat() {
            Cat::Gun => u != Up::Cannon || self.full_data,
            Cat::Ability => self.ranks.iter().filter(|(x, _)| x.cat() == Cat::Ability).count() < ABILITY_SLOTS,
            Cat::Passive => self.ranks.iter().filter(|(x, _)| x.cat() == Cat::Passive).count() < PASSIVE_SLOTS,
        }
    }
    fn roll_offer(&mut self) -> Vec<Card> {
        let mut pool: Vec<(Up, u32)> = ALL
            .iter()
            .copied()
            .filter(|&u| {
                let r = self.rank(u);
                r < MAX_RANK && (r > 0 || self.can_take_new(u))
            })
            .map(|u| (u, if self.rank(u) > 0 { 3 } else { 2 }))
            .collect();
        let n = 3 + ((self.rand() as f32) < self.luck()) as usize;
        let mut cards = Vec::new();
        while cards.len() < n && !pool.is_empty() {
            let total: u32 = pool.iter().map(|p| p.1).sum();
            let mut x = (self.rand() * total as f64) as u32;
            let mut idx = 0;
            for (j, p) in pool.iter().enumerate() {
                if x < p.1 {
                    idx = j;
                    break;
                }
                x -= p.1;
            }
            cards.push(Card::Up(pool.swap_remove(idx).0));
        }
        if cards.is_empty() {
            cards = vec![Card::Gold, Card::Chicken];
        }
        cards
    }
    fn answer_offer(&mut self, host: &Host, v: i32) {
        match v {
            0..=3 => {
                if let Some(&c) = self.offer.get(v as usize) {
                    self.take(host, c, true);
                    self.after_offer(host);
                }
            }
            10 if self.rerolls > 0 => {
                self.rerolls -= 1;
                self.offer = self.roll_offer();
                self.post_offer(host);
            }
            11 if self.skips > 0 => {
                self.skips -= 1;
                self.xp += 0.0;
                self.after_offer(host);
            }
            _ => {}
        }
    }
    fn after_offer(&mut self, host: &Host) {
        self.offer.clear();
        if self.xp >= self.next_xp {
            self.level_up(host); // several levels at once: next offer
        } else {
            self.resume(host);
        }
    }
    fn take(&mut self, host: &Host, c: Card, announce: bool) {
        let u = match c {
            Card::Gold => {
                self.gold += 25.0;
                return;
            }
            Card::Chicken => {
                host.player_heal(30.0, self.heal_cap());
                return;
            }
            Card::Up(u) => u,
        };
        let r = self.rank(u) + 1;
        match self.ranks.iter_mut().find(|(x, _)| *x == u) {
            Some((_, rank)) => *rank = r,
            None => self.ranks.push((u, r)),
        }
        if u.cat() == Cat::Gun && r == 1 && u.weapon_item() > 0 {
            host.give_weapon(u.weapon_item());
        }
        if u == Up::Revolver && r == 1 {
            host.give_weapon(1); // the second Schofield: every run starts dual wielding
        }
        if announce {
            self.proc(format!("{} {}", u.name(), roman(r)));
            host.log(&format!("se1mod: survivors took {} (rank {r})", u.name()));
        }
    }
    fn open_chest(&mut self, host: &Host, n: u32) {
        let mut items = Vec::new();
        for _ in 0..n {
            // an evolution if one is ready (after 10:00), else a rank-up of something owned
            let evo = EVOS.iter().find(|(e, g, pair)| {
                (self.time >= 600.0 || self.endless) && !self.evolved(*e) && self.rank(*g) >= MAX_RANK && self.rank(*pair) > 0
            });
            if let Some(&(e, _, _)) = evo {
                self.evolved.push(e);
                items.push(format!(r#"{{"name":"{}","desc":"{}","evo":true}}"#, e.name(), e.describe()));
                self.achieve(host, "evolve");
                continue;
            }
            let owned: Vec<Up> = self.ranks.iter().filter(|(_, r)| *r < MAX_RANK).map(|(u, _)| *u).collect();
            if owned.is_empty() {
                self.gold += 50.0;
                items.push(r#"{"name":"50 gold","desc":"Nothing left to upgrade","evo":false}"#.to_string());
                continue;
            }
            let u = owned[(self.rand() * owned.len() as f64) as usize % owned.len()];
            self.take(host, Card::Up(u), false);
            let r = self.rank(u);
            items.push(format!(r#"{{"name":"{} {}","desc":"{}","evo":false}}"#, u.name(), roman(r), u.describe(r).replace('"', "'")));
        }
        let gold = [0.0, 25.0, 0.0, 75.0, 0.0, 200.0][n.min(5) as usize];
        self.gold += gold;
        self.state = State::Chest;
        host.set_pause(true);
        host.sound(if items.iter().any(|s| s.contains("\"evo\":true")) { "Sounds\\Player\\Quotes\\Yeah_baby!!!.wav" } else { "Sounds\\Misc\\chimes.wav" }, 1.0);
        host.ui_post(&format!(r#"{{"type":"chest","items":[{}],"gold":{gold:.0}}}"#, items.join(",")));
    }

    fn end(&mut self, host: &Host, victory: bool) {
        self.dead_posted = true;
        self.state = State::End;
        host.set_pause(true);
        let time_bonus = if victory { ((25.0 * 60.0 - self.time).max(0.0) * 100.0) as u64 } else { 0 };
        self.score += time_bonus;
        let gold = ((self.gold + self.kills as f32 / 8.0 + if victory { 300.0 } else { 0.0 }) * self.gold_mul()).round();
        let mut stats = self.stats.clone();
        stats.sort_by(|a, b| b.1.total_cmp(&a.1));
        let dmg: Vec<String> = stats.iter().take(12).map(|(n, v)| format!(r#"["{n}",{v:.0}]"#)).collect();
        let build: Vec<String> = self.ranks.iter().map(|(u, r)| format!(r#""{} {}""#, u.name(), roman(*r))).chain(self.evolved.iter().map(|e| format!(r#""{}""#, e.name()))).collect();
        host.ui_post(&format!(
            r#"{{"type":"end","victory":{},"time":{:.0},"level":{},"kills":{},"score":{},"timeBonus":{},"gold":{},"dmg":[{}],"build":[{}],"character":"{}","difficulty":{}}}"#,
            victory, self.time, self.level, self.kills, self.score, time_bonus, gold, dmg.join(","), build.join(","), CHARACTERS[self.character].name, self.difficulty
        ));
        if victory {
            host.sound("Sounds\\Player\\Quotes\\Yeah_baby!!!.wav", 1.0);
        }
    }

    // ------------------------------------------------------------------ page messages
    fn post_offer(&self, host: &Host) {
        let cards: Vec<String> = self
            .offer
            .iter()
            .map(|c| match *c {
                Card::Up(u) => {
                    let r = self.rank(u) + 1;
                    let evo = EVOS.iter().find(|(_, g, p)| *g == u || *p == u).map(|(e, g, p)| {
                        let other = if *g == u { *p } else { *g };
                        format!("Evolves into {} with {}", e.name(), other.name())
                    });
                    let cat = match u.cat() {
                        Cat::Gun => "gun",
                        Cat::Ability => "ability",
                        Cat::Passive => "passive",
                    };
                    format!(
                        r#"{{"id":"{}","name":"{}","cat":"{}","rank":{},"desc":"{}","evo":"{}"}}"#,
                        u.id(), u.name(), cat, r, u.describe(r).replace('"', "'"), evo.unwrap_or_default()
                    )
                }
                Card::Gold => r#"{"id":"gold","name":"Sirian Coins","cat":"misc","rank":1,"desc":"25 gold","evo":""}"#.to_string(),
                Card::Chicken => r#"{"id":"chicken","name":"Roast Chicken","cat":"misc","rank":1,"desc":"Heal 30","evo":""}"#.to_string(),
            })
            .collect();
        host.ui_post(&format!(r#"{{"type":"offer","level":{},"cards":[{}],"rerolls":{},"skips":{}}}"#, self.level, cards.join(","), self.rerolls, self.skips));
    }
    fn post_fx(&mut self, host: &Host) {
        let hits: Vec<String> = self.hits.iter().map(|h| format!("[{:.1},{:.1},{:.1},{:.0},{:.0}]", h[0], h[1], h[2], h[3], h[4])).collect();
        host.ui_post(&format!(
            r#"{{"type":"fx","cam":[{:.2},{:.2},{:.2},{:.3},{:.3},{:.3}],"hits":[{}],"flash":{}}}"#,
            self.eye[0], self.eye[1], self.eye[2], self.view[0], self.view[1], self.view[2], hits.join(","), self.flash
        ));
        self.hits.clear();
        self.flash = false;
    }
    fn post_hud(&self, host: &Host) {
        let list = |cat: Cat| -> String {
            let v: Vec<String> = self
                .ranks
                .iter()
                .filter(|(u, _)| u.cat() == cat)
                .map(|(u, r)| {
                    let evo = EVOS.iter().find(|(e, g, _)| *g == *u && self.evolved(*e)).map(|(e, _, _)| e.name()).unwrap_or("");
                    format!(r#"{{"id":"{}","name":"{}","rank":{},"evo":"{}"}}"#, u.id(), u.name(), r, evo)
                })
                .collect();
            v.join(",")
        };
        let boss = self
            .enemies
            .iter()
            .filter(|e| e.boss && e.hp > 0.0)
            .max_by(|a, b| a.max_hp.total_cmp(&b.max_hp))
            .map(|e| format!(r#"{{"name":"{}","hp":{:.0},"max":{:.0}}}"#, KINDS[e.kind].name, e.hp, e.max_hp))
            .unwrap_or_else(|| "null".into());
        let mut arrows: Vec<String> = self
            .drops
            .iter()
            .map(|d| {
                let label = if matches!(d.kind, DropKind::Chest(_)) { "chest" } else { "relic" };
                format!(r#"{{"a":{:.0},"d":{:.0},"label":"{label}"}}"#, self.rel_angle(d.pos), dist(d.pos, self.pos))
            })
            .collect();
        arrows.extend(self.enemies.iter().filter(|e| e.boss && e.hp > 0.0).map(|e| format!(r#"{{"a":{:.0},"d":{:.0},"label":"boss"}}"#, self.rel_angle(e.pos), dist(e.pos, self.pos))));
        // threat sectors: nearby enemies outside the view, grouped by direction
        let mut sectors: [f32; 8] = [0.0; 8];
        let mut sector_n: [usize; 8] = [0; 8];
        let mut sector_d: [f32; 8] = [f32::MAX; 8];
        for e in &self.enemies {
            if e.hp <= 0.0 { continue; }
            let a = self.rel_angle(e.pos);
            let d = dist(e.pos, self.pos);
            let r = ranged(e.kind);
            let range = if r { 50.0 } else { 20.0 };
            if a.abs() <= 45.0 || d >= range { continue; }
            let w = (1.0 - d / range) * if r { 1.0 } else { 0.8 } * if e.boss || e.elite { 1.5 } else { 1.0 };
            let s = ((a / 45.0).round() as i32).rem_euclid(8) as usize; // sector centred on s·45°
            sectors[s] += w;
            sector_n[s] += 1;
            sector_d[s] = sector_d[s].min(d);
        }
        let threats: Vec<String> = (0..8)
            .filter(|&s| sector_n[s] > 0)
            .map(|s| {
                let centre = if s > 4 { s as f32 * 45.0 - 360.0 } else { s as f32 * 45.0 };
                let lvl = (sectors[s].min(1.0)) as f64;
                format!(r#"{{"a":{:.0},"lvl":{:.2},"n":{},"d":{:.0}}}"#, centre, lvl, sector_n[s], sector_d[s])
            })
            .collect();
        let hurt = self.hurt.as_ref()
            .filter(|(_, _, t)| self.time - t < 1.5)
            .map(|(a, amt, t)| format!(r#"{{"a":{:.0},"amt":{:.1},"age":{:.2}}}"#, a, *amt, self.time - t))
            .unwrap_or_else(|| "null".into());
        let powers: Vec<String> = self.powers.iter().map(|(p, u)| format!(r#"{{"name":"{}","left":{:.0}}}"#, p.name(), u - self.time)).collect();
        let procs: Vec<String> = self.procs.iter().map(|l| format!("\"{}\"", l.replace('"', "'"))).collect();
        let ranks: Vec<String> = self.ranks.iter().map(|(u, r)| format!(r#"{{"id":"{}","name":"{}","rank":{}}}"#, u.id(), u.name(), r)).collect();
        // touch controls (port/web/touch.js) + tools/touchtest.mjs read these
        let yaw = host.player_view().map(|d| (d[2] as f64).atan2(d[0] as f64).to_degrees()).unwrap_or(0.0);
        host.ui_post(&format!(
            r#"{{"type":"hud","time":{:.1},"run":{:.0},"level":{},"xp":{:.1},"next":{:.0},"kills":{},"score":{},"combo":{},"gold":{:.0},"alive":{},"gems":{},"guns":[{}],"abilities":[{}],"passives":[{}],"ranks":[{}],"boss":{},"arrows":[{}],"threats":[{}],"hurt":{},"powers":[{}],"procs":[{}],"endless":{},"state":"{}","pos":[{:.2},{:.2},{:.2}],"yaw":{:.1},"weapon":{}}}"#,
            self.time,
            RUN_S,
            self.level,
            self.xp,
            self.next_xp,
            self.kills,
            self.score,
            self.combo,
            self.gold * self.gold_mul(),
            self.enemies.len(),
            self.gems.len(),
            list(Cat::Gun),
            list(Cat::Ability),
            list(Cat::Passive),
            ranks.join(","),
            boss,
            arrows.join(","),
            threats.join(","),
            hurt,
            powers.join(","),
            procs.join(","),
            self.endless,
            match self.state {
                State::Lobby => "lobby",
                State::Run => "run",
                State::Offer => "offer",
                State::Chest => "chest",
                State::End => "end",
            },
            self.pos[0] as f64,
            self.pos[1] as f64,
            self.pos[2] as f64,
            yaw,
            host.weapon(), // from the engine: self.weapon is only tracked in a normal run, not in stress mode
        ));
    }

    // ------------------------------------------------------------------ stress test
    /// `?svstress=N`: hold N monsters in front of a god-mode player (tools/stress.mjs).
    fn stress_frame(&mut self, host: &Host) {
        host.shell_execute("cht_bGod = 1");
        if self.time < self.started_at + 15.0 {
            host.close_computer(); // as in run(): the NETRICSA briefing would take the input
        }
        let Some((pos, _)) = host.player() else { return };
        self.pos = pos;
        let d = host.player_view().unwrap_or([0.0, 0.0, -1.0]);
        let yaw = (d[2] as f64).atan2(d[0] as f64);
        // the level can move the player after the start: replace monsters left far behind
        let mut i = 0;
        while i < self.enemies.len() {
            let h = self.enemies[i].h;
            let far = host.position(h).map_or(true, |q| dist(q, pos) > 120.0);
            if far {
                self.enemies.swap_remove(i);
                host.destroy(h);
            } else {
                i += 1;
            }
        }
        let mut n = 0;
        while self.time > 3.0 && self.enemies.len() < self.stress && n < 16 {
            let a = yaw + (self.rand() - 0.5) * 1.2;
            let r = 10.0 + self.rand() as f32 * 35.0;
            let q = [pos[0] + (a.cos() as f32) * r, pos[1] + 1.0, pos[2] + (a.sin() as f32) * r];
            self.spawn_at(host, self.stress_kind, q, 1.0, false, false);
            n += 1;
        }
        if self.time - self.hud_t > 0.2 {
            self.hud_t = self.time;
            self.post_hud(host);
        }
    }
}

fn roman(r: u32) -> &'static str {
    ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"][r.min(9) as usize]
}
fn up(p: [f32; 3], dy: f32) -> [f32; 3] {
    [p[0], p[1] + dy, p[2]]
}
fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    len3(sub3(a, b))
}
fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale3(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn len3(a: [f32; 3]) -> f32 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn norm3(a: [f32; 3]) -> [f32; 3] {
    let l = len3(a).max(1e-6);
    scale3(a, 1.0 / l)
}
fn norm2(x: f32, z: f32) -> (f32, f32) {
    let l = (x * x + z * z).sqrt().max(1e-6);
    (x / l, z / l)
}

#[cfg(test)]
mod tests {
    use super::{damage_hook, HOOK_ON, GUN_MULTS, HELD_GUN, HOOK_CALLS, HOOK_FROM_PLAYER, HOOK_SCALED, HOOK_GUN_HITS, QUEUE};
    use super::data::*;
    use std::sync::atomic::Ordering;

    fn reset() {
        HOOK_ON.store(false, Ordering::Relaxed);
        for m in GUN_MULTS.iter() { m.store(0, Ordering::Relaxed); }
        HELD_GUN.store(0, Ordering::Relaxed);
        HOOK_CALLS.store(0, Ordering::Relaxed);
        HOOK_FROM_PLAYER.store(0, Ordering::Relaxed);
        HOOK_SCALED.store(0, Ordering::Relaxed);
        for m in HOOK_GUN_HITS.iter() { m.store(0, Ordering::Relaxed); }
        QUEUE.lock().unwrap().clear();
    }

    fn gun_idx(u: Up) -> usize {
        ALL.iter().position(|&a| a == u).unwrap()
    }

    /// The hook tests share the hook's statics (HOOK_ON, QUEUE, the counters): run them one at a time.
    static HOOK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn hook_behavior() {
        let _serial = HOOK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        // hook off: returns input unchanged
        assert_eq!(damage_hook(1, 1, 0, 10.0, 0), 10.0);
        assert_eq!(damage_hook(0, 0, 0, 5.0, 0), 5.0);
        QUEUE.lock().unwrap().clear();

        // hook on: scales player damage, passes through the rest
        HOOK_ON.store(true, Ordering::Relaxed);
        let shotgun = gun_idx(Up::Shotgun);
        GUN_MULTS[shotgun].store(1.6f32.to_bits(), Ordering::Relaxed);
        HELD_GUN.store(shotgun as u32, Ordering::Relaxed);

        // source 1, target != 0, weapon 0 (hit-scan): scaled by held gun
        let r = damage_hook(42, 1, 0, 10.0, 0);
        assert!((r - 16.0).abs() < 1e-6);

        // source 0: unchanged
        let r = damage_hook(42, 0, 0, 10.0, 0);
        assert_eq!(r, 10.0);

        // source 2: unchanged
        let r = damage_hook(42, 2, 0, 10.0, 0);
        assert_eq!(r, 10.0);

        // target 0: unchanged, no queue entry
        let r = damage_hook(0, 1, 0, 10.0, 0);
        assert_eq!(r, 10.0);

        assert_eq!(HOOK_CALLS.load(Ordering::Relaxed), 4);
        assert_eq!(HOOK_FROM_PLAYER.load(Ordering::Relaxed), 1);
        assert_eq!(HOOK_SCALED.load(Ordering::Relaxed), 1);

        let q = QUEUE.lock().unwrap();
        assert_eq!(q.len(), 3);
        assert_eq!(q[0].target, 42);
        assert!((q[0].amount - 16.0).abs() < 1e-6);
        assert_eq!(q[0].gun, shotgun);
        assert_eq!(q[1].target, 42);
        assert_eq!(q[1].amount, 10.0);
        assert_eq!(q[2].target, 42);
        assert_eq!(q[2].amount, 10.0);
        drop(q);

        HOOK_ON.store(false, Ordering::Relaxed);
        QUEUE.lock().unwrap().clear();
    }

    #[test]
    fn hook_projectile_weapon() {
        let _serial = HOOK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        HOOK_ON.store(true, Ordering::Relaxed);
        let shotgun = gun_idx(Up::Shotgun);
        let rocket = gun_idx(Up::RocketLauncher);
        GUN_MULTS[shotgun].store(1.6f32.to_bits(), Ordering::Relaxed);
        GUN_MULTS[rocket].store(2.0f32.to_bits(), Ordering::Relaxed);
        HELD_GUN.store(shotgun as u32, Ordering::Relaxed);

        // weapon = 8 (RocketLauncher) while holding Shotgun: uses RocketLauncher's multiplier
        let r = damage_hook(42, 1, 0, 10.0, 8);
        assert!((r - 20.0).abs() < 1e-6, "expected 20.0, got {}", r);

        let q = QUEUE.lock().unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].gun, rocket, "should be credited to RocketLauncher");
        drop(q);
        QUEUE.lock().unwrap().clear();

        // weapon = 0 (hit-scan): uses held gun (Shotgun)
        let r = damage_hook(43, 1, 0, 10.0, 0);
        assert!((r - 16.0).abs() < 1e-6, "expected 16.0, got {}", r);
        let q = QUEUE.lock().unwrap();
        assert_eq!(q[0].gun, shotgun, "should be credited to Shotgun");
        drop(q);
        QUEUE.lock().unwrap().clear();

        // unknown weapon number: falls back to held gun
        let r = damage_hook(44, 1, 0, 10.0, 99);
        assert!((r - 16.0).abs() < 1e-6, "expected 16.0, got {}", r);
        let q = QUEUE.lock().unwrap();
        assert_eq!(q[0].gun, shotgun, "should fall back to Shotgun");
        drop(q);

        HOOK_ON.store(false, Ordering::Relaxed);
        QUEUE.lock().unwrap().clear();
    }
}
