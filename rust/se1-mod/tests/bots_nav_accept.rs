//! Acceptance tests for the bot navigation graph (bots::nav), against synthetic box worlds.
use se1_mod::bots::nav::{NavBuilder, NavGraph, NavParams, World};

/// Axis-aligned solid boxes.
struct Boxes(Vec<([f32; 3], [f32; 3])>);

impl World for Boxes {
    fn ray(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
        let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        let mut best: Option<f32> = None;
        'boxes: for (lo, hi) in &self.0 {
            let (mut t0, mut t1) = (0.0f32, 1.0f32);
            for i in 0..3 {
                if d[i].abs() < 1e-9 {
                    if a[i] < lo[i] || a[i] > hi[i] {
                        continue 'boxes;
                    }
                } else {
                    let (mut u, mut v) = ((lo[i] - a[i]) / d[i], (hi[i] - a[i]) / d[i]);
                    if u > v {
                        std::mem::swap(&mut u, &mut v);
                    }
                    t0 = t0.max(u);
                    t1 = t1.min(v);
                    if t0 > t1 {
                        continue 'boxes;
                    }
                }
            }
            let dist = t0 * len;
            if best.map_or(true, |x| dist < x) {
                best = Some(dist);
            }
        }
        best
    }
}

fn floor() -> ([f32; 3], [f32; 3]) {
    ([-1.0, -1.0, -1.0], [21.0, 0.0, 21.0])
}

fn build(w: &Boxes, max_y: f32, p: NavParams, budget: usize, seeds: &[[f32; 3]]) -> NavGraph {
    let mut b = NavBuilder::new([0.0, -2.0, 0.0], [20.0, max_y, 20.0], p);
    let mut guard = 0;
    while !b.step(w, budget) {
        guard += 1;
        assert!(guard < 10_000_000, "builder never finishes");
    }
    assert!(b.rays_cast() > 0);
    b.finish(seeds)
}

fn length(p: &[[f32; 3]]) -> f32 {
    p.windows(2)
        .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2) + (w[1][2] - w[0][2]).powi(2)).sqrt())
        .sum()
}

#[test]
fn flat_floor() {
    let w = Boxes(vec![floor()]);
    let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    assert_eq!(g.node_count(), 100, "10x10 columns of 2 m");
    for i in 0..g.node_count() {
        assert!(g.node_pos(i)[1].abs() < 0.05, "node on the floor");
    }
    let p = g.path([1.0, 0.0, 1.0], [19.0, 0.0, 19.0]).expect("path across a flat floor");
    let l = length(&p);
    assert!((l - 25.46).abs() < 2.5, "about the diagonal, got {l}");
    let s = g.smooth(&p, &w);
    assert_eq!(s.len(), 2, "nothing in the way: straight line");
}

fn wall_with_door() -> Boxes {
    Boxes(vec![
        floor(),
        ([9.5, 0.0, -1.0], [10.5, 3.0, 14.0]),
        ([9.5, 0.0, 18.0], [10.5, 3.0, 21.0]),
    ])
}

#[test]
fn doorway() {
    let w = wall_with_door();
    let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    let p = g.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]).expect("path through the door");
    assert!(length(&p) > 20.0, "must detour through the door, got {}", length(&p));
    for s in p.windows(2) {
        let (a, b) = (s[0], s[1]);
        if (a[0] - 10.0) * (b[0] - 10.0) < 0.0 {
            let t = (10.0 - a[0]) / (b[0] - a[0]);
            let z = a[2] + t * (b[2] - a[2]);
            assert!((14.0..=18.0).contains(&z), "crosses the wall outside the door at z={z}");
        }
    }
    let s = g.smooth(&p, &w);
    assert!(s.len() >= 3 && s.len() < p.len(), "smoothing keeps the door corner ({} of {})", s.len(), p.len());
}

#[test]
fn stairs_to_upper_floor() {
    let mut boxes = vec![floor(), ([-1.0, 2.0, 12.0], [21.0, 2.4, 21.0])];
    for k in 0..8 {
        let z = 4.0 + k as f32;
        boxes.push(([8.0, 0.0, z], [12.0, 0.3 * (k + 1) as f32, z + 1.0]));
    }
    let w = Boxes(boxes);
    let p = NavParams { cell: 1.0, ..NavParams::default() };
    let g = build(&w, 6.0, p, usize::MAX, &[]);
    assert!((0..g.node_count()).any(|i| { let n = g.node_pos(i); n[2] > 12.0 && n[1] < 0.1 }), "ground under the platform is walkable");
    let path = g.path([10.0, 0.0, 1.0], [10.0, 2.4, 18.0]).expect("up the stairs");
    let end = path.last().unwrap();
    assert!((end[1] - 2.4).abs() < 0.1, "ends on the upper floor, y={}", end[1]);
    assert!(path.iter().any(|n| n[1] > 0.5 && n[1] < 2.0 && n[2] > 4.0 && n[2] < 12.0), "uses the stairs");
}

#[test]
fn low_ceiling_and_pruning() {
    let w = Boxes(vec![floor(), ([-1.0, 1.2, -1.0], [10.0, 1.6, 21.0])]);
    let all = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    for i in 0..all.node_count() {
        let n = all.node_pos(i);
        assert!(!(n[0] < 10.0 && n[1] < 0.5), "no node under a 1.2 m ceiling: {n:?}");
    }
    assert!((0..all.node_count()).any(|i| all.node_pos(i)[1] > 1.5), "the slab top is a floor before pruning");
    let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[[15.0, 0.0, 10.0]]);
    assert!(g.node_count() > 0);
    for i in 0..g.node_count() {
        assert!(g.node_pos(i)[1] < 1.0, "slab top can't be reached from the ground (only dropped from)");
    }
}

#[test]
fn drops_are_one_way() {
    let w = Boxes(vec![floor(), ([-1.0, 0.0, -1.0], [21.0, 3.0, 10.0])]);
    let g = build(&w, 6.0, NavParams::default(), usize::MAX, &[]);
    assert!(g.path([10.0, 3.0, 5.0], [10.0, 0.0, 15.0]).is_some(), "can drop 3 m");
    assert!(g.path([10.0, 0.0, 15.0], [10.0, 3.0, 5.0]).is_none(), "can't climb 3 m");
    let high = Boxes(vec![floor(), ([-1.0, 0.0, -1.0], [21.0, 6.0, 10.0])]);
    let g = build(&high, 9.0, NavParams::default(), usize::MAX, &[]);
    assert!(g.path([10.0, 6.0, 5.0], [10.0, 0.0, 15.0]).is_none(), "6 m is more than max_drop");
}

#[test]
fn enclosed_room_roof_is_pruned() {
    let w = Boxes(vec![
        floor(),
        ([-1.0, 0.0, -1.0], [0.5, 4.0, 21.0]),
        ([19.5, 0.0, -1.0], [21.0, 4.0, 21.0]),
        ([-1.0, 0.0, -1.0], [21.0, 4.0, 0.5]),
        ([-1.0, 0.0, 19.5], [21.0, 4.0, 21.0]),
        ([-1.0, 4.0, -1.0], [21.0, 4.5, 21.0]),
    ]);
    let g = build(&w, 10.0, NavParams::default(), usize::MAX, &[[10.0, 0.0, 10.0]]);
    assert!(g.node_count() >= 64, "the room floor stays, got {}", g.node_count());
    for i in 0..g.node_count() {
        assert!(g.node_pos(i)[1] < 1.0, "roof nodes pruned");
    }
}

#[test]
fn small_budget_same_graph() {
    let w = wall_with_door();
    let a = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    let b = build(&w, 5.0, NavParams::default(), 7, &[]);
    assert_eq!(a.node_count(), b.node_count());
    assert_eq!(a.edge_count(), b.edge_count());
    for i in 0..a.node_count() {
        assert_eq!(a.node_pos(i), b.node_pos(i));
    }
}

#[test]
fn bytes_round_trip() {
    let w = wall_with_door();
    let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    let bytes = g.to_bytes();
    assert!(bytes.starts_with(b"SE1NAV"));
    let h = NavGraph::from_bytes(&bytes).expect("decodes");
    assert_eq!(g.node_count(), h.node_count());
    assert_eq!(g.edge_count(), h.edge_count());
    assert_eq!(g.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]), h.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]));
    assert!(NavGraph::from_bytes(&bytes[..bytes.len() / 2]).is_none(), "truncated");
    let mut bad = bytes.clone();
    bad[0] = b'X';
    assert!(NavGraph::from_bytes(&bad).is_none(), "bad magic");
}

#[test]
fn random_node_near_is_deterministic() {
    let w = Boxes(vec![floor()]);
    let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
    let a = g.random_node_near([10.0, 0.0, 10.0], 5.0, 42).unwrap();
    assert_eq!(Some(a), g.random_node_near([10.0, 0.0, 10.0], 5.0, 42));
    assert!(((a[0] - 10.0).powi(2) + (a[2] - 10.0).powi(2)).sqrt() <= 5.0 + 1e-3);
    let picks: std::collections::HashSet<_> = (0..20u64).map(|s| { let p = g.random_node_near([10.0, 0.0, 10.0], 5.0, s).unwrap(); (p[0] as i32, p[2] as i32) }).collect();
    assert!(picks.len() > 3, "different seeds give different nodes");
}

#[test]
fn big_level_builds_in_reasonable_rays() {
    // 200 x 200 m flat: 10 000 columns; the ray count stays linear in the columns
    let w = Boxes(vec![([-1.0, -1.0, -1.0], [201.0, 0.0, 201.0])]);
    let mut b = NavBuilder::new([0.0, -2.0, 0.0], [200.0, 5.0, 200.0], NavParams::default());
    while !b.step(&w, 50_000) {}
    let rays = b.rays_cast();
    assert!(rays < 10_000 * 30, "too many rays: {rays}");
    let g = b.finish(&[]);
    assert_eq!(g.node_count(), 10_000);
    assert!(g.path([1.0, 0.0, 1.0], [199.0, 0.0, 199.0]).is_some());
}

#[test]
fn drops_work_in_every_direction() {
    // the platform on the high-Z side this time (columns are numbered along +X then +Z)
    let w = Boxes(vec![floor(), ([-1.0, 0.0, 10.0], [21.0, 3.0, 21.0])]);
    let g = build(&w, 6.0, NavParams::default(), usize::MAX, &[]);
    assert!(g.path([10.0, 3.0, 15.0], [10.0, 0.0, 5.0]).is_some(), "can drop 3 m toward -Z");
    assert!(g.path([10.0, 0.0, 5.0], [10.0, 3.0, 15.0]).is_none(), "can't climb 3 m");
    let w = Boxes(vec![floor(), ([10.0, 0.0, -1.0], [21.0, 3.0, 21.0])]);
    let g = build(&w, 6.0, NavParams::default(), usize::MAX, &[]);
    assert!(g.path([15.0, 3.0, 10.0], [5.0, 0.0, 10.0]).is_some(), "can drop 3 m toward -X");
}

#[test]
fn budget_holds_in_every_phase_and_any_budget_finishes() {
    let mut boxes = vec![([-1.0, -6.0, -1.0], [41.0, 0.0, 41.0]), ([-1.0, 2.0, 20.0], [41.0, 2.4, 41.0])];
    for k in 0..8 {
        let z = 4.0 + k as f32;
        boxes.push(([8.0, 0.0, z], [12.0, 0.3 * (k + 1) as f32, z + 1.0]));
    }
    let w = Boxes(boxes);
    let mk = || NavBuilder::new([0.0, -8.0, 0.0], [40.0, 6.0, 40.0], NavParams::default());
    let mut big = mk();
    while !big.step(&w, usize::MAX) {}
    let reference = big.finish(&[]);
    for budget in [1usize, 3, 50] {
        let mut b = mk();
        let (mut calls, mut worst) = (0usize, 0usize);
        loop {
            let before = b.rays_cast();
            let done = b.step(&w, budget);
            worst = worst.max(b.rays_cast() - before);
            calls += 1;
            assert!(calls < 5_000_000, "budget {budget}: never finishes");
            if done { break; }
        }
        // a column's edge work may overrun a little, never a whole phase
        assert!(worst <= budget + 200, "budget {budget}: one step cast {worst} rays");
        let g = b.finish(&[]);
        assert_eq!(g.node_count(), reference.node_count(), "budget {budget}: same nodes");
        assert_eq!(g.edge_count(), reference.edge_count(), "budget {budget}: same edges");
    }
}
