//! The bot runtime: the only place the bot logic touches the engine.
//!
//! Pure logic lives in `brain` (decisions) and `nav` (pathfinding); this module
//! is the thin layer that queries the engine through [`BotHost`], builds the
//! nav graph over the ticks, and feeds each bot's [`Brain`](brain::Brain).
//! The engine calls `Runtime::tick` once per simulated tick (20/s).

use crate::bots::brain::{Brain, BotState, Foe, Item, ItemKind, Paths, Sense};
use crate::bots::nav::{NavBuilder, NavGraph, NavParams, World};
use crate::host::BotState as HostBotState;
use crate::host::buttons;

/// The engine, seen by the runtime. `Runtime` is the only code that calls it.
pub trait BotHost {
    fn is_server(&self) -> bool;
    fn page_option(&self, name: &str) -> f64;
    fn bot_add(&self, name: &str) -> Option<i32>;
    fn bot_remove(&self, id: i32);
    fn bot_state(&self, id: i32) -> Option<HostBotState>;
    fn bot_action(&self, id: i32, mv: [f32; 3], rot: [f32; 3], buttons: u32);
    fn ray(&self, from: [f32; 3], to: [f32; 3], hit_models: bool) -> Option<f32>;
    fn enemies(&self, max: usize) -> Vec<(i32, [f32; 3], f32)>;
    fn items(&self, max: usize) -> Vec<(i32, [f32; 3])>;
    fn humans(&self, max: usize) -> Vec<[f32; 3]>;
    fn world_bounds(&self) -> Option<([f32; 3], [f32; 3])>;
    fn log(&self, msg: &str);
}

impl BotHost for crate::host::Host {
    fn is_server(&self) -> bool {
        crate::host::Host::is_server(self)
    }
    fn page_option(&self, name: &str) -> f64 {
        crate::host::Host::page_option(self, name)
    }
    fn bot_add(&self, name: &str) -> Option<i32> {
        crate::host::Host::bot_add(self, name)
    }
    fn bot_remove(&self, id: i32) {
        crate::host::Host::bot_remove(self, id)
    }
    fn bot_state(&self, id: i32) -> Option<HostBotState> {
        crate::host::Host::bot_state(self, id)
    }
    fn bot_action(&self, id: i32, mv: [f32; 3], rot: [f32; 3], buttons: u32) {
        crate::host::Host::bot_action(self, id, mv, rot, buttons)
    }
    fn ray(&self, from: [f32; 3], to: [f32; 3], hit_models: bool) -> Option<f32> {
        crate::host::Host::ray(self, from, to, hit_models)
    }
    fn enemies(&self, max: usize) -> Vec<(i32, [f32; 3], f32)> {
        crate::host::Host::enemies(self, max)
    }
    fn items(&self, max: usize) -> Vec<(i32, [f32; 3])> {
        crate::host::Host::items(self, max)
    }
    fn humans(&self, max: usize) -> Vec<[f32; 3]> {
        crate::host::Host::humans(self, max)
    }
    fn world_bounds(&self) -> Option<([f32; 3], [f32; 3])> {
        crate::host::Host::world_bounds(self)
    }
    fn log(&self, msg: &str) {
        crate::host::Host::log(self, msg)
    }
}

/// Engine tick, seconds: 20 simulated ticks per second.
pub const TICK: f32 = 0.05;
/// Ray casts per tick while building the nav graph.
pub const NAV_RAYS_PER_TICK: usize = 400;
/// Radius, metres, around the first human for the nav graph.
pub const NAV_RADIUS: f32 = 150.0;
/// How many bots, at most.
pub const MAX_BOTS: usize = 15;

/// Enemies within this horizontal distance become `Sense.foes`.
const FOE_RANGE: f32 = 60.0;
/// At most this many foes per bot.
const MAX_FOES: usize = 8;
/// Enemies asked from the engine each tick: it lists them in entity order, not by distance, so ask
/// for many and keep the nearest (Survivors keeps up to a few hundred alive).
const MAX_ENEMIES: usize = 1024;
/// Only the nearest this many foes get a visibility ray each tick.
const VISIBLE_CHECKS: usize = 6;
/// Ticks to wait after a failed `bot_add` before trying again.
const ADD_COOLDOWN: u32 = 100;
/// Ticks a new bot may lack a player entity before it counts as gone.
const JOIN_GRACE: u32 = 40;

/// A bot: its engine id, brain, and the accumulated heading/pitch sent as
/// absolute angles to the engine (the engine turns by the per-tick change).
struct Bot {
    id: i32,
    /// "Bot <num>"
    num: i32,
    /// tick it was added, and whether its player entity has shown up yet: the engine creates the
    /// entity a little later, so a new bot gets JOIN_GRACE ticks before it counts as gone
    added: u32,
    seen: bool,
    brain: Brain,
    heading_acc: f32,
    pitch_acc: f32,
}

/// One world ray cast through the host (the nav builder's [`World`]).
struct RayWorld<'a> {
    h: &'a dyn BotHost,
}

impl World for RayWorld<'_> {
    fn ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<f32> {
        self.h.ray(from, to, false)
    }
}

/// Straight-line `Paths` used until the nav graph is ready.
struct DirectPaths;

impl Paths for DirectPaths {
    fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
        Some(vec![from, to])
    }
    fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
        let a = (seed % 360) as f32 * std::f32::consts::PI / 180.0;
        Some([p[0] + r * 0.8 * a.cos(), p[1], p[2] + r * 0.8 * a.sin()])
    }
}

pub struct Runtime {
    bots: Vec<Bot>,
    build: Option<NavBuilder>,
    nav: Option<NavGraph>,
    ticks: u32,
    add_fail_ticks: u32,
}

impl Runtime {
    pub fn new() -> Self {
        Runtime { bots: Vec::new(), build: None, nav: None, ticks: 0, add_fail_ticks: 0 }
    }

    pub fn tick(&mut self, h: &dyn BotHost) {
        if !h.is_server() {
            return;
        }
        self.ticks += 1;
        self.sync_bots(h);
        self.build_nav(h);
        self.act(h);
        if self.ticks % 200 == 0 {
            self.log_status(h);
        }
    }

    /// Forget gone bots, remove the newest when the target drops, add at most
    /// one new bot per tick once a human exists.
    fn sync_bots(&mut self, h: &dyn BotHost) {
        // a new bot has no player entity until the session adds it: give it time before
        // deciding it's gone (otherwise it's re-added under the same name, which the engine refuses)
        let ticks = self.ticks;
        self.bots.retain_mut(|b| {
            if h.bot_state(b.id).is_some() {
                b.seen = true;
                true
            } else {
                !b.seen && ticks.saturating_sub(b.added) < JOIN_GRACE
            }
        });
        let target = h.page_option("se1Bots") as i32;
        let target = target.clamp(0, MAX_BOTS as i32);
        while self.bots.len() as i32 > target {
            let b = self.bots.pop().unwrap();
            h.bot_remove(b.id);
        }
        let has_human = !h.humans(1).is_empty();
        if !has_human || self.bots.len() as i32 >= target {
            return;
        }
        if self.add_fail_ticks > 0 {
            self.add_fail_ticks -= 1;
            return;
        }
        let used: Vec<i32> = self.bots.iter().map(|b| b.num).collect();
        let mut k = 1;
        while used.contains(&k) {
            k += 1;
        }
        match h.bot_add(&format!("Bot {k}")) {
            Some(id) => {
                let skill = h.page_option("se1BotSkill") as f32;
                let skill = if skill == 0.0 { 0.5 } else { skill.clamp(0.0, 1.0) };
                let i = self.bots.len();
                self.bots.push(Bot { id, num: k, added: self.ticks, seen: false, brain: Brain::new(skill, 1000 + i as u64), heading_acc: 0.0, pitch_acc: 0.0 });
            }
            None => self.add_fail_ticks = ADD_COOLDOWN,
        }
    }

    /// Start the nav graph once a human exists; step it each tick; finish with
    /// the human positions as seeds.
    fn build_nav(&mut self, h: &dyn BotHost) {
        if self.nav.is_some() {
            return;
        }
        if self.build.is_none() {
            let Some(human) = h.humans(1).into_iter().next() else {
                return;
            };
            let (min, max) = match h.world_bounds() {
                Some((a, b)) => (
                    [human[0] - NAV_RADIUS, a[1].max(human[1] - 60.0), human[2] - NAV_RADIUS],
                    [human[0] + NAV_RADIUS, b[1].min(human[1] + 60.0), human[2] + NAV_RADIUS],
                ),
                None => (
                    [human[0] - 60.0, human[1] - 60.0, human[2] - 60.0],
                    [human[0] + 60.0, human[1] + 60.0, human[2] + 60.0],
                ),
            };
            self.build = Some(NavBuilder::new(min, max, NavParams::default()));
        }
        let Some(build) = self.build.as_mut() else {
            return;
        };
        let w = RayWorld { h };
        if build.step(&w, NAV_RAYS_PER_TICK) {
            let rays = build.rays_cast();
            let seeds = h.humans(MAX_BOTS);
            let b = self.build.take().unwrap();
            let nav = b.finish(&seeds);
            self.nav = Some(nav);
            h.log(&format!("se1mod: bots nav ready: {} nodes, {rays} rays", self.nav_nodes()));
        }
    }

    /// Sense each bot and apply the brain's action (or the respawn press).
    fn act(&mut self, h: &dyn BotHost) {
        if self.bots.is_empty() {
            return;
        }
        let humans = h.humans(MAX_BOTS);
        let enemies = h.enemies(MAX_ENEMIES);
        let items = h.items(16);
        let direct = DirectPaths;
        match self.nav.as_ref() {
            Some(nav) => {
                for i in 0..self.bots.len() {
                    Self::act_one(self.ticks, h, nav, &mut self.bots[i], &humans, &enemies, &items);
                }
            }
            None => {
                for i in 0..self.bots.len() {
                    Self::act_one(self.ticks, h, &direct, &mut self.bots[i], &humans, &enemies, &items);
                }
            }
        }
    }

    fn act_one(ticks: u32, h: &dyn BotHost, paths: &dyn Paths, b: &mut Bot, humans: &[[f32; 3]], enemies: &[(i32, [f32; 3], f32)], items: &[(i32, [f32; 3])]) {
        let Some(st) = h.bot_state(b.id) else {
            return;
        };
        if st.health <= 0.0 {
            // Dead: press FIRE on even 10-tick blocks, release on odd ones;
            // the engine respawns on a new press.
            let fire = (ticks / 10) % 2 == 0;
            h.bot_action(b.id, [0.0, 0.0, 0.0], [b.heading_acc, b.pitch_acc, 0.0], fire as u32 * buttons::FIRE);
            return;
        }
        let sense = sense(h, st, humans, enemies, items, ticks as f64);
        let a = b.brain.think(&sense, paths);
        b.heading_acc += a.turn_yaw;
        b.pitch_acc += a.turn_pitch;
        let mv = [a.strafe * 10.0, if a.jump { 11.0 } else { 0.0 }, -a.forward * 10.0];
        let btns = a.fire as u32 * buttons::FIRE;
        h.bot_action(b.id, mv, [b.heading_acc, b.pitch_acc, 0.0], btns);
    }

    fn log_status(&self, h: &dyn BotHost) {
        let n = self.bots.len();
        let mut parts = Vec::with_capacity(n);
        for b in &self.bots {
            let Some(st) = h.bot_state(b.id) else {
                continue;
            };
            let state = match b.brain.state() {
                BotState::Fight => "Fight",
                BotState::Heal => "Heal",
                BotState::Follow => "Follow",
                BotState::Roam => "Roam",
            };
            parts.push(format!(
                "[{} {} hp {} at {} {}]",
                b.id,
                state,
                st.health.round() as i32,
                st.eye[0].round() as i32,
                st.eye[2].round() as i32
            ));
        }
        h.log(&format!("se1mod: bots: {n} {}", parts.join(" ")));
    }

    pub fn level_started(&mut self) {
        self.bots.clear();
        self.build = None;
        self.nav = None;
        self.add_fail_ticks = 0;
    }

    pub fn bot_ids(&self) -> Vec<i32> {
        self.bots.iter().map(|b| b.id).collect()
    }

    pub fn nav_ready(&self) -> bool {
        self.nav.is_some()
    }

    pub fn nav_nodes(&self) -> usize {
        self.nav.as_ref().map_or(0, NavGraph::node_count)
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

/// What bot `st` senses this tick: foes within range (nearest first, at most
/// `MAX_FOES`, the nearest `VISIBLE_CHECKS` with a visibility ray), items, and
/// the nearest human.
fn sense(h: &dyn BotHost, st: HostBotState, humans: &[[f32; 3]], enemies: &[(i32, [f32; 3], f32)], items: &[(i32, [f32; 3])], time: f64) -> Sense {
    let pos = st.eye;
    let mut foes: Vec<(f32, i32, [f32; 3])> = enemies
        .iter()
        .filter(|(_, p, _)| ((p[0] - pos[0]).powi(2) + (p[2] - pos[2]).powi(2)).sqrt() <= FOE_RANGE)
        .map(|(id, p, _)| (((p[0] - pos[0]).powi(2) + (p[2] - pos[2]).powi(2)).sqrt(), *id, *p))
        .collect();
    foes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    foes.truncate(MAX_FOES);
    let foes = foes
        .into_iter()
        .enumerate()
        .map(|(i, (_, id, p))| {
            let visible = if i < VISIBLE_CHECKS {
                h.ray(pos, [p[0], p[1] + 1.0, p[2]], false).is_none()
            } else {
                false
            };
            Foe { id, pos: p, visible, ranged: true }
        })
        .collect();
    let items = items
        .iter()
        .filter(|(k, _)| (0..4).contains(k))
        .map(|(k, p)| Item {
            kind: match k {
                0 => ItemKind::Health,
                1 => ItemKind::Armor,
                2 => ItemKind::Ammo,
                _ => ItemKind::Weapon,
            },
            pos: *p,
        })
        .collect();
    let leader = humans
        .iter()
        .min_by(|a, b| {
            let da = (a[0] - pos[0]).powi(2) + (a[2] - pos[2]).powi(2);
            let db = (b[0] - pos[0]).powi(2) + (b[2] - pos[2]).powi(2);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .copied();
    Sense {
        time,
        dt: TICK,
        pos,
        yaw: st.heading,
        pitch: st.pitch,
        hp: st.health,
        foes,
        items,
        leader,
    }
}
