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
    /// End the auto-actions holding a bot (a level intro it started alone).
    fn bot_release(&self, id: i32);
    /// Put a bot at a position (feet), facing `heading`.
    fn bot_teleport(&self, id: i32, pos: [f32; 3], heading: f32);
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
    fn bot_release(&self, id: i32) {
        crate::host::Host::bot_release(self, id)
    }
    fn bot_teleport(&self, id: i32, pos: [f32; 3], heading: f32) {
        crate::host::Host::bot_teleport(self, id, pos, heading)
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
/// The graph is built in slices of this many rays, and stops for the tick after NAV_TIME_BUDGET.
const NAV_SLICE: usize = 50;
/// Path searches per tick for all bots together.
const PATHS_PER_TICK: u32 = 2;
/// The engine's view pitch limit (Player.es PITCH_MAX).
const PITCH_MAX: f32 = 90.0;
/// A human moving farther than this in one tick was teleported (Survivors moves the player into its
/// arena after the level starts): the bots follow at once.
const TELEPORT_JUMP: f32 = 30.0;
const NAV_TIME_BUDGET: std::time::Duration = std::time::Duration::from_millis(4);
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
const VISIBLE_CHECKS: usize = 2;
/// Ticks to wait after a failed `bot_add` before trying again.
const ADD_COOLDOWN: u32 = 100;
/// Ticks a new bot may lack a player entity before it counts as gone.
const JOIN_GRACE: u32 = 40;
/// Bots are put this far from a human when they join.
const PLACE_RADIUS: f32 = 3.0;
/// A bot farther than this from every human, for FAR_TICKS in a row and not fighting, is brought back.
const FAR_FROM_HUMANS: f32 = 40.0;
const FAR_TICKS: u32 = 200;

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
    /// put next to a human once it can move (it spawns on the player start, or wherever a level
    /// intro left it)
    placed: bool,
    /// ticks in a row it has been far from every human
    far_ticks: u32,
    /// when it last asked the engine to end auto-actions holding it
    released_at: Option<u32>,
    /// last known line of sight to foes (foe id, visible): sight rays are spread over ticks
    sight: Vec<(i32, bool)>,
    /// the view (yaw, pitch) as commanded: the engine applies our turns exactly (clamping pitch at
    /// ±PITCH_MAX), but shows them in the bot's state only after a delay that grows when the server
    /// runs several ticks at once (many bots), so steering by that state swings until the view hits
    /// the pitch limit. None: take it from the engine (after joining, a teleport, a respawn).
    view: Option<(f32, f32)>,
    /// it jumped this tick (counted in the status line)
    jumped: bool,
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

/// At most `left` path searches this tick, for all bots together: with many bots, A* searches
/// bunched in one tick made the server's tick late. Over the budget a bot gets None, keeps its
/// current waypoints and asks again next tick.
struct BudgetPaths<'a> {
    inner: &'a dyn Paths,
    left: std::cell::Cell<u32>,
}
impl Paths for BudgetPaths<'_> {
    fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
        if self.left.get() == 0 {
            return None;
        }
        self.left.set(self.left.get() - 1);
        self.inner.path(from, to)
    }
    fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
        self.inner.random_near(p, r, seed)
    }
}

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
    /// microseconds spent in `tick` since the last status line: (sum, worst)
    tick_us: (u64, u64),
    /// jumps the bots made since the last status line
    jumps: u32,
    /// the first human's position last tick, and where the current graph is centred
    last_human: Option<[f32; 3]>,
    nav_center: Option<[f32; 3]>,
    add_fail_ticks: u32,
}

impl Runtime {
    pub fn new() -> Self {
        Runtime { bots: Vec::new(), build: None, nav: None, ticks: 0, tick_us: (0, 0), jumps: 0, last_human: None, nav_center: None, add_fail_ticks: 0 }
    }

    pub fn tick(&mut self, h: &dyn BotHost) {
        if !h.is_server() {
            return;
        }
        let start = std::time::Instant::now();
        self.ticks += 1;
        self.follow_human_moves(h);
        self.sync_bots(h);
        self.build_nav(h);
        self.act(h);
        // the bots run inside the server's tick: keep an eye on what they cost
        let us = start.elapsed().as_micros() as u64;
        self.tick_us = (self.tick_us.0 + us, self.tick_us.1.max(us));
        if self.ticks % 200 == 0 {
            self.log_status(h);
            self.tick_us = (0, 0);
            self.jumps = 0;
        }
    }

    /// When the (first) human is teleported, put the bots next to it again right away; when it
    /// leaves the area the graph covers, build a new graph around it.
    fn follow_human_moves(&mut self, h: &dyn BotHost) {
        let Some(now) = h.humans(1).into_iter().next() else {
            return;
        };
        if let Some(prev) = self.last_human.replace(now) {
            if hdist2(prev, now) > TELEPORT_JUMP * TELEPORT_JUMP {
                for b in &mut self.bots {
                    b.placed = false;
                }
            }
        }
        if let Some(c) = self.nav_center {
            if hdist2(c, now) > (NAV_RADIUS * 0.7).powi(2) {
                self.nav = None;
                self.build = None;
                self.nav_center = None;
            }
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
                self.bots.push(Bot { id, num: k, added: self.ticks, seen: false, placed: false, far_ticks: 0, released_at: None, sight: Vec::new(), view: None, jumped: false, brain: Brain::new(skill, 1000 + i as u64), heading_acc: 0.0, pitch_acc: 0.0 });
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
            self.nav_center = Some(human);
        }
        let Some(build) = self.build.as_mut() else {
            return;
        };
        let w = RayWorld { h };
        // slices of NAV_SLICE rays until the tick's ray budget or NAV_TIME_BUDGET is spent: a ray in
        // a big level costs much more than in a small one, and this runs inside the server's tick
        let start = std::time::Instant::now();
        let (r0, mut done) = (build.rays_cast(), false);
        while build.rays_cast() - r0 < NAV_RAYS_PER_TICK {
            if build.step(&w, NAV_SLICE.min(NAV_RAYS_PER_TICK - (build.rays_cast() - r0))) {
                done = true;
                break;
            }
            if start.elapsed() > NAV_TIME_BUDGET {
                break;
            }
        }
        if done {
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
        let inner: &dyn Paths = match self.nav.as_ref() {
            Some(nav) => nav,
            None => &direct,
        };
        let paths = BudgetPaths { inner, left: std::cell::Cell::new(PATHS_PER_TICK) };
        for i in 0..self.bots.len() {
            self.bots[i].jumped = false;
            Self::act_one(self.ticks, h, &paths, &mut self.bots[i], &humans, &enemies, &items);
        }
        self.jumps += self.bots.iter().filter(|b| b.jumped).count() as u32;
    }

    fn act_one(ticks: u32, h: &dyn BotHost, paths: &dyn Paths, b: &mut Bot, humans: &[[f32; 3]], enemies: &[(i32, [f32; 3], f32)], items: &[(i32, [f32; 3])]) {
        let Some(st) = h.bot_state(b.id) else {
            return;
        };
        if st.health <= 0.0 || st.blocked != 0 {
            // a respawn, a camera or the level's auto-actions set the view: take it from the engine
            // again once the bot is free
            b.view = None;
        }
        if st.health <= 0.0 {
            // Dead: press FIRE on even 10-tick blocks, release on odd ones;
            // the engine respawns on a new press.
            let fire = (ticks / 10) % 2 == 0;
            h.bot_action(b.id, [0.0, 0.0, 0.0], [b.heading_acc, b.pitch_acc, 0.0], fire as u32 * buttons::FIRE);
            return;
        }
        if st.blocked & 1 != 0 {
            // a camera sequence (a level intro) ignores turning and moving until a NEW fire or use
            // press: tap USE (it doesn't shoot) until the camera lets go
            let tap = (ticks / 5) % 2 == 0;
            h.bot_action(b.id, [0.0, 0.0, 0.0], [b.heading_acc, b.pitch_acc, 0.0], tap as u32 * buttons::USE);
            return;
        }
        if st.blocked & 2 != 0 {
            // auto-actions: the level moves the player along its markers. A bot that joins after
            // the intro runs it alone and its waits never end: ask the engine to let go (every
            // second, in case the level starts another sequence) and stand still meanwhile
            if b.released_at.map_or(true, |t| ticks.saturating_sub(t) >= 20) {
                h.bot_release(b.id);
                b.released_at = Some(ticks);
            }
            h.bot_action(b.id, [0.0, 0.0, 0.0], [b.heading_acc, b.pitch_acc, 0.0], 0);
            return;
        }
        if Self::keep_near_humans(h, b, &st, humans) {
            return;
        }
        let check = (ticks + b.num as u32) % 2 == 0;
        let mut sense = sense(h, st, humans, enemies, items, ticks as f64 * TICK as f64, &mut b.sight, check);
        let (yaw, pitch) = *b.view.get_or_insert((st.heading, st.pitch));
        sense.yaw = yaw;
        sense.pitch = pitch;
        let a = b.brain.think(&sense, paths);
        b.heading_acc += a.turn_yaw;
        b.pitch_acc += a.turn_pitch;
        b.view = Some((yaw + a.turn_yaw, (pitch + a.turn_pitch).clamp(-PITCH_MAX, PITCH_MAX)));
        b.jumped = a.jump;
        let mv = [a.strafe * 10.0, if a.jump { 11.0 } else { 0.0 }, -a.forward * 10.0];
        let btns = a.fire as u32 * buttons::FIRE;
        h.bot_action(b.id, mv, [b.heading_acc, b.pitch_acc, 0.0], btns);
    }

    /// Put the bot next to the nearest human the first time it can move, and bring it back when
    /// it has been far from every human for a while (stuck behind a door, lost). True when it was
    /// moved this tick.
    fn keep_near_humans(h: &dyn BotHost, b: &mut Bot, st: &HostBotState, humans: &[[f32; 3]]) -> bool {
        let Some(&near) = humans.iter().min_by(|x, y| hdist2(**x, st.eye).total_cmp(&hdist2(**y, st.eye))) else {
            return false;
        };
        let far = hdist2(near, st.eye) > FAR_FROM_HUMANS * FAR_FROM_HUMANS;
        b.far_ticks = if far && b.brain.state() != BotState::Fight { b.far_ticks + 1 } else { 0 };
        if b.placed && b.far_ticks < FAR_TICKS {
            return false;
        }
        b.placed = true;
        b.far_ticks = 0;
        let spot = spot_near(h, near, b.num);
        h.bot_teleport(b.id, spot, b.view.map_or(st.heading, |v| v.0));
        b.view = None;
        true
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
                "[{} {} hp {} at {} {} heading {} pitch {} weapon {} blocked {}]",
                b.id,
                state,
                st.health.round() as i32,
                st.eye[0].round() as i32,
                st.eye[2].round() as i32,
                st.heading.round() as i32,
                st.pitch.round() as i32,
                st.weapon,
                st.blocked
            ));
        }
        h.log(&format!("se1mod: bots: {n} {} | tick avg {:.2} ms, worst {:.2} ms, jumps {}", parts.join(" "), self.tick_us.0 as f64 / 200_000.0, self.tick_us.1 as f64 / 1000.0, self.jumps));
    }

    pub fn level_started(&mut self) {
        // the engine keeps players (bots included) across a level change: keep ours, and put them
        // next to the humans again once they can move
        for b in &mut self.bots {
            b.placed = false;
            b.far_ticks = 0;
            b.released_at = None;
            b.sight.clear();
        }
        self.build = None;
        self.nav = None;
        self.nav_center = None;
        self.last_human = None;
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

fn hdist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)
}

/// A free spot about PLACE_RADIUS from a human (feet position), its own direction per bot number so
/// bots don't stand in each other: no wall between (a ray at chest height) and a floor under it
/// (a ray down). Falls back to a closer ring, then to the human's own spot.
fn spot_near(h: &dyn BotHost, human: [f32; 3], num: i32) -> [f32; 3] {
    let a = (num as f32 - 1.0) * 2.0944 + 0.5236; // 120° apart, starting at 30°
    for r in [PLACE_RADIUS, PLACE_RADIUS / 2.0] {
        let p = [human[0] + a.cos() * r, human[1], human[2] + a.sin() * r];
        let chest = |q: [f32; 3]| [q[0], q[1] + 1.0, q[2]];
        if h.ray(chest(human), chest(p), false).is_some() {
            continue;
        }
        if let Some(d) = h.ray(chest(p), [p[0], p[1] - 2.0, p[2]], false) {
            return [p[0], p[1] + 1.0 - d, p[2]];
        }
    }
    human
}

/// What bot `st` senses this tick: foes within range (nearest first, at most
/// `MAX_FOES`, the nearest `VISIBLE_CHECKS` with a visibility ray), items, and
/// the nearest human.
#[allow(clippy::too_many_arguments)]
fn sense(h: &dyn BotHost, st: HostBotState, humans: &[[f32; 3]], enemies: &[(i32, [f32; 3], f32)], items: &[(i32, [f32; 3])], time: f64, sight: &mut Vec<(i32, bool)>, check: bool) -> Sense {
    let pos = st.eye;
    let mut foes: Vec<(f32, i32, [f32; 3])> = enemies
        .iter()
        .filter(|(_, p, _)| ((p[0] - pos[0]).powi(2) + (p[2] - pos[2]).powi(2)).sqrt() <= FOE_RANGE)
        .map(|(id, p, _)| (((p[0] - pos[0]).powi(2) + (p[2] - pos[2]).powi(2)).sqrt(), *id, *p))
        .collect();
    foes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    foes.truncate(MAX_FOES);
    // line of sight: on its checking ticks a bot casts rays to its nearest VISIBLE_CHECKS foes; in
    // between (and for farther foes) it remembers what it last saw. Keeps the ray count per tick
    // low with many bots.
    let known = std::mem::take(sight);
    let foes: Vec<Foe> = foes
        .into_iter()
        .enumerate()
        .map(|(i, (_, id, p))| {
            let visible = if check && i < VISIBLE_CHECKS {
                h.ray(pos, [p[0], p[1] + 1.0, p[2]], false).is_none()
            } else {
                known.iter().find(|(k, _)| *k == id).map_or(false, |(_, v)| *v)
            };
            Foe { id, pos: p, visible, ranged: true }
        })
        .collect();
    *sight = foes.iter().map(|f| (f.id, f.visible)).collect();
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
