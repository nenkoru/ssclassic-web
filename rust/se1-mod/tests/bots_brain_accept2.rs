//! Acceptance tests, round 2: the bugs found in review of the first brain.
use se1_mod::bots::brain::{forward, look_at, right, Action, BotState, Brain, Foe, Paths, Sense};
use std::cell::RefCell;

/// Open field; records the seeds given to random_near.
struct Field {
    seeds: RefCell<Vec<u64>>,
}
impl Field {
    fn new() -> Self {
        Field { seeds: RefCell::new(vec![]) }
    }
}
impl Paths for Field {
    fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
        Some(vec![[from[0], 0.0, from[2]], [(from[0] + to[0]) / 2.0, 0.0, (from[2] + to[2]) / 2.0], [to[0], 0.0, to[2]]])
    }
    fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
        self.seeds.borrow_mut().push(seed);
        let a = (seed % 360) as f32 * 0.0174533;
        Some([p[0] + a.cos() * r * 0.8, 0.0, p[2] + a.sin() * r * 0.8])
    }
}

const DT: f32 = 1.0 / 60.0;
const SPEED: f32 = 8.0;

fn wrap(a: f32) -> f32 {
    let mut a = a % 360.0;
    if a > 180.0 { a -= 360.0 }
    if a < -180.0 { a += 360.0 }
    a
}
fn hdist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

struct Sim {
    s: Sense,
    moves: bool,
    log: Vec<Action>,
}
impl Sim {
    fn new() -> Self {
        Sim { s: Sense { time: 0.0, dt: DT, pos: [0.0, 1.7, 0.0], yaw: 0.0, pitch: 0.0, hp: 100.0, foes: vec![], items: vec![], leader: None }, moves: true, log: vec![] }
    }
    fn tick(&mut self, b: &mut Brain, nav: &dyn Paths) -> Action {
        let a = b.think(&self.s, nav);
        if self.moves {
            let (f, r) = (forward(self.s.yaw, 0.0), right(self.s.yaw));
            let (fw, st) = (a.forward.clamp(-1.0, 1.0), a.strafe.clamp(-1.0, 1.0));
            self.s.pos[0] += (f[0] * fw + r[0] * st) * SPEED * DT;
            self.s.pos[2] += (f[2] * fw + r[2] * st) * SPEED * DT;
        }
        self.s.yaw = wrap(self.s.yaw + a.turn_yaw);
        self.s.pitch = (self.s.pitch + a.turn_pitch).clamp(-89.0, 89.0);
        self.log.push(a.clone());
        self.s.time += DT as f64;
        a
    }
    fn run(&mut self, b: &mut Brain, nav: &dyn Paths, secs: f32) {
        for _ in 0..(secs / DT) as usize {
            self.tick(b, nav);
        }
    }
}
fn foe(id: i32, x: f32, z: f32) -> Foe {
    Foe { id, pos: [x, 1.0, z], visible: true, ranged: true }
}

#[test]
fn target_removed_from_the_list_does_not_panic() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 1);
    let mut sim = Sim::new();
    sim.s.foes = vec![foe(1, 0.0, -15.0), foe(2, 10.0, -30.0)];
    sim.run(&mut b, &nav, 1.0);
    assert_eq!(b.target(), Some(1));
    sim.s.foes.retain(|f| f.id != 1); // killed: gone from the senses
    sim.run(&mut b, &nav, 1.0);
    assert_eq!(b.target(), Some(2), "moves on to the remaining foe");
    sim.s.foes.clear();
    sim.run(&mut b, &nav, 0.5);
    assert_eq!(b.target(), None);
    assert_ne!(b.state(), BotState::Fight);
}

#[test]
fn closes_in_on_a_far_foe() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 2);
    let mut sim = Sim::new();
    sim.s.foes = vec![foe(1, 0.0, -45.0)];
    sim.run(&mut b, &nav, 5.0);
    let d = hdist(sim.s.pos, sim.s.foes[0].pos);
    assert!(d <= 26.0, "walks into the 6-25 m band, still {d} m away");
}

#[test]
fn backs_off_from_a_close_foe() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 3);
    let mut sim = Sim::new();
    sim.s.foes = vec![foe(1, 0.0, -2.5)];
    sim.run(&mut b, &nav, 3.0);
    let d = hdist(sim.s.pos, sim.s.foes[0].pos);
    assert!(d >= 5.0, "backs off to 6 m or more, only {d} m away");
}

#[test]
fn switching_target_follows_the_half_distance_rule_and_restarts_reaction() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 4);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.foes = vec![foe(1, 0.0, -20.0)];
    sim.run(&mut b, &nav, 1.5);
    assert_eq!(b.target(), Some(1));
    sim.s.foes.push(foe(2, 15.0, 0.0)); // 15 m: closer, but not closer than half of 20
    sim.run(&mut b, &nav, 0.5);
    assert_eq!(b.target(), Some(1), "keeps the current target");
    sim.s.foes.push(foe(3, -8.0, 0.0)); // 8 m < 10 m: switch
    sim.tick(&mut b, &nav);
    assert_eq!(b.target(), Some(3), "switches to a foe closer than half the distance");
    let yaw_at_switch = sim.s.yaw;
    sim.run(&mut b, &nav, 0.2); // reaction at skill 0.5 is 0.30 s
    assert!(wrap(sim.s.yaw - yaw_at_switch).abs() < 1.0, "a new target gets a new reaction delay");
}

#[test]
fn fires_only_where_it_aims() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 5);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.foes = vec![foe(1, 0.0, -20.0)];
    sim.run(&mut b, &nav, 1.5);
    sim.s.foes.push(foe(2, 14.0, -2.0)); // nearer, but not enough to switch
    for _ in 0..120 {
        let a = sim.tick(&mut b, &nav);
        if a.fire {
            let t = b.target().expect("firing needs a target");
            let p = sim.s.foes.iter().find(|f| f.id == t).unwrap().pos;
            let (y, _) = look_at(sim.s.pos, p);
            assert!(wrap(y - sim.s.yaw).abs() < 4.6, "fires at its own target, error {}", wrap(y - sim.s.yaw));
        }
    }
}

#[test]
fn notices_being_stuck_after_walking() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 6);
    let mut sim = Sim::new();
    sim.s.leader = Some([0.0, 1.7, -200.0]);
    sim.run(&mut b, &nav, 4.0); // walks freely for a while
    let before = b.repaths();
    sim.moves = false; // then hits an invisible wall
    let mut jumped = false;
    for _ in 0..(2.5 / DT) as usize {
        jumped |= sim.tick(&mut b, &nav).jump;
    }
    assert!(jumped, "jumps when stuck after walking");
    assert!(b.repaths() > before, "repaths when stuck after walking");
}

#[test]
fn roam_goals_use_fresh_random_seeds() {
    let nav = Field::new();
    let mut b = Brain::new(0.5, 7);
    let mut sim = Sim::new();
    sim.run(&mut b, &nav, 40.0);
    let seeds = nav.seeds.borrow();
    assert!(seeds.len() >= 3, "picks several roam goals in 40 s, got {}", seeds.len());
    let distinct: std::collections::HashSet<_> = seeds.iter().collect();
    assert_eq!(distinct.len(), seeds.len(), "every roam goal gets a new seed: {seeds:?}");
}
