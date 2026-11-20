//! Acceptance tests for the bot runtime (bots::runtime) against a fake engine.
use se1_mod::bots::runtime::{BotHost, Runtime, NAV_RAYS_PER_TICK};
use se1_mod::host::{buttons, BotState};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

#[derive(Default)]
struct Fake {
    server: Cell<bool>,
    options: RefCell<HashMap<String, f64>>,
    humans: RefCell<Vec<[f32; 3]>>,
    enemies: RefCell<Vec<(i32, [f32; 3], f32)>>,
    bots: RefCell<HashMap<i32, BotState>>,
    names: RefCell<Vec<String>>,
    removed: RefCell<Vec<i32>>,
    next: Cell<i32>,
    actions: RefCell<Vec<(i32, [f32; 3], [f32; 3], u32)>>,
    rays: Cell<usize>,
    vis_rays: Cell<usize>,
}
impl Fake {
    fn new() -> Self {
        let f = Fake::default();
        f.server.set(true);
        f.next.set(1);
        f
    }
    fn opt(&self, k: &str, v: f64) {
        self.options.borrow_mut().insert(k.into(), v);
    }
    fn last_action(&self, id: i32) -> Option<([f32; 3], [f32; 3], u32)> {
        self.actions.borrow().iter().rev().find(|a| a.0 == id).map(|a| (a.1, a.2, a.3))
    }
}
impl BotHost for Fake {
    fn is_server(&self) -> bool { self.server.get() }
    fn page_option(&self, name: &str) -> f64 { *self.options.borrow().get(name).unwrap_or(&0.0) }
    fn bot_add(&self, name: &str) -> Option<i32> {
        let id = self.next.get();
        self.next.set(id + 1);
        self.names.borrow_mut().push(name.into());
        self.bots.borrow_mut().insert(id, BotState { eye: [0.0, 1.7, 0.0], heading: 0.0, pitch: 0.0, health: 100.0, armor: 0.0, weapon: 2 });
        Some(id)
    }
    fn bot_remove(&self, id: i32) {
        self.removed.borrow_mut().push(id);
        self.bots.borrow_mut().remove(&id);
    }
    fn bot_state(&self, id: i32) -> Option<BotState> { self.bots.borrow().get(&id).copied() }
    fn bot_action(&self, id: i32, mv: [f32; 3], rot: [f32; 3], b: u32) { self.actions.borrow_mut().push((id, mv, rot, b)); }
    fn ray(&self, a: [f32; 3], b: [f32; 3], _m: bool) -> Option<f32> {
        self.rays.set(self.rays.get() + 1);
        if self.enemies.borrow().iter().any(|e| (e.1[0] - b[0]).abs() < 1e-3 && (e.1[1] + 1.0 - b[1]).abs() < 1e-3 && (e.1[2] - b[2]).abs() < 1e-3) {
            self.vis_rays.set(self.vis_rays.get() + 1);
        }
        // the plane y = 0, solid below
        if a[1] <= 0.0 { return Some(0.0); }
        if b[1] >= 0.0 { return None; }
        let t = a[1] / (a[1] - b[1]);
        let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        Some(t * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt())
    }
    fn enemies(&self, max: usize) -> Vec<(i32, [f32; 3], f32)> { self.enemies.borrow().iter().take(max).cloned().collect() }
    fn items(&self, _max: usize) -> Vec<(i32, [f32; 3])> { vec![] }
    fn humans(&self, max: usize) -> Vec<[f32; 3]> { self.humans.borrow().iter().take(max).cloned().collect() }
    fn world_bounds(&self) -> Option<([f32; 3], [f32; 3])> { Some(([-1000.0, -50.0, -1000.0], [1000.0, 100.0, 1000.0])) }
    fn log(&self, _msg: &str) {}
}

fn ticks(rt: &mut Runtime, h: &Fake, n: usize) {
    for _ in 0..n {
        rt.tick(h);
    }
}

#[test]
fn nothing_unless_server() {
    let h = Fake::new();
    h.server.set(false);
    h.opt("se1Bots", 2.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 20);
    assert!(h.names.borrow().is_empty());
    assert!(h.actions.borrow().is_empty());
}

#[test]
fn bots_join_one_per_tick_once_a_human_is_there() {
    let h = Fake::new();
    h.opt("se1Bots", 2.0);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 5);
    assert!(h.names.borrow().is_empty(), "waits for a human");
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    rt.tick(&h);
    assert_eq!(h.names.borrow().len(), 1, "one per tick");
    rt.tick(&h);
    assert_eq!(*h.names.borrow(), vec!["Bot 1".to_string(), "Bot 2".to_string()]);
    ticks(&mut rt, &h, 5);
    assert_eq!(rt.bot_ids().len(), 2);
    assert_eq!(h.names.borrow().len(), 2, "no more than asked");
}

#[test]
fn removes_the_newest_and_forgets_gone_bots() {
    let h = Fake::new();
    h.opt("se1Bots", 3.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 5);
    assert_eq!(rt.bot_ids(), vec![1, 2, 3]);
    h.opt("se1Bots", 2.0);
    ticks(&mut rt, &h, 2);
    assert_eq!(*h.removed.borrow(), vec![3], "the newest goes");
    h.bots.borrow_mut().remove(&1); // gone from the game (kicked, level change)
    ticks(&mut rt, &h, 3);
    let ids = rt.bot_ids();
    assert!(!ids.contains(&1), "forgets a bot that is gone");
    assert_eq!(ids.len(), 2, "and fills the slot again: {ids:?}");
    assert!(h.names.borrow().last().unwrap() == "Bot 1", "reuses the first free name: {:?}", h.names.borrow());
}

#[test]
fn walks_forward_with_negative_z_toward_a_far_leader() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, -40.0]); // straight ahead (heading 0 looks along -Z)
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 10);
    let (mv, _, _) = h.last_action(1).expect("acts");
    assert!(mv[2] < -5.0, "forward is negative in the engine: {mv:?}");
    assert!(mv[0].abs() < 3.0, "no big strafe: {mv:?}");
}

#[test]
fn rotation_is_absolute_and_accumulates_within_the_turn_cap() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.opt("se1BotSkill", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    h.enemies.borrow_mut().push((77, [20.0, 0.0, 0.0], 100.0)); // to the right: heading -90
    let mut rt = Runtime::new();
    // the fake doesn't move or turn the bot, so the brain keeps turning: the accumulated heading must grow
    ticks(&mut rt, &h, 40);
    let rots: Vec<f32> = h.actions.borrow().iter().filter(|a| a.0 == 1).map(|a| a.2[0]).collect();
    assert!(rots[0].abs() < 1.0, "starts from 0");
    for w in rots.windows(2) {
        assert!((w[1] - w[0]).abs() <= 720.0 * 0.05 + 0.01, "per-tick change within the cap: {} -> {}", w[0], w[1]);
    }
    assert!(rots.last().unwrap() < &-60.0, "turned right (negative heading) a long way: {:?}", rots.last());
}

#[test]
fn dead_bots_press_fire_to_respawn() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 3);
    h.bots.borrow_mut().get_mut(&1).unwrap().health = 0.0;
    let before = h.actions.borrow().len();
    ticks(&mut rt, &h, 40);
    let acts: Vec<_> = h.actions.borrow()[before..].iter().filter(|a| a.0 == 1).cloned().collect();
    assert!(acts.iter().any(|a| a.3 & buttons::FIRE != 0) && acts.iter().any(|a| a.3 & buttons::FIRE == 0), "presses and releases fire");
    assert!(acts.iter().all(|a| a.1 == [0.0, 0.0, 0.0]), "doesn't move while dead");
}

#[test]
fn visibility_rays_are_capped() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    for i in 0..10 {
        h.enemies.borrow_mut().push((i, [5.0 + i as f32 * 3.0, 0.0, 10.0], 100.0));
    }
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 2);
    h.vis_rays.set(0);
    ticks(&mut rt, &h, 10);
    assert!(h.vis_rays.get() <= 6 * 10, "at most 6 sight checks per bot per tick, got {}", h.vis_rays.get());
    assert!(h.vis_rays.get() >= 10, "but it does check");
}

#[test]
fn builds_the_graph_within_the_ray_budget() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    let mut worst = 0;
    for t in 0..20_000 {
        let before = h.rays.get();
        rt.tick(&h);
        worst = worst.max(h.rays.get() - before);
        if rt.nav_ready() {
            assert!(t > 50, "a 300 m square takes a while at {} rays a tick", NAV_RAYS_PER_TICK);
            break;
        }
    }
    assert!(rt.nav_ready(), "the graph finishes");
    assert!(rt.nav_nodes() > 10_000, "150 m around the human on a 2 m grid: {} nodes", rt.nav_nodes());
    assert!(worst <= NAV_RAYS_PER_TICK + 300, "rays in one tick: {worst}");
    rt.level_started();
    assert!(!rt.nav_ready(), "a new level forgets the graph");
}

#[test]
fn off_by_default() {
    let h = Fake::new();
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 20);
    assert!(h.names.borrow().is_empty());
}
