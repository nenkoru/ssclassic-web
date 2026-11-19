//! Co-op bots (notes/bots.md): pure logic, no engine calls. The engine wiring comes later.
//! - `nav`: walkable graph from ray casts, A*, smoothing.
//! - `brain`: per-tick decisions, aim and steering behind the `Paths` trait.

pub mod brain;
pub mod nav;

/// The brain finds its way on the nav graph.
impl brain::Paths for nav::NavGraph {
    fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
        nav::NavGraph::path(self, from, to)
    }
    fn random_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
        self.random_node_near(p, r, seed)
    }
}

#[cfg(test)]
mod tests {
    use super::brain::{forward, right, Brain, BotState, Sense};
    use super::nav::{NavBuilder, NavParams, World};

    struct Floor;
    impl World for Floor {
        fn ray(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
            // the plane y = 0, solid below
            if a[1] <= 0.0 { return Some(0.0); }
            if b[1] >= 0.0 { return None; }
            let t = a[1] / (a[1] - b[1]);
            let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            Some(t * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt())
        }
    }

    #[test]
    fn brain_roams_on_a_real_graph() {
        let mut b = NavBuilder::new([0.0, -2.0, 0.0], [60.0, 5.0, 60.0], NavParams::default());
        while !b.step(&Floor, 10_000) {}
        let g = b.finish(&[[30.0, 0.0, 30.0]]);
        let mut brain = Brain::new(0.5, 3);
        let mut s = Sense { time: 0.0, dt: 1.0 / 60.0, pos: [30.0, 1.7, 30.0], yaw: 0.0, pitch: 0.0, hp: 100.0, foes: vec![], items: vec![], leader: None };
        for _ in 0..600 {
            let a = brain.think(&s, &g);
            let (f, r) = (forward(s.yaw, 0.0), right(s.yaw));
            s.pos[0] = (s.pos[0] + (f[0] * a.forward + r[0] * a.strafe) * 8.0 * s.dt).clamp(0.0, 60.0);
            s.pos[2] = (s.pos[2] + (f[2] * a.forward + r[2] * a.strafe) * 8.0 * s.dt).clamp(0.0, 60.0);
            s.yaw += a.turn_yaw;
            s.time += s.dt as f64;
        }
        assert_eq!(brain.state(), BotState::Roam);
        let moved = ((s.pos[0] - 30.0).powi(2) + (s.pos[2] - 30.0).powi(2)).sqrt();
        assert!(moved > 3.0, "walks around on the graph, moved {moved}");
    }
}
