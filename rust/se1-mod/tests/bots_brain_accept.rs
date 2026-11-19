//! Acceptance tests for the bot brain (bots::brain) with a tiny kinematic simulation.
use se1_mod::bots::brain::{forward, look_at, Action, BotState, Brain, Foe, Item, ItemKind, Paths, Sense};

/// Open field: straight paths, deterministic random goals.
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
    log: Vec<(f64, Action)>,
}
impl Sim {
    fn new() -> Self {
        Sim {
            s: Sense { time: 0.0, dt: DT, pos: [0.0, 1.7, 0.0], yaw: 0.0, pitch: 0.0, hp: 100.0, foes: vec![], items: vec![], leader: None },
            moves: true,
            log: vec![],
        }
    }
    fn tick(&mut self, b: &mut Brain) -> Action {
        let a = b.think(&self.s, &Field);
        if self.moves {
            let f = forward(self.s.yaw, 0.0);
            let rt = se1_mod::bots::brain::right(self.s.yaw);
            let (fw, st) = (a.forward.clamp(-1.0, 1.0), a.strafe.clamp(-1.0, 1.0));
            self.s.pos[0] += (f[0] * fw + rt[0] * st) * SPEED * DT;
            self.s.pos[2] += (f[2] * fw + rt[2] * st) * SPEED * DT;
        }
        self.s.yaw = wrap(self.s.yaw + a.turn_yaw);
        self.s.pitch = (self.s.pitch + a.turn_pitch).clamp(-89.0, 89.0);
        self.log.push((self.s.time, a.clone()));
        self.s.time += DT as f64;
        a
    }
    fn run(&mut self, b: &mut Brain, secs: f32) {
        for _ in 0..(secs / DT) as usize {
            self.tick(b);
        }
    }
    fn err_to(&self, p: [f32; 3]) -> f32 {
        let (y, _) = look_at(self.s.pos, p);
        wrap(y - self.s.yaw).abs()
    }
}

fn foe(id: i32, x: f32, z: f32, visible: bool) -> Foe {
    Foe { id, pos: [x, 1.0, z], visible, ranged: true }
}

#[test]
fn conventions() {
    let f = forward(90.0, 0.0);
    assert!((f[0] + 1.0).abs() < 1e-4 && f[2].abs() < 1e-4, "yaw 90 looks along -X: {f:?}");
    let f0 = forward(0.0, 0.0);
    assert!((f0[2] + 1.0).abs() < 1e-4, "yaw 0 looks along -Z");
    let (y, p) = look_at([0.0, 0.0, 0.0], [-1.0, 0.0, 0.0]);
    assert!((y - 90.0).abs() < 0.1 && p.abs() < 0.1, "look_at -X = yaw 90, got {y}");
    let (_, p) = look_at([0.0, 0.0, 0.0], [0.0, 1.0, -1.0]);
    assert!((p - 45.0).abs() < 0.1, "pitch up positive, got {p}");
}

fn first_fire(skill: f32) -> (Option<f64>, f32, Sim) {
    let mut b = Brain::new(skill, 1);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.foes = vec![foe(1, 20.0, 0.0, true)];
    let mut worst = 0.0f32;
    let mut first = None;
    for _ in 0..(3.0 / DT) as usize {
        let a = sim.tick(&mut b);
        if a.fire {
            first.get_or_insert(sim.s.time);
            worst = worst.max(sim.err_to(sim.s.foes[0].pos));
        }
    }
    (first, worst, sim)
}

#[test]
fn reacts_then_aims_then_fires() {
    let mut b = Brain::new(0.5, 1);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.foes = vec![foe(1, 20.0, 0.0, true)];
    sim.run(&mut b, 0.25);
    assert!(sim.s.yaw.abs() < 1.0, "still reacting at 0.25 s (reaction 0.30 s), yaw {}", sim.s.yaw);
    assert_eq!(b.state(), BotState::Fight);
    let (first, worst, _) = first_fire(0.5);
    let t = first.expect("fires within 3 s");
    assert!(t >= 0.29 && t <= 2.0, "first shot at {t}");
    assert!(worst < 4.6, "fires only when on target (2 + 4·0.5 = 4°), worst {worst}");
}

#[test]
fn skill_matters() {
    let (t0, _, _) = first_fire(0.0);
    let (t1, _, _) = first_fire(1.0);
    assert!(t1.unwrap() < t0.unwrap(), "skill 1 shoots sooner: {t1:?} vs {t0:?}");
}

#[test]
fn never_fires_at_hidden_foes() {
    let mut b = Brain::new(1.0, 3);
    let mut sim = Sim::new();
    sim.s.foes = vec![foe(1, 0.0, -15.0, false)];
    sim.run(&mut b, 3.0);
    assert!(sim.log.iter().all(|(_, a)| !a.fire));
}

#[test]
fn turn_rate_is_capped() {
    for skill in [0.0f32, 1.0] {
        let mut b = Brain::new(skill, 5);
        assert!((b.max_turn_rate() - (180.0 + 540.0 * skill)).abs() < 0.01);
        let mut sim = Sim::new();
        sim.s.foes = vec![foe(1, 0.0, 20.0, true)]; // straight behind
        sim.run(&mut b, 2.0);
        for (_, a) in &sim.log {
            assert!(a.turn_yaw.abs() <= b.max_turn_rate() * DT + 0.01, "turn {} over cap at skill {skill}", a.turn_yaw);
        }
    }
}

#[test]
fn goes_for_health_when_hurt() {
    let mut b = Brain::new(0.5, 9);
    let mut sim = Sim::new();
    sim.s.hp = 20.0;
    let item = [6.0, 0.0, -14.0];
    sim.s.items = vec![Item { kind: ItemKind::Health, pos: item }];
    sim.tick(&mut b);
    assert_eq!(b.state(), BotState::Heal);
    let mut reached = false;
    for _ in 0..(6.0 / DT) as usize {
        sim.tick(&mut b);
        if hdist(sim.s.pos, item) < 1.5 { reached = true; break; }
    }
    assert!(reached, "reaches the health item, at {:?}", sim.s.pos);
    sim.s.items.clear();
    sim.tick(&mut b);
    assert_ne!(b.state(), BotState::Heal);
}

#[test]
fn follows_the_leader_and_stops_near() {
    let mut b = Brain::new(0.5, 11);
    let mut sim = Sim::new();
    let leader = [12.0, 1.7, -28.0];
    sim.s.leader = Some(leader);
    sim.run(&mut b, 10.0);
    assert_eq!(b.state(), BotState::Follow);
    let d = hdist(sim.s.pos, leader);
    assert!((3.5..=10.5).contains(&d), "ends 4-10 m from the leader, got {d}");
    let last: Vec<_> = sim.log.iter().rev().take(60).collect();
    let motion: f32 = last.iter().map(|(_, a)| a.forward.abs() + a.strafe.abs()).sum::<f32>() / last.len() as f32;
    assert!(motion < 0.15, "stands still near the leader, mean input {motion}");
}

#[test]
fn unsticks_by_jumping_and_repathing() {
    let mut b = Brain::new(0.5, 13);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.leader = Some([0.0, 1.7, -30.0]);
    sim.run(&mut b, 3.0);
    assert!(sim.log.iter().any(|(_, a)| a.jump), "jumps when stuck");
    assert!(b.repaths() >= 1, "asks for a fresh path when stuck");
}

#[test]
fn strafes_while_fighting() {
    let mut b = Brain::new(0.5, 17);
    let mut sim = Sim::new();
    sim.s.foes = vec![foe(1, 0.0, -15.0, true)];
    sim.run(&mut b, 6.0);
    let signs: Vec<f32> = sim.log.iter().map(|(_, a)| a.strafe).filter(|s| s.abs() > 0.2).map(|s| s.signum()).collect();
    let flips = signs.windows(2).filter(|w| w[0] != w[1]).count();
    assert!(flips >= 2, "strafe changes direction, {flips} flips");
    let d = hdist(sim.s.pos, sim.s.foes[0].pos);
    assert!((5.0..=26.0).contains(&d), "keeps 6-25 m, got {d}");
}

#[test]
fn roams_when_nothing_happens() {
    let mut b = Brain::new(0.5, 19);
    let mut sim = Sim::new();
    sim.run(&mut b, 10.0);
    assert_eq!(b.state(), BotState::Roam);
    assert!(hdist(sim.s.pos, [0.0, 0.0, 0.0]) > 3.0, "moved around: {:?}", sim.s.pos);
}

#[test]
fn picks_the_nearer_foe() {
    let mut b = Brain::new(1.0, 23);
    let mut sim = Sim::new();
    sim.moves = false;
    sim.s.foes = vec![foe(1, 30.0, 0.0, true), foe(2, -8.0, 0.0, true)];
    sim.run(&mut b, 2.0);
    assert!(sim.err_to(sim.s.foes[1].pos) < 10.0, "aims at the 8 m foe, error {}", sim.err_to(sim.s.foes[1].pos));
}

#[test]
fn deterministic() {
    let run = || {
        let mut b = Brain::new(0.4, 7);
        let mut sim = Sim::new();
        sim.s.foes = vec![foe(1, 10.0, -10.0, true)];
        sim.run(&mut b, 5.0);
        sim.log.into_iter().map(|(_, a)| a).collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}
