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
    released: RefCell<Vec<i32>>,
    teleports: RefCell<Vec<(i32, [f32; 3])>>,
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
        self.bots.borrow_mut().insert(id, BotState { eye: [0.0, 1.7, 0.0], heading: 0.0, pitch: 0.0, health: 100.0, armor: 0.0, weapon: 2, blocked: 0 });
        Some(id)
    }
    fn bot_remove(&self, id: i32) {
        self.removed.borrow_mut().push(id);
        self.bots.borrow_mut().remove(&id);
    }
    fn bot_state(&self, id: i32) -> Option<BotState> { self.bots.borrow().get(&id).copied() }
    fn bot_action(&self, id: i32, mv: [f32; 3], rot: [f32; 3], b: u32) { self.actions.borrow_mut().push((id, mv, rot, b)); }
    fn bot_release(&self, id: i32) { self.released.borrow_mut().push(id); }
    fn bot_teleport(&self, id: i32, pos: [f32; 3], _heading: f32) {
        self.teleports.borrow_mut().push((id, pos));
        if let Some(b) = self.bots.borrow_mut().get_mut(&id) { b.eye = [pos[0], pos[1] + 1.7, pos[2]]; }
    }
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
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 3); // joins and is put next to the human
    // the human walks off, straight ahead (heading 0 looks along -Z), 2 m a tick: walking, not a teleport
    for k in 1..=20 {
        h.humans.borrow_mut()[0] = [0.0, 0.0, -2.0 * k as f32];
        rt.tick(&h);
    }
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
    rt.level_started("");
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

#[test]
fn camera_sequences_are_skipped_with_use() {
    // a level's intro camera holds the player until a NEW fire/use press; turning is ignored meanwhile
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    h.enemies.borrow_mut().push((77, [20.0, 0.0, 0.0], 100.0));
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 3);
    h.bots.borrow_mut().get_mut(&1).unwrap().blocked = 1;
    let before = h.actions.borrow().len();
    ticks(&mut rt, &h, 30);
    let acts: Vec<_> = h.actions.borrow()[before..].iter().filter(|a| a.0 == 1).cloned().collect();
    assert!(acts.iter().any(|a| a.3 & buttons::USE != 0) && acts.iter().any(|a| a.3 & buttons::USE == 0), "taps USE (press and release)");
    assert!(acts.iter().all(|a| a.3 & buttons::FIRE == 0), "doesn't shoot to skip it");
    // auto-actions: the level drives; the bot sends nothing that moves it
    h.bots.borrow_mut().get_mut(&1).unwrap().blocked = 2;
    let before = h.actions.borrow().len();
    ticks(&mut rt, &h, 10);
    assert!(h.actions.borrow()[before..].iter().filter(|a| a.0 == 1).all(|a| a.1 == [0.0, 0.0, 0.0] && a.3 == 0), "stands still under auto-actions");
    ticks(&mut rt, &h, 20);
    assert!(h.released.borrow().contains(&1), "and asks the engine to release it");
}

#[test]
fn bots_are_put_next_to_the_human_each_on_its_own_spot() {
    let h = Fake::new();
    h.opt("se1Bots", 3.0);
    h.humans.borrow_mut().push([10.0, 0.0, 10.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 8);
    let t = h.teleports.borrow().clone();
    assert_eq!(t.len(), 3, "each bot placed once: {t:?}");
    for (_, p) in &t {
        let d = ((p[0] - 10.0).powi(2) + (p[2] - 10.0).powi(2)).sqrt();
        assert!((1.0..=4.0).contains(&d), "next to the human, not on top: {d} m");
        assert!(p[1].abs() < 0.05, "on the floor: y {}", p[1]);
    }
    for i in 0..3 {
        for j in i + 1..3 {
            let (a, b) = (t[i].1, t[j].1);
            assert!(((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)).sqrt() > 1.5, "own spots");
        }
    }
}

#[test]
fn a_bot_lost_far_away_is_brought_back() {
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 5);
    let n = h.teleports.borrow().len();
    h.bots.borrow_mut().get_mut(&1).unwrap().eye = [100.0, 1.7, 0.0]; // stuck behind a door, 100 m off
    ticks(&mut rt, &h, 150);
    assert_eq!(h.teleports.borrow().len(), n, "not at once: it may be on its way");
    ticks(&mut rt, &h, 80);
    let t = h.teleports.borrow();
    assert_eq!(t.len(), n + 1, "brought back after 10 s");
    let p = t.last().unwrap().1;
    assert!((p[0].powi(2) + p[2].powi(2)).sqrt() < 4.0, "next to the human: {p:?}");
}

#[test]
fn bots_follow_a_teleported_human_at_once() {
    let h = Fake::new();
    h.opt("se1Bots", 2.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 5);
    let n = h.teleports.borrow().len();
    h.humans.borrow_mut()[0] = [500.0, 0.0, 500.0]; // moved into an arena by the game
    ticks(&mut rt, &h, 2);
    let t = h.teleports.borrow();
    assert_eq!(t.len(), n + 2, "both bots follow within a tick or two");
    for (_, p) in &t[n..] {
        assert!(((p[0] - 500.0).powi(2) + (p[2] - 500.0).powi(2)).sqrt() < 4.0, "next to the human again: {p:?}");
    }
}

#[test]
fn time_runs_in_seconds_so_a_stuck_bot_jumps_rarely() {
    // the brain's timers are in seconds (a tick is 0.05 s): a bot that can't move gets one stuck
    // window per 1.5 s, so a jump at most that often, and a fresh path about once a second
    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    ticks(&mut rt, &h, 3);
    for k in 1..=20 {
        h.humans.borrow_mut()[0] = [0.0, 0.0, -2.0 * k as f32]; // walks off; the fake bot can't move
        rt.tick(&h);
    }
    let before = h.actions.borrow().len();
    ticks(&mut rt, &h, 100); // 5 s
    let jumps = h.actions.borrow()[before..].iter().filter(|a| a.0 == 1 && a.1[1] > 0.0).count();
    assert!((1..=4).contains(&jumps), "a stuck bot jumps about once per 1.5 s, got {jumps} in 5 s");
}

#[test]
fn nav_file_maps_levels() {
    use se1_mod::bots::runtime::nav_file;
    assert_eq!(nav_file("Levels/01_Hatshepsut.wld"), "Nav/Levels/01_Hatshepsut.nav");
    assert_eq!(nav_file("Levels\\KarnakDemo.wld"), "Nav/Levels/KarnakDemo.nav");
}

#[test]
fn baked_graph_is_used_at_once_and_never_rebuilt() {
    use se1_mod::bots::nav::{NavBuilder, NavParams, World};
    struct Plane;
    impl World for Plane {
        fn ray(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
            if a[1] <= 0.0 { return Some(0.0); }
            if b[1] >= 0.0 { return None; }
            let t = a[1] / (a[1] - b[1]);
            Some(t * ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt())
        }
    }
    let mut nb = NavBuilder::new([-20.0, -2.0, -20.0], [20.0, 5.0, 20.0], NavParams::default());
    while !nb.step(&Plane, usize::MAX) {}
    let g = nb.finish(&[]);
    let n = g.node_count();

    let h = Fake::new();
    h.opt("se1Bots", 1.0);
    h.humans.borrow_mut().push([0.0, 0.0, 0.0]);
    let mut rt = Runtime::new();
    rt.level_started("Levels/Test.wld");
    rt.use_baked(g, &h);
    assert!(rt.nav_ready());
    assert_eq!(rt.nav_nodes(), n);
    ticks(&mut rt, &h, 20);
    // the human walks far away: a live graph would be rebuilt around it, a baked one stays
    h.humans.borrow_mut()[0] = [500.0, 0.0, 500.0];
    ticks(&mut rt, &h, 20);
    assert!(rt.nav_ready());
    assert_eq!(rt.nav_nodes(), n);
    assert!(h.rays.get() < NAV_RAYS_PER_TICK, "no graph building: {} rays", h.rays.get());
}
