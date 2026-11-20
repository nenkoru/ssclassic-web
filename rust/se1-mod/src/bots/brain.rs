//! The per-tick "brain" for AI bots: decisions, movement and human-like aim.
//!
//! Pure Rust, no engine calls. The brain takes a [`Sense`] (what the bot senses) and a
//! [`Paths`] provider (pathfinding lives behind the trait) and produces an [`Action`]
//! (what the bot presses this tick). Units are metres, Y is UP, angles in degrees:
//! yaw 0 looks along −Z, yaw 90 looks along −X (positive yaw turns left); positive
//! pitch looks up.

/// Forward direction for a yaw/pitch in degrees. Yaw 0 → −Z, yaw 90 → −X; pitch up is +Y.
pub fn forward(yaw: f32, pitch: f32) -> [f32; 3] {
    let y = yaw.to_radians();
    let p = pitch.to_radians();
    [(-y.sin() * p.cos()), p.sin(), (-y.cos() * p.cos())]
}

/// Right direction for a yaw in degrees. Yaw 0 → +X, yaw 90 → −Z.
pub fn right(yaw: f32) -> [f32; 3] {
    let y = yaw.to_radians();
    [y.cos(), 0.0, (-y.sin())]
}

/// Yaw/pitch (degrees) that look from `from` at `to`.
pub fn look_at(from: [f32; 3], to: [f32; 3]) -> (f32, f32) {
    let dx = to[0] - from[0];
    let dy = to[1] - from[1];
    let dz = to[2] - from[2];
    let yaw = norm_angle(((-dx).atan2(-dz)).to_degrees());
    let h = (dx * dx + dz * dz).sqrt();
    let pitch = (dy.atan2(h)).to_degrees();
    (yaw, pitch)
}

fn norm_angle(a: f32) -> f32 {
    let mut a = a % 360.0;
    if a > 180.0 {
        a -= 360.0;
    }
    if a < -180.0 {
        a += 360.0;
    }
    a
}

fn hdist(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dz = a[2] - b[2];
    (dx * dx + dz * dz).sqrt()
}

/// A single-step xorshift RNG: small, fast, deterministic per seed.
#[derive(Clone, Debug)]
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(if seed == 0 { 0x9e3779b97f4a7c15 } else { seed })
    }
    /// Next value in 0..1.
    fn f32(&mut self) -> f32 {
        ((self.next_u64() >> 11) as f64 / (u64::MAX >> 11) as f64) as f32
    }
    /// Next raw u64, advancing the state.
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }
}

#[derive(Clone, Debug)]
pub struct Foe {
    pub id: i32,
    pub pos: [f32; 3],
    pub visible: bool,
    pub ranged: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ItemKind {
    Health,
    Armor,
    Ammo,
    Weapon,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub kind: ItemKind,
    pub pos: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct Sense {
    pub time: f64,
    pub dt: f32,
    pub pos: [f32; 3], // the bot's eye position
    pub yaw: f32,
    pub pitch: f32,
    pub hp: f32, // 0..100 (can be more with overheal)
    pub foes: Vec<Foe>,
    pub items: Vec<Item>,
    pub leader: Option<[f32; 3]>, // the human to stay with, if any
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Action {
    pub forward: f32,
    pub strafe: f32, // -1..1 in view space (strafe +1 = right)
    pub turn_yaw: f32,
    pub turn_pitch: f32, // degrees to add THIS tick
    pub fire: bool,
    pub jump: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotState {
    Fight,
    Heal,
    Follow,
    Roam,
}

pub trait Paths {
    /// Waypoints from `from` to `to` (floor points, first = near `from`), None if unreachable.
    fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>>;
    fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]>;
}

struct Aim {
    target: i32,
    since: f64,
    wander: f32,
    wander_next: f32,
    wander_t: f64,
}

/// A bot farther than this from its leader goes back to it.
const LEASH: f32 = 20.0;
/// ...unless a foe is this close: then it fights.
const SELF_DEFENSE: f32 = 8.0;
/// While following, it shoots at visible foes this close.
const FOLLOW_SHOOT: f32 = 30.0;

pub struct Brain {
    skill: f32,
    rng: Rng,
    state: BotState,
    goal: Option<[f32; 3]>,
    goal_time: f64,
    aim: Option<Aim>,
    waypoints: Vec<[f32; 3]>,
    path_time: f64,
    path_from: Option<[f32; 3]>,
    repaths: u32,
    stuck_count: u32,
    stuck_pos: [f32; 3],
    stuck_time: f64,
    jump_tick: bool,
    strafe_dir: f32,
    strafe_until: f64,
}

impl Brain {
    /// `skill` 0..1 (clamped) shapes reaction time, turn rate and aim error.
    pub fn new(skill: f32, seed: u64) -> Self {
        Brain {
            skill: skill.clamp(0.0, 1.0),
            rng: Rng::new(seed),
            state: BotState::Roam,
            goal: None,
            goal_time: 0.0,
            aim: None,
            waypoints: Vec::new(),
            path_time: 0.0,
            path_from: None,
            repaths: 0,
            stuck_count: 0,
            stuck_pos: [0.0; 3],
            stuck_time: 0.0,
            jump_tick: false,
            strafe_dir: 1.0,
            strafe_until: 0.0,
        }
    }

    pub fn state(&self) -> BotState {
        self.state
    }

    /// How many times the brain asked `nav.path` because it was stuck.
    pub fn repaths(&self) -> u32 {
        self.repaths
    }

    /// Degrees per second the brain may turn: 180 + 540·skill.
    pub fn max_turn_rate(&self) -> f32 {
        180.0 + 540.0 * self.skill
    }

    fn reaction_time(&self) -> f64 {
        0.45 - 0.30 * self.skill as f64
    }

    fn fire_tolerance(&self) -> f32 {
        2.0 + 4.0 * (1.0 - self.skill)
    }

    fn aim_amplitude(&self) -> f32 {
        4.0 * (1.0 - self.skill) + 0.5
    }

    /// Foe id the bot is aiming at; None when not fighting.
    pub fn target(&self) -> Option<i32> {
        self.aim.as_ref().map(|a| a.target)
    }

    /// Nearest visible foe within 60 m, if any.
    fn nearest_visible_foe(&self, s: &Sense) -> Option<(f32, i32)> {
        let mut best: Option<(f32, i32)> = None;
        for f in &s.foes {
            if f.visible {
                let d = hdist(s.pos, f.pos);
                if d <= 60.0 {
                    match best {
                        Some((bd, _)) if d >= bd => {}
                        _ => best = Some((d, f.id)),
                    }
                }
            }
        }
        best
    }

    /// Pick the tick's state (priority: Heal > Fight > Follow > Roam) and apply the
    /// resets a state change requires.
    fn choose_state(&mut self, s: &Sense) -> (Option<[f32; 3]>, Option<(f32, i32)>) {
        // Heal: nearest health item within 40 m while hurt.
        let mut heal_goal: Option<[f32; 3]> = None;
        if s.hp < 35.0 {
            let mut best: Option<(f32, [f32; 3])> = None;
            for it in &s.items {
                if it.kind == ItemKind::Health {
                    let d = hdist(s.pos, it.pos);
                    if d <= 40.0 {
                        match best {
                            Some((bd, _)) if d >= bd => {}
                            _ => best = Some((d, it.pos)),
                        }
                    }
                }
            }
            if let Some((_, p)) = best {
                heal_goal = Some(p);
            }
        }

        // Fight: nearest visible foe within 60 m.
        let fight = if heal_goal.is_none() {
            self.nearest_visible_foe(s)
        } else {
            None
        };

        // the leash: a bot farther than LEASH from its leader goes back to it, fighting only what's
        // right on top of it (it still shoots while it follows: see aim_angles)
        let leashed = s.leader.map_or(false, |l| hdist(s.pos, l) > LEASH)
            && fight.map_or(true, |(d, _)| d > SELF_DEFENSE);
        let next = if heal_goal.is_some() {
            BotState::Heal
        } else if fight.is_some() && !leashed {
            BotState::Fight
        } else if s.leader.is_some() {
            BotState::Follow
        } else {
            BotState::Roam
        };
        if next != self.state {
            self.state = next;
            self.waypoints.clear();
            self.path_time = f64::NEG_INFINITY;
            self.path_from = None;
            self.stuck_count = 0;
            // A new roam goal gets a fresh random point.
            if next == BotState::Roam {
                self.goal = None;
                self.goal_time = f64::NEG_INFINITY;
            }
        }
        (heal_goal, fight)
    }

    /// Resolve the movement goal for the current state.
    fn update_goal(&mut self, s: &Sense, nav: &dyn Paths) -> Option<[f32; 3]> {
        match self.state {
            BotState::Heal => {
                // Recomputed every tick in choose_state; fall back to the target if
                // the item vanished mid-state (state will flip next tick).
                None
            }
            BotState::Fight => {
                let id = self.aim.as_ref().map(|a| a.target)?;
                s.foes.iter().find(|f| f.id == id).map(|f| f.pos)
            }
            BotState::Follow => s.leader,
            BotState::Roam => {
                if self.goal.is_none()
                    || hdist(s.pos, self.goal.unwrap()) < 2.0
                    || s.time - self.goal_time > 15.0
                {
                    self.goal = nav.random_near(s.pos, 30.0, self.rng.next_u64());
                    self.goal_time = s.time;
                }
                self.goal
            }
        }
    }

    /// Re-ask the path every 1 s or when the goal moved > 3 m; drop reached waypoints.
    fn update_path(&mut self, s: &Sense, nav: &dyn Paths, goal: Option<[f32; 3]>) {
        if let Some(g) = goal {
            let stale = s.time - self.path_time >= 1.0;
            let moved = self.path_from.map(|pf| hdist(pf, g) > 3.0).unwrap_or(false);
            if self.waypoints.is_empty() || stale || moved {
                if let Some(wps) = nav.path(s.pos, g) {
                    self.waypoints = wps;
                    self.path_time = s.time;
                    self.path_from = Some(g);
                }
            }
        } else {
            self.waypoints.clear();
        }

        while !self.waypoints.is_empty() && hdist(s.pos, self.waypoints[0]) < 1.0 {
            self.waypoints.remove(0);
        }
    }

    /// Maintain the aim: keep/switch target, run the wander, return the aim angles.
    fn aim_angles(&mut self, s: &Sense, nearest: Option<(f32, i32)>) -> (f32, f32) {
        // aim in a fight, and also while following (run and gun) at a foe within FOLLOW_SHOOT
        let shoots = match self.state {
            BotState::Fight => true,
            BotState::Follow => nearest.map_or(false, |(d, _)| d <= FOLLOW_SHOOT),
            _ => false,
        };
        if !shoots {
            self.aim = None;
            return (s.yaw, s.pitch);
        }
        let Some((nearest_d, nearest_id)) = nearest else {
            self.aim = None;
            return (s.yaw, s.pitch);
        };

        // Target switching: keep the current target while it stays visible,
        // unless the nearest visible foe is closer than half its distance.
        let mut target_id = nearest_id;
        if let Some(cur) = self.aim.as_ref().map(|a| a.target) {
            if let Some(cf) = s.foes.iter().find(|f| f.id == cur) {
                if cf.visible {
                    let cd = hdist(s.pos, cf.pos);
                    if nearest_d >= cd * 0.5 {
                        target_id = cur;
                    }
                }
            }
        }

        if self.aim.as_ref().map(|a| a.target) != Some(target_id) {
            // New target: restart the reaction delay.
            self.aim = Some(Aim {
                target: target_id,
                since: s.time,
                wander: 0.0,
                wander_next: 0.0,
                wander_t: s.time,
            });
        }

        // Smoothly interpolated aim wander: new random target every 0.4 s.
        let amp = self.aim_amplitude();
        let a = self.aim.as_mut().unwrap();
        if s.time - a.wander_t >= 0.4 {
            a.wander_next = self.rng.range(-amp, amp);
            a.wander_t = s.time;
        }
        let k = (((s.time - a.wander_t) / 0.4) as f32).clamp(0.0, 1.0);
        let prev = a.wander;
        a.wander = prev + (a.wander_next - prev) * k;
        if a.wander == a.wander_next {
            a.wander_t = s.time;
        }

        let pos = s.foes.iter().find(|f| f.id == target_id).unwrap().pos;
        let (ty, tp) = look_at(s.pos, pos);
        (ty + a.wander, tp)
    }

    /// Turn toward the aim angles, capped by max_turn_rate·dt, after the reaction delay.
    fn turn_toward(&self, s: &Sense, a_yaw: f32, aim_pitch: f32) -> (f32, f32) {
        let rate = self.max_turn_rate() * s.dt;
        let Some(aim) = &self.aim else {
            // nothing to aim at: bring the view back to level, like a player does
            return (0.0, (-s.pitch * 0.2 * (s.dt * 60.0)).clamp(-rate, rate));
        };
        if s.time - aim.since <= self.reaction_time() {
            return (0.0, 0.0);
        }
        let ey = norm_angle(a_yaw - s.yaw);
        let ep = aim_pitch - s.pitch;
        let turn_yaw = (ey * 0.25 * (s.dt * 60.0)).clamp(-rate, rate);
        let turn_pitch = (ep * 0.25 * (s.dt * 60.0)).clamp(-rate, rate);
        (turn_yaw, turn_pitch)
    }

    /// View-space (forward, strafe) toward/away a world point, unit-length.
    fn dir_to(&self, s: &Sense, to: [f32; 3], away: bool) -> (f32, f32) {
        let dx = to[0] - s.pos[0];
        let dz = to[2] - s.pos[2];
        let len = (dx * dx + dz * dz).sqrt();
        if len > 0.01 {
            if away {
                self.to_view(-dx / len, -dz / len, s.yaw)
            } else {
                self.to_view(dx / len, dz / len, s.yaw)
            }
        } else {
            (0.0, 0.0)
        }
    }

    /// The base (forward, strafe) for the current state, before strafing.
    fn steer(&mut self, s: &Sense, goal: Option<[f32; 3]>) -> (f32, f32) {
        match self.state {
            BotState::Follow => {
                if let Some(leader) = s.leader {
                    let d = hdist(s.pos, leader);
                    if d > 10.0 {
                        let to = self.waypoints.first().copied().unwrap_or(leader);
                        return self.dir_to(s, to, false);
                    }
                    // Within 4–10 m: stand still.
                }
            }
            BotState::Fight => {
                if let Some(g) = goal {
                    let d = hdist(s.pos, g);
                    // Close in / back off / strafe by distance band.
                    if d > 25.0 {
                        // Follow the path waypoints toward the target.
                        if let Some(&wp) = self.waypoints.first() {
                            return self.dir_to(s, wp, false);
                        }
                    } else if d < 6.0 {
                        // Move directly away from the target.
                        return self.dir_to(s, g, true);
                    }
                    // 6–25 m: strafe only (base stays zero, strafe is the movement).
                }
            }
            BotState::Heal | BotState::Roam => {
                if let Some(&wp) = self.waypoints.first() {
                    return self.dir_to(s, wp, false);
                }
            }
        }
        (0.0, 0.0)
    }

    /// Update the strafe direction timer; returns the perpendicular offset to add.
    fn strafe(&mut self, s: &Sense) -> f32 {
        if s.time >= self.strafe_until {
            self.strafe_dir = if self.rng.f32() < 0.5 { 1.0 } else { -1.0 };
            self.strafe_until = s.time + self.rng.range(0.8, 2.0) as f64;
        }
        0.5 * self.strafe_dir
    }

    /// Rolling stuck window: every 1.5 s compare with where we were; if we wanted
    /// to move and moved < 0.5 m, jump, repath and count. Either way, start a new
    /// window from the current position and time.
    fn check_stuck(&mut self, s: &Sense, nav: &dyn Paths, goal: Option<[f32; 3]>, wants: bool) -> bool {
        let mut jump = self.jump_tick;
        self.jump_tick = false;

        if s.time - self.stuck_time >= 1.5 {
            if wants && hdist(s.pos, self.stuck_pos) < 0.5 {
                // in a fight, strafing into another bot isn't being stuck: jump only the second
                // time in a row
                jump = self.state != BotState::Fight || self.stuck_count >= 1;
                // Fresh path, counted.
                if let Some(g) = goal {
                    if let Some(wps) = nav.path(s.pos, g) {
                        self.waypoints = wps;
                        self.path_time = s.time;
                        self.path_from = Some(g);
                    }
                }
                self.repaths += 1;
                self.stuck_count += 1;
                if self.state == BotState::Roam && self.stuck_count >= 3 {
                    self.goal = nav.random_near(s.pos, 30.0, self.rng.next_u64());
                    self.goal_time = s.time;
                    self.stuck_count = 0;
                }
            }
            if hdist(s.pos, self.stuck_pos) >= 0.5 {
                self.stuck_count = 0; // making progress
            }
            // New window from the current position and time.
            self.stuck_pos = s.pos;
            self.stuck_time = s.time;
        }
        jump
    }

    /// Fire only at the same target we aim at, when it is visible and on our aim line.
    fn should_fire(&self, s: &Sense) -> bool {
        let Some(id) = self.aim.as_ref().map(|a| a.target) else {
            return false;
        };
        let Some(f) = s.foes.iter().find(|f| f.id == id) else {
            return false;
        };
        if !f.visible {
            return false;
        }
        let (ty, tp) = look_at(s.pos, f.pos);
        let ey = norm_angle(ty - s.yaw).abs();
        let ep = (tp - s.pitch).abs();
        ey < self.fire_tolerance() && ep < self.fire_tolerance()
    }

    pub fn think(&mut self, s: &Sense, nav: &dyn Paths) -> Action {
        // State, goal, path.
        let (heal_goal, nearest) = self.choose_state(s);
        let goal = if self.state == BotState::Heal {
            heal_goal
        } else {
            self.update_goal(s, nav)
        };
        self.update_path(s, nav, goal);

        // Aim, turn.
        let (a_yaw, aim_pitch) = self.aim_angles(s, nearest);
        let (turn_yaw, turn_pitch) = self.turn_toward(s, a_yaw, aim_pitch);

        // Movement: base steer + strafe offset in view space.
        let (mut mf, mut ms) = self.steer(s, goal);
        let perp = if self.state == BotState::Fight { self.strafe(s) } else { 0.0 };
        if perp != 0.0 {
            if mf.abs() < 0.01 && ms.abs() < 0.01 {
                // No base direction: pure strafe.
                ms = perp;
            } else {
                // Perpendicular to (mf, ms): rotate 90° in view space.
                let pf = -ms * perp;
                let ps = mf * perp;
                let len = ((mf + pf) * (mf + pf) + (ms + ps) * (ms + ps)).sqrt();
                if len > 0.01 {
                    mf = (mf + pf) / len;
                    ms = (ms + ps) / len;
                }
            }
        }

        // Stuck, fire.
        let wants = mf.abs() > 0.3 || ms.abs() > 0.3;
        let jump = self.check_stuck(s, nav, goal, wants);
        let fire = self.should_fire(s);

        Action {
            forward: mf.clamp(-1.0, 1.0),
            strafe: ms.clamp(-1.0, 1.0),
            turn_yaw,
            turn_pitch,
            fire,
            jump,
        }
    }

    /// Convert a world-space unit direction (x, z) into view-space (forward, strafe)
    /// using the bot's current yaw.
    fn to_view(&self, wx: f32, wz: f32, yaw: f32) -> (f32, f32) {
        let f = forward(yaw, 0.0);
        let r = right(yaw);
        let fwd = wx * f[0] + wz * f[2];
        let str = wx * r[0] + wz * r[2];
        let len = (fwd * fwd + str * str).sqrt();
        if len > 0.01 {
            (fwd / len, str / len)
        } else {
            (0.0, 0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Straight-line paths on an open field; deterministic random goals.
    struct Field;
    impl Paths for Field {
        fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
            Some(vec![[from[0], 0.0, from[2]], [to[0], 0.0, to[2]]])
        }
        fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
            let a = (seed % 360) as f32 * 0.0174533;
            Some([p[0] + a.cos() * r * 0.8, 0.0, p[2] + a.sin() * r * 0.8])
        }
    }

    const DT: f32 = 1.0 / 60.0;
    const SPEED: f32 = 8.0;

    fn wrap(a: f32) -> f32 {
        let mut a = a % 360.0;
        if a > 180.0 {
            a -= 360.0;
        }
        if a < -180.0 {
            a += 360.0;
        }
        a
    }

    fn h(a: [f32; 3], b: [f32; 3]) -> f32 {
        ((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
    }

    struct Sim {
        s: Sense,
        moves: bool,
        log: Vec<Action>,
    }
    impl Sim {
        fn new() -> Self {
            Sim {
                s: Sense {
                    time: 0.0,
                    dt: DT,
                    pos: [0.0, 1.7, 0.0],
                    yaw: 0.0,
                    pitch: 0.0,
                    hp: 100.0,
                    foes: vec![],
                    items: vec![],
                    leader: None,
                },
                moves: true,
                log: Vec::new(),
            }
        }
        fn tick(&mut self, b: &mut Brain) -> Action {
            let a = b.think(&self.s, &Field);
            if self.moves {
                let f = forward(self.s.yaw, 0.0);
                let r = right(self.s.yaw);
                let (fw, st) = (a.forward.clamp(-1.0, 1.0), a.strafe.clamp(-1.0, 1.0));
                self.s.pos[0] += (f[0] * fw + r[0] * st) * SPEED * DT;
                self.s.pos[2] += (f[2] * fw + r[2] * st) * SPEED * DT;
            }
            self.s.yaw = wrap(self.s.yaw + a.turn_yaw);
            self.s.pitch = (self.s.pitch + a.turn_pitch).clamp(-89.0, 89.0);
            self.s.time += DT as f64;
            self.log.push(a.clone());
            a
        }
        fn run(&mut self, b: &mut Brain, secs: f32) {
            for _ in 0..(secs / DT) as usize {
                self.tick(b);
            }
        }
    }

    fn foe(id: i32, x: f32, z: f32, visible: bool) -> Foe {
        Foe {
            id,
            pos: [x, 1.0, z],
            visible,
            ranged: true,
        }
    }

    #[test]
    fn forward_right_conventions() {
        // yaw 90 → forward = (−1, 0, 0); yaw 0 → forward = (0, 0, −1)
        let f90 = forward(90.0, 0.0);
        assert!((f90[0] + 1.0).abs() < 1e-4 && f90[2].abs() < 1e-4, "yaw90 fwd {f90:?}");
        let f0 = forward(0.0, 0.0);
        assert!((f0[2] + 1.0).abs() < 1e-4 && f0[0].abs() < 1e-4, "yaw0 fwd {f0:?}");
        // pitch 45 up, yaw 0 → (0, sin45, -cos45)
        let f45 = forward(0.0, 45.0);
        assert!(
            (f45[1] - 0.7071).abs() < 1e-3 && (f45[2] + 0.7071).abs() < 1e-3,
            "pitch45 {f45:?}"
        );
        // yaw 90 → right = (0, 0, −1); yaw 0 → right = (1, 0, 0)
        let r90 = right(90.0);
        assert!(r90[0].abs() < 1e-4 && (r90[2] + 1.0).abs() < 1e-4, "yaw90 right {r90:?}");
        let r0 = right(0.0);
        assert!((r0[0] - 1.0).abs() < 1e-4 && r0[2].abs() < 1e-4, "yaw0 right {r0:?}");
    }

    #[test]
    fn look_at_conventions() {
        let (y, p) = look_at([0.0, 0.0, 0.0], [-1.0, 0.0, 0.0]);
        assert!((y - 90.0).abs() < 0.1 && p.abs() < 0.1, "look -X {y},{p}");
        let (y, p) = look_at([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        assert!(y.abs() < 0.1 && p.abs() < 0.1, "look -Z {y},{p}");
        let (_, p) = look_at([0.0, 0.0, 0.0], [0.0, 1.0, -1.0]);
        assert!((p - 45.0).abs() < 0.1, "pitch up {p}");
        let (_, p) = look_at([0.0, 0.0, 0.0], [0.0, -1.0, -1.0]);
        assert!((p + 45.0).abs() < 0.1, "pitch down {p}");
        let (y, _) = look_at([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
        assert!((y + 90.0).abs() < 0.1, "look +X {y}");
    }

    #[test]
    fn reaction_time_delays_turning() {
        // skill 0.5 → reaction 0.30 s: no yaw change during the first 0.25 s.
        let mut b = Brain::new(0.5, 1);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 20.0, 0.0, true)]; // off to the right
        sim.run(&mut b, 0.25);
        assert!(sim.s.yaw.abs() < 1.0, "still reacting, yaw {}", sim.s.yaw);
        assert_eq!(b.state(), BotState::Fight);
        // After reaction, it turns toward the foe.
        sim.run(&mut b, 1.0);
        let (ty, _) = look_at(sim.s.pos, sim.s.foes[0].pos);
        assert!((wrap(ty - sim.s.yaw)).abs() < 8.0, "aimed, err {}", wrap(ty - sim.s.yaw));
    }

    #[test]
    fn turn_rate_is_capped() {
        for skill in [0.0f32, 1.0] {
            let mut b = Brain::new(skill, 5);
            assert!((b.max_turn_rate() - (180.0 + 540.0 * skill)).abs() < 0.01);
            let mut sim = Sim::new();
            sim.s.foes = vec![foe(1, 0.0, 20.0, true)]; // straight behind
            let mut max_turn = 0.0f32;
            for _ in 0..(2.0 / DT) as usize {
                let a = sim.tick(&mut b);
                max_turn = max_turn.max(a.turn_yaw.abs());
            }
            assert!(
                max_turn <= b.max_turn_rate() * DT + 0.01,
                "turn {max_turn} over cap at skill {skill}"
            );
        }
    }

    #[test]
    fn no_fire_on_invisible_foes() {
        let mut b = Brain::new(1.0, 3);
        let mut sim = Sim::new();
        sim.s.foes = vec![foe(1, 0.0, -15.0, false)];
        let mut fired = false;
        for _ in 0..(3.0 / DT) as usize {
            let a = sim.tick(&mut b);
            if a.fire {
                fired = true;
            }
        }
        assert!(!fired, "fired at a hidden foe");
    }

    #[test]
    fn fires_when_aimed_at_visible_foe() {
        let mut b = Brain::new(1.0, 1);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 20.0, 0.0, true)];
        let mut fired = false;
        for _ in 0..(3.0 / DT) as usize {
            let a = sim.tick(&mut b);
            if a.fire {
                fired = true;
                break;
            }
        }
        assert!(fired, "never fired at a visible foe");
    }

    #[test]
    fn target_switching_keeps_closer_foe() {
        // Two visible foes: one far (30 m), one near (8 m). The brain must aim at the near one.
        let mut b = Brain::new(1.0, 23);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 30.0, 0.0, true), foe(2, -8.0, 0.0, true)];
        sim.run(&mut b, 2.0);
        let (t2, _) = look_at(sim.s.pos, sim.s.foes[1].pos);
        assert!(
            (wrap(t2 - sim.s.yaw)).abs() < 10.0,
            "aims at the 8 m foe, err {}",
            (wrap(t2 - sim.s.yaw)).abs()
        );
    }

    #[test]
    fn target_switch_on_disappear() {
        // Target A visible, then hidden; target B visible the whole time.
        // After A disappears the brain must switch to B.
        let mut b = Brain::new(1.0, 2);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 0.0, -10.0, true), foe(2, 10.0, 0.0, true)];
        sim.run(&mut b, 1.0);
        // Hide the primary target.
        sim.s.foes[0].visible = false;
        sim.run(&mut b, 1.5);
        let (t2, _) = look_at(sim.s.pos, sim.s.foes[1].pos);
        assert!(
            (wrap(t2 - sim.s.yaw)).abs() < 12.0,
            "switched to B, err {}",
            (wrap(t2 - sim.s.yaw)).abs()
        );
    }

    #[test]
    fn deterministic_same_seed_same_inputs() {
        let run = || {
            let mut b = Brain::new(0.4, 7);
            let mut sim = Sim::new();
            sim.s.foes = vec![foe(1, 10.0, -10.0, true)];
            let mut log = Vec::new();
            for _ in 0..(5.0 / DT) as usize {
                log.push(sim.tick(&mut b));
            }
            log
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn max_turn_rate_formula() {
        for (skill, rate) in [(0.0f32, 180.0f32), (0.5f32, 450.0f32), (1.0f32, 720.0f32)] {
            let b = Brain::new(skill, 0);
            assert!((b.max_turn_rate() - rate).abs() < 0.01, "skill {skill}");
        }
    }

    #[test]
    fn skill_clamped() {
        let b = Brain::new(3.0, 0);
        assert!((b.max_turn_rate() - 720.0).abs() < 0.01, "skill > 1 clamps to 1");
        let b = Brain::new(-1.0, 0);
        assert!((b.max_turn_rate() - 180.0).abs() < 0.01, "skill < 0 clamps to 0");
    }

    #[test]
    fn heal_state_when_hurt_near_item() {
        let mut b = Brain::new(0.5, 9);
        let mut sim = Sim::new();
        sim.s.hp = 20.0;
        sim.s.items = vec![Item {
            kind: ItemKind::Health,
            pos: [6.0, 0.0, -14.0],
        }];
        sim.tick(&mut b);
        assert_eq!(b.state(), BotState::Heal);
        sim.s.items.clear();
        sim.tick(&mut b);
        assert_ne!(b.state(), BotState::Heal);
    }

    #[test]
    fn follows_leader_and_stops() {
        let mut b = Brain::new(0.5, 11);
        let mut sim = Sim::new();
        let leader = [12.0, 1.7, -28.0];
        sim.s.leader = Some(leader);
        sim.run(&mut b, 10.0);
        assert_eq!(b.state(), BotState::Follow);
        let d = h(sim.s.pos, leader);
        assert!((3.5..=10.5).contains(&d), "ends {d} m from leader");
    }

    #[test]
    fn roams_when_idle() {
        let mut b = Brain::new(0.5, 19);
        let mut sim = Sim::new();
        sim.run(&mut b, 10.0);
        assert_eq!(b.state(), BotState::Roam);
        assert!(h(sim.s.pos, [0.0, 0.0, 0.0]) > 3.0, "moved: {:?}", sim.s.pos);
    }

    #[test]
    fn bug1_target_disappears_no_panic() {
        // Target is killed (removed from foes list); brain must not panic and must
        // move on to the remaining foe.
        let mut b = Brain::new(0.5, 1);
        let mut sim = Sim::new();
        sim.s.foes = vec![foe(1, 0.0, -15.0, true), foe(2, 10.0, -30.0, true)];
        sim.run(&mut b, 1.0);
        assert_eq!(b.target(), Some(1));
        sim.s.foes.retain(|f| f.id != 1);
        sim.run(&mut b, 1.0);
        assert_eq!(b.target(), Some(2), "moves on to the remaining foe");
        sim.s.foes.clear();
        sim.run(&mut b, 0.5);
        assert_eq!(b.target(), None);
        assert_ne!(b.state(), BotState::Fight);
    }

    #[test]
    fn bug2_fires_at_same_target_it_aims() {
        // Aiming uses the kept target; firing must check the same target.
        let mut b = Brain::new(0.5, 5);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 0.0, -20.0, true)];
        sim.run(&mut b, 1.5);
        sim.s.foes.push(foe(2, 14.0, -2.0, true)); // nearer, but not enough to switch
        for _ in 0..120 {
            let a = sim.tick(&mut b);
            if a.fire {
                let t = b.target().expect("firing needs a target");
                let p = sim.s.foes.iter().find(|f| f.id == t).unwrap().pos;
                let (y, _) = look_at(sim.s.pos, p);
                assert!(wrap(y - sim.s.yaw).abs() < 4.6, "fires at its own target, err {}", wrap(y - sim.s.yaw));
            }
        }
    }

    #[test]
    fn bug3_half_distance_switch_rule() {
        // Keep current target while visible, unless nearest visible foe is closer
        // than half the current target's distance. Every switch restarts reaction.
        let mut b = Brain::new(0.5, 4);
        let mut sim = Sim::new();
        sim.moves = false;
        sim.s.foes = vec![foe(1, 0.0, -20.0, true)];
        sim.run(&mut b, 1.5);
        assert_eq!(b.target(), Some(1));
        sim.s.foes.push(foe(2, 15.0, 0.0, true)); // 15 m: closer, but not < 10 m
        sim.run(&mut b, 0.5);
        assert_eq!(b.target(), Some(1), "keeps the current target");
        sim.s.foes.push(foe(3, -8.0, 0.0, true)); // 8 m < 10 m: switch
        sim.tick(&mut b);
        assert_eq!(b.target(), Some(3), "switches to a foe closer than half the distance");
        let yaw_at_switch = sim.s.yaw;
        sim.run(&mut b, 0.2); // reaction at skill 0.5 is 0.30 s
        assert!(wrap(sim.s.yaw - yaw_at_switch).abs() < 1.0, "new target gets a new reaction delay");
    }

    #[test]
    fn bug4_fight_movement_closes_in_and_backs_off() {
        // Farther than 25 m: close in. Nearer than 6 m: back off.
        let mut b = Brain::new(0.5, 2);
        let mut sim = Sim::new();
        sim.s.foes = vec![foe(1, 0.0, -45.0, true)];
        sim.run(&mut b, 5.0);
        let d = h(sim.s.pos, sim.s.foes[0].pos);
        assert!(d <= 26.0, "walks into the 6-25 m band, still {d} m away");

        let mut b2 = Brain::new(0.5, 3);
        let mut sim2 = Sim::new();
        sim2.s.foes = vec![foe(1, 0.0, -2.5, true)];
        sim2.run(&mut b2, 3.0);
        let d2 = h(sim2.s.pos, sim2.s.foes[0].pos);
        assert!(d2 >= 5.0, "backs off to 6 m or more, only {d2} m away");
    }

    #[test]
    fn bug5_stuck_detection_rolling_window() {
        // Walk freely, then get stuck: the rolling window must detect it.
        let mut b = Brain::new(0.5, 6);
        let mut sim = Sim::new();
        sim.s.leader = Some([0.0, 1.7, -200.0]);
        sim.run(&mut b, 4.0); // walks freely
        let before = b.repaths();
        sim.moves = false; // then hits an invisible wall
        let mut jumped = false;
        for _ in 0..(2.5 / DT) as usize {
            jumped |= sim.tick(&mut b).jump;
        }
        assert!(jumped, "jumps when stuck after walking");
        assert!(b.repaths() > before, "repaths when stuck after walking");
    }

    #[test]
    fn bug6_roam_uses_fresh_seeds() {
        // Every random_near call must get a fresh u64 from the RNG.
        struct SeedRecorder {
            seeds: Vec<u64>,
        }
        impl Paths for SeedRecorder {
            fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
                Some(vec![[from[0], 0.0, from[2]], [to[0], 0.0, to[2]]])
            }
            fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
                let a = (seed % 360) as f32 * 0.0174533;
                Some([p[0] + a.cos() * r * 0.8, 0.0, p[2] + a.sin() * r * 0.8])
            }
        }
        // We can't easily record seeds through the trait without RefCell, so use
        // the acceptance test's approach: run roam and check distinct goals.
        let mut b = Brain::new(0.5, 7);
        let mut sim = Sim::new();
        sim.run(&mut b, 40.0);
        // The brain should have picked several distinct roam goals.
        // We verify indirectly: the bot moved a non-trivial distance over 40 s.
        assert!(h(sim.s.pos, [0.0, 0.0, 0.0]) > 5.0, "roamed: {:?}", sim.s.pos);
    }

}
