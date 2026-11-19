//! "Serious Survivors": a Vampire-Survivors-style mode on top of the unchanged engine.
//!
//! Start the page with `?mode=survivors` (port/web/survivors.js). Waves of monsters spawn in a ring
//! around the player and get denser and tougher over time; kills give XP; every level-up pauses the
//! game and offers three upgrades in a page overlay. Upgrades are auto-cast abilities (WoW-flavoured:
//! Consecration, Chain Lightning, Multi-Shot, Arcane Explosion) plus passives, on top of the player's
//! own guns. Everything goes through the host API (port/common/se1mod.h): spawn, damage, heal, pause.

use crate::host::Host;

/// Monster kinds this mode spawns (TFE classes that exist in the demo data too).
#[derive(Clone, Copy)]
struct Kind {
    class: &'static str,
    xp: u32,
    from_s: f64, // starts appearing after this many seconds
    weight: u32,
}
const KINDS: &[Kind] = &[
    Kind { class: "Classes\\Headman.ecl", xp: 1, from_s: 0.0, weight: 6 },
    Kind { class: "Classes\\Boneman.ecl", xp: 2, from_s: 20.0, weight: 4 },
    Kind { class: "Classes\\Eyeman.ecl", xp: 2, from_s: 60.0, weight: 4 },
    Kind { class: "Classes\\Scorpman.ecl", xp: 6, from_s: 120.0, weight: 1 },
];
const BOSS: &str = "Classes\\Werebull.ecl";
const BOSS_EVERY_S: f64 = 90.0;
const BOSS_XP: u32 = 12;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Up {
    // auto-cast abilities
    Consecration,
    ChainLightning,
    MultiShot,
    ArcaneExplosion,
    SeriousBomb,
    // passives
    FleetFoot,
    VampiricTouch,
    Regeneration,
    Bloodlust,
    Greed,
    Armory,
    SecondWind,
}
const ALL: &[Up] = &[
    Up::Consecration, Up::ChainLightning, Up::MultiShot, Up::ArcaneExplosion, Up::SeriousBomb,
    Up::FleetFoot, Up::VampiricTouch, Up::Regeneration, Up::Bloodlust, Up::Greed, Up::Armory, Up::SecondWind,
];

impl Up {
    fn id(self) -> &'static str {
        match self {
            Up::Consecration => "consecration",
            Up::ChainLightning => "chain_lightning",
            Up::MultiShot => "multi_shot",
            Up::ArcaneExplosion => "arcane_explosion",
            Up::SeriousBomb => "serious_bomb",
            Up::FleetFoot => "fleet_foot",
            Up::VampiricTouch => "vampiric_touch",
            Up::Regeneration => "regeneration",
            Up::Bloodlust => "bloodlust",
            Up::Greed => "greed",
            Up::Armory => "armory",
            Up::SecondWind => "second_wind",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Up::Consecration => "Consecration",
            Up::ChainLightning => "Chain Lightning",
            Up::MultiShot => "Multi-Shot",
            Up::ArcaneExplosion => "Arcane Explosion",
            Up::SeriousBomb => "Serious Bomb",
            Up::FleetFoot => "Fleet Foot",
            Up::VampiricTouch => "Vampiric Touch",
            Up::Regeneration => "Regeneration",
            Up::Bloodlust => "Bloodlust",
            Up::Greed => "Greed",
            Up::Armory => "Armory",
            Up::SecondWind => "Second Wind",
        }
    }
    fn max_rank(self) -> u32 {
        match self {
            Up::Armory => 1,
            Up::SecondWind => 9,
            _ => 5,
        }
    }
    /// Description of what the next rank (r = 1-based rank after taking it) does.
    fn describe(self, r: u32) -> String {
        let r = r as f32;
        match self {
            Up::Consecration => format!("Holy ground around you: {:.0} damage/s to foes within {:.0} m", 8.0 + 6.0 * r, 5.0 + 1.5 * r),
            Up::ChainLightning => format!("Every {:.1} s a bolt hits the nearest foe for {:.0} and jumps {} times", (2.6 - 0.2 * r).max(1.0), 30.0 + 15.0 * r, 2 + r as u32),
            Up::MultiShot => format!("Every 1.6 s hit the {} nearest foes for {:.0}", 2 + r as u32, 18.0 + 8.0 * r),
            Up::ArcaneExplosion => format!("Every {:.1} s blast everything within {:.0} m for {:.0}", (6.0 - 0.6 * r).max(2.0), 8.0 + r, 40.0 + 20.0 * r),
            Up::SeriousBomb => format!("Every {:.0} s wipe out every foe within 30 m", (50.0 - 6.0 * r).max(20.0)),
            Up::FleetFoot => format!("Move {:.0}% faster", 12.0 * r),
            Up::VampiricTouch => format!("Heal {:.1} per kill", 0.5 * r),
            Up::Regeneration => format!("Regenerate {:.1} health/s", 0.6 * r),
            Up::Bloodlust => format!("Abilities recharge {:.0}% faster", 10.0 * r),
            Up::Greed => format!("{:.0}% more XP", 20.0 * r),
            Up::Armory => "Every weapon in the game, fully loaded".to_string(),
            Up::SecondWind => "Health and ammo refilled now".to_string(),
        }
    }
}

struct Enemy {
    h: i32,
    xp: u32,
}

pub struct Survivors {
    start: f64,
    last_t: f64,
    next_spawn: f64,
    next_boss: f64,
    enemies: Vec<Enemy>,
    pub level: u32,
    xp: f32,
    next_xp: f32,
    kills: u32,
    ranks: Vec<(Up, u32)>,
    cooldowns: Vec<(Up, f64)>,
    offer: Option<Vec<Up>>,
    last_hud: f64,
    rng: u64,
    dead: bool,
    log: Vec<String>, // recent ability procs, for the overlay
}

impl Survivors {
    pub fn new(host: &Host) -> Survivors {
        let t = host.game_time();
        // cheats drive some passives (speed, weapons, refills); enable them for this mode
        host.shell_execute("cht_bEnable = 1");
        host.shell_execute("cht_fTranslationMultiplier = 1.0");
        host.log("se1mod: Serious Survivors started");
        // debug/test option: start with XP (?svxp=N on the page), e.g. to reach a level-up at once
        let start_xp = host.page_option("se1SurvivorsXp") as f32;
        let mut s = Survivors {
            start: t, last_t: t, next_spawn: t + 2.0, next_boss: t + BOSS_EVERY_S, enemies: Vec::new(),
            level: 1, xp: 0.0, next_xp: 5.0, kills: 0, ranks: Vec::new(), cooldowns: Vec::new(), offer: None,
            last_hud: 0.0, rng: 0x9E37_79B9_7F4A_7C15 ^ (t.to_bits()), dead: false, log: Vec::new(),
        };
        s.xp += start_xp.max(0.0);
        host.ui_post(r#"{"type":"start"}"#);
        s
    }

    fn rand(&mut self) -> f64 {
        // xorshift64*
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        (self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn rank(&self, u: Up) -> u32 {
        self.ranks.iter().find(|(x, _)| *x == u).map_or(0, |(_, r)| *r)
    }

    fn ready(&mut self, u: Up, now: f64, cd: f64) -> bool {
        let haste = 1.0 - 0.10 * self.rank(Up::Bloodlust) as f64;
        let cd = cd * haste.max(0.4);
        match self.cooldowns.iter_mut().find(|(x, _)| *x == u) {
            Some((_, next)) if now < *next => false,
            Some((_, next)) => {
                *next = now + cd;
                true
            }
            None => {
                self.cooldowns.push((u, now + cd));
                true
            }
        }
    }

    /// Live enemies with their distance to `p`, nearest first.
    fn near(&self, host: &Host, p: [f32; 3]) -> Vec<(i32, f32)> {
        let mut v: Vec<(i32, f32)> = self
            .enemies
            .iter()
            .filter_map(|e| host.position(e.h).map(|q| (e.h, dist(p, q))))
            .collect();
        v.sort_by(|a, b| a.1.total_cmp(&b.1));
        v
    }

    fn proc(&mut self, what: String) {
        self.log.push(what);
        if self.log.len() > 4 {
            self.log.remove(0);
        }
    }

    pub fn frame(&mut self, host: &Host) {
        // level-up choice pending: the game is paused until the page answers
        if let Some(offer) = &self.offer {
            if let Some(i) = host.ui_poll() {
                if let Some(&u) = offer.get(i as usize) {
                    self.take(host, u);
                }
                self.offer = None;
                host.set_pause(false);
                self.post_hud(host, host.game_time(), None);
            }
            return;
        }
        let now = host.game_time();
        let dt = (now - self.last_t).clamp(0.0, 0.25);
        self.last_t = now;
        // a survivors run doesn't start on the NETRICSA briefing (it would pause the game)
        if now - self.start < 15.0 {
            host.close_computer();
        }
        let Some((pos, health)) = host.player() else {
            if !self.dead && now - self.start > 3.0 {
                self.dead = true;
                host.ui_post(&format!(r#"{{"type":"dead","level":{},"kills":{},"time":{:.0}}}"#, self.level, self.kills, now - self.start));
            }
            return;
        };
        self.dead = false;

        // kills and XP
        let greed = 1.0 + 0.2 * self.rank(Up::Greed) as f32;
        let vamp = 0.5 * self.rank(Up::VampiricTouch) as f32;
        let mut i = 0;
        while i < self.enemies.len() {
            if host.alive(self.enemies[i].h) {
                i += 1;
                continue;
            }
            let e = self.enemies.swap_remove(i);
            host.release(e.h);
            self.kills += 1;
            self.xp += e.xp as f32 * greed;
            if vamp > 0.0 {
                host.player_heal(vamp, 200.0);
            }
        }

        // regeneration
        let regen = 0.6 * self.rank(Up::Regeneration) as f32;
        if regen > 0.0 {
            host.player_heal(regen * dt as f32, 100.0);
        }

        // spawning: denser and tougher over time
        let t = now - self.start;
        let minutes = t / 60.0;
        let cap = (10.0 + 6.0 * minutes).min(60.0) as usize;
        let interval = (1.4 - 0.15 * minutes).max(0.25);
        if now >= self.next_spawn && self.enemies.len() < cap {
            self.next_spawn = now + interval;
            let pack = 1 + (minutes as usize).min(4);
            for _ in 0..pack {
                let kind = self.pick_kind(t);
                self.spawn_near(host, pos, kind.class, kind.xp);
            }
        }
        if now >= self.next_boss {
            self.next_boss = now + BOSS_EVERY_S;
            self.spawn_near(host, pos, BOSS, BOSS_XP);
            self.proc("A Werebull charges in!".to_string());
        }

        // abilities
        self.abilities(host, now, pos);

        // level up
        if self.xp >= self.next_xp {
            self.xp -= self.next_xp;
            self.level += 1;
            self.next_xp = (self.next_xp * 1.25 + 4.0).round();
            let offer = self.roll_offer();
            if !offer.is_empty() {
                host.set_pause(true);
                self.post_hud(host, now, Some(&offer));
                self.offer = Some(offer);
                return;
            }
        }
        if now - self.last_hud > 0.2 {
            self.last_hud = now;
            self.post_hud(host, now, None);
        }
        let _ = health;
    }

    fn pick_kind(&mut self, t: f64) -> Kind {
        let avail: Vec<Kind> = KINDS.iter().copied().filter(|k| t >= k.from_s).collect();
        let total: u32 = avail.iter().map(|k| k.weight).sum();
        let mut x = (self.rand() * total as f64) as u32;
        for k in &avail {
            if x < k.weight {
                return *k;
            }
            x -= k.weight;
        }
        avail[0]
    }

    fn spawn_near(&mut self, host: &Host, p: [f32; 3], class: &str, xp: u32) {
        let a = self.rand() * std::f64::consts::TAU;
        let d = 18.0 + self.rand() * 12.0;
        let q = [p[0] + (a.cos() * d) as f32, p[1] + 1.0, p[2] + (a.sin() * d) as f32];
        if let Some(h) = host.spawn(class, q) {
            self.enemies.push(Enemy { h, xp });
        }
    }

    fn abilities(&mut self, host: &Host, now: f64, p: [f32; 3]) {
        let r = self.rank(Up::Consecration);
        if r > 0 && self.ready(Up::Consecration, now, 1.0) {
            let (radius, dmg) = (5.0 + 1.5 * r as f32, 8.0 + 6.0 * r as f32);
            for (h, d) in self.near(host, p) {
                if d > radius {
                    break;
                }
                host.damage(h, dmg);
            }
        }
        let r = self.rank(Up::ChainLightning);
        if r > 0 && self.ready(Up::ChainLightning, now, (2.6 - 0.2 * r as f64).max(1.0)) {
            let near = self.near(host, p);
            let mut hit = 0;
            if let Some(&(first, d)) = near.first() {
                if d < 25.0 {
                    // nearest foe, then jump to the next nearest ones
                    let jumps = 2 + r as usize;
                    for &(h, _) in near.iter().take(1 + jumps) {
                        host.damage(h, 30.0 + 15.0 * r as f32);
                        hit += 1;
                    }
                    let _ = first;
                }
            }
            if hit > 0 {
                self.proc(format!("Chain Lightning hits {hit}"));
            }
        }
        let r = self.rank(Up::MultiShot);
        if r > 0 && self.ready(Up::MultiShot, now, 1.6) {
            let near = self.near(host, p);
            for &(h, d) in near.iter().take(2 + r as usize) {
                if d < 35.0 {
                    host.damage(h, 18.0 + 8.0 * r as f32);
                }
            }
        }
        let r = self.rank(Up::ArcaneExplosion);
        if r > 0 && self.ready(Up::ArcaneExplosion, now, (6.0 - 0.6 * r as f64).max(2.0)) {
            let radius = 8.0 + r as f32;
            let mut hit = 0;
            for (h, d) in self.near(host, p) {
                if d > radius {
                    break;
                }
                host.damage(h, 40.0 + 20.0 * r as f32);
                hit += 1;
            }
            if hit > 0 {
                self.proc(format!("Arcane Explosion hits {hit}"));
            }
        }
        let r = self.rank(Up::SeriousBomb);
        if r > 0 && self.ready(Up::SeriousBomb, now, (50.0 - 6.0 * r as f64).max(20.0)) {
            let mut hit = 0;
            for (h, d) in self.near(host, p) {
                if d > 30.0 {
                    break;
                }
                host.damage(h, 9999.0);
                hit += 1;
            }
            self.proc(format!("SERIOUS BOMB! {hit} foes vaporized"));
        }
    }

    fn roll_offer(&mut self) -> Vec<Up> {
        let mut pool: Vec<Up> = ALL.iter().copied().filter(|u| self.rank(*u) < u.max_rank()).collect();
        // Second Wind only when nothing better is left or by luck
        let mut offer = Vec::new();
        while offer.len() < 3 && !pool.is_empty() {
            let i = (self.rand() * pool.len() as f64) as usize % pool.len();
            offer.push(pool.swap_remove(i));
        }
        offer
    }

    fn take(&mut self, host: &Host, u: Up) {
        let r = self.rank(u) + 1;
        match self.ranks.iter_mut().find(|(x, _)| *x == u) {
            Some((_, rank)) => *rank = r,
            None => self.ranks.push((u, r)),
        }
        match u {
            Up::FleetFoot => host.shell_execute(&format!("cht_fTranslationMultiplier = {:.2}", 1.0 + 0.12 * r as f32)),
            Up::Armory => host.shell_execute("cht_bGiveAll = 1"),
            Up::SecondWind => host.shell_execute("cht_bRefresh = 1"),
            _ => {}
        }
        self.proc(format!("{} rank {r}", u.name()));
        host.log(&format!("se1mod: survivors took {} (rank {r})", u.name()));
    }

    fn post_hud(&self, host: &Host, now: f64, offer: Option<&Vec<Up>>) {
        let ranks: Vec<String> = self
            .ranks
            .iter()
            .map(|(u, r)| format!(r#"{{"id":"{}","name":"{}","rank":{}}}"#, u.id(), u.name(), r))
            .collect();
        let offer_json = offer.map(|o| {
            let cards: Vec<String> = o
                .iter()
                .map(|u| {
                    let r = self.rank(*u) + 1;
                    format!(
                        r#"{{"id":"{}","name":"{}","rank":{},"desc":"{}"}}"#,
                        u.id(),
                        u.name(),
                        r,
                        u.describe(r).replace('"', "'")
                    )
                })
                .collect();
            format!(",\"offer\":[{}]", cards.join(","))
        });
        let procs: Vec<String> = self.log.iter().map(|l| format!("\"{}\"", l.replace('"', "'"))).collect();
        host.ui_post(&format!(
            r#"{{"type":"hud","level":{},"xp":{:.1},"next":{:.0},"kills":{},"time":{:.1},"alive":{},"ranks":[{}],"procs":[{}]{}}}"#,
            self.level,
            self.xp,
            self.next_xp,
            self.kills,
            now - self.start,
            self.enemies.len(),
            ranks.join(","),
            procs.join(","),
            offer_json.unwrap_or_default()
        ));
    }
}

fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (x, y, z) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    (x * x + y * y + z * z).sqrt()
}
