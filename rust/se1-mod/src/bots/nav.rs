//! Walkable-point navigation graph for AI bots.
//!
//! Serious Sam levels have no navigation mesh, so the builder casts rays into the level
//! (an abstract [`World`]) to find floor points on a regular X/Z grid, links neighbouring
//! columns into a directed graph (walk edges both ways, drop edges one way), and
//! [`NavGraph::path`] runs A* over it. The engine wiring lives elsewhere; this module is
//! pure Rust with no engine calls.
//!
//! Coordinates are metres, Y is up (Serious Engine convention).

/// Ray casts into the level. Returns the distance from `from` to the first solid hit along
/// the segment `from`→`to`, or None when the segment is clear.
pub trait World {
    fn ray(&self, from: [f32; 3], to: [f32; 3]) -> Option<f32>;
    /// `ray` that knows doors: solids that move (doors, lifts, bridges), so a closed one may open
    /// later. With `pass_doors` doors don't block and the id is the first door passed; without, the
    /// id is the door hit, if the hit is one. 0: no door. Worlds without doors keep the default.
    fn ray_door(&self, from: [f32; 3], to: [f32; 3], pass_doors: bool) -> (Option<f32>, u32) {
        let _ = pass_doors;
        (self.ray(from, to), 0)
    }
    /// The downward ray that finds floors: `ray_door` without passing doors, plus whether the
    /// surface hit is too steep to stand on (each surface type has its own climb slope; levels keep
    /// players in with slopes they slide down). Worlds without surfaces keep the default.
    fn ray_floor(&self, from: [f32; 3], to: [f32; 3]) -> (Option<f32>, u32, bool) {
        let (hit, door) = self.ray_door(from, to, false);
        (hit, door, false)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NavParams {
    pub cell: f32,       // grid spacing, default 2.0
    pub height: f32,     // clearance a player needs above the floor, default 1.8
    pub step: f32,       // max height difference walked up/down between neighbours, default 0.6
    pub max_drop: f32,   // max height a bot drops down (one-way edge), default 4.0
    pub max_layers: usize, // floors found per column, default 8
    /// steepest slope walked (rise over run), default 1.0 = 45°: stairs and ramps between columns
    /// that rise more than `step`; the clear-line test still stops walls
    pub max_slope: f32,
    /// Build through doors (`World::ray_door`): the graph covers rooms behind closed doors, and
    /// each edge through a door names it, for [`NavGraph::path_gated`]. Default false.
    pub doors: bool,
    /// Flood builds: nodes farther than this (metres walked, roughly) from every seed are kept but
    /// not spread from. Open terrain far from anything a player goes for (Hatshepsut's desert
    /// bowl is 3.7 km²) would otherwise be most of the graph. Default: no limit.
    pub max_reach: f32,
}

impl Default for NavParams {
    fn default() -> Self {
        Self { cell: 2.0, height: 1.8, step: 0.6, max_drop: 4.0, max_layers: 8, max_slope: 1.0, doors: false, max_reach: f32::INFINITY }
    }
}

/// Two ray heights above the floor for the clear-line test: knee and chest.
const RAY_HEIGHTS: [f32; 2] = [0.5, 1.4];

/// A ray starting inside solid hits within this much of the start point.
const INSIDE_EPS: f32 = 0.02;

const NEIGHBOURS: [(i32, i32); 8] = [
    (-1, -1), (0, -1), (1, -1),
    (-1, 0), (1, 0),
    (-1, 1), (0, 1), (1, 1),
];

fn dist3(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

/// An edge's A* cost: squared length, and 1 more for a drop (the one-way edges: a walk edge always
/// has its way back).
fn edge_cost(a: [f32; 3], b: [f32; 3], has_way_back: bool) -> f32 {
    dist3(a, b) + if has_way_back { 0.0 } else { 1.0 }
}

/// Deterministic per-call PRNG (SplitMix64): no per-ray allocation, same seed → same picks.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// Column not sampled yet (`NavBuilder::col_first`).
const UNSAMPLED: u32 = u32::MAX;

/// How the builder visits the level.
enum Mode {
    /// Every column in the bounds, then every column pair's edges; `finish` prunes by its seeds.
    Grid { cols_done: usize, edges_done: usize },
    /// Only what is reachable from the seeds: columns are sampled and nodes linked as the walk
    /// spreads from them (breadth first), so a big level's unreachable scenery costs nothing.
    Flood {
        seeds: Vec<[f32; 3]>,
        /// next seed to place, and the column of its 3×3 neighbourhood being sampled
        seed: usize,
        seed_k: usize,
        queue: std::collections::VecDeque<usize>,
        /// the node being expanded and the next of its 8 neighbour columns
        current: Option<(usize, usize)>,
    },
}

pub struct NavBuilder {
    min: [f32; 3],
    max: [f32; 3],
    p: NavParams,
    nx: usize,
    nz: usize,
    mode: Mode,
    // Per flat node (in creation order; a column's nodes are contiguous):
    pos: Vec<[f32; 3]>,
    node_col: Vec<u32>,
    /// the door it stands in or under (world door id, 0 none)
    node_door: Vec<u32>,
    /// directed neighbour flat indices and their doors (0 none), parallel; costs come in `finish`
    neigh: Vec<Vec<usize>>,
    edge_door: Vec<Vec<u32>>,
    /// flood: reachable from a seed (queued), linked to all its neighbours (expanded), and how far
    /// it is from its seed along the way it was reached
    queued: Vec<bool>,
    expanded: Vec<bool>,
    reach: Vec<f32>,
    /// Per column: its first flat node (UNSAMPLED until sampled) and node count.
    col_first: Vec<u32>,
    col_len: Vec<u8>,
    /// Each door seen: world id and a ray that a closed door blocks (`NavGraph::door_probe`).
    probes: Vec<(u32, [f32; 3], [f32; 3])>,
    rays: usize,
    /// The column being sampled, kept across `step` calls so a pause mid-column resumes exactly.
    col_c: usize,
    col: Vec<[f32; 3]>,
    col_door: Vec<u32>,
    col_y: f32,
    col_layers: usize,
    col_started: bool,
    /// Doubled move-down size while a column start is inside solid.
    move_d: f32,
}

impl NavBuilder {
    /// Every column of the level bounds (min, max corners); `finish` keeps what its seeds reach.
    pub fn new(min: [f32; 3], max: [f32; 3], p: NavParams) -> Self {
        Self::with_mode(min, max, p, Mode::Grid { cols_done: 0, edges_done: 0 })
    }

    /// Only the part of the bounds reachable from `seeds` (floor points: the player start, items):
    /// the same graph as `new` + `finish(seeds)` gives, for seeds near the floor, at a fraction of
    /// the rays on a level with much unreachable space. A seed counts if a floor node is in its
    /// own column or the 8 around it.
    pub fn flood(min: [f32; 3], max: [f32; 3], p: NavParams, seeds: &[[f32; 3]]) -> Self {
        let mode = Mode::Flood { seeds: seeds.to_vec(), seed: 0, seed_k: 0, queue: Default::default(), current: None };
        Self::with_mode(min, max, p, mode)
    }

    fn with_mode(min: [f32; 3], max: [f32; 3], p: NavParams, mode: Mode) -> Self {
        let nx = ((max[0] - min[0]) / p.cell).floor().max(0.0) as usize;
        let nz = ((max[2] - min[2]) / p.cell).floor().max(0.0) as usize;
        Self {
            min,
            max,
            p,
            nx,
            nz,
            mode,
            pos: Vec::new(),
            node_col: Vec::new(),
            node_door: Vec::new(),
            neigh: Vec::new(),
            edge_door: Vec::new(),
            queued: Vec::new(),
            expanded: Vec::new(),
            reach: Vec::new(),
            col_first: vec![UNSAMPLED; nx * nz],
            col_len: vec![0; nx * nz],
            probes: Vec::new(),
            rays: 0,
            col_c: 0,
            col: Vec::new(),
            col_door: Vec::new(),
            col_y: 0.0,
            col_layers: 0,
            col_started: false,
            move_d: 0.25,
        }
    }

    fn cast(&mut self, w: &dyn World, from: [f32; 3], to: [f32; 3]) -> Option<f32> {
        self.rays += 1;
        w.ray(from, to)
    }

    /// A ray that walking needs clear: in door mode it passes doors and returns the first one
    /// passed (remembering this ray as the door's probe); otherwise a plain `cast`.
    fn cast_walk(&mut self, w: &dyn World, from: [f32; 3], to: [f32; 3]) -> (Option<f32>, u32) {
        if !self.p.doors {
            return (self.cast(w, from, to), 0);
        }
        self.rays += 1;
        let (hit, door) = w.ray_door(from, to, true);
        if hit.is_none() && door != 0 {
            self.probe(door, from, to);
        }
        (hit, door)
    }

    fn probe(&mut self, door: u32, from: [f32; 3], to: [f32; 3]) {
        if !self.probes.iter().any(|p| p.0 == door) {
            self.probes.push((door, from, to));
        }
    }

    /// Do up to `max_rays` ray casts of work; returns true when everything is built. Lets the
    /// game spread the work over frames. Building in many small steps must give the SAME graph
    /// as one call with a huge budget.
    pub fn step(&mut self, w: &dyn World, max_rays: usize) -> bool {
        let budget_end = self.rays.saturating_add(max_rays.max(1));
        match self.mode {
            Mode::Grid { .. } => self.step_grid(w, budget_end),
            Mode::Flood { .. } => self.step_flood(w, budget_end),
        }
    }

    fn step_grid(&mut self, w: &dyn World, budget_end: usize) -> bool {
        let n = self.nx * self.nz;
        loop {
            let Mode::Grid { cols_done, edges_done } = self.mode else { unreachable!() };
            if cols_done < n {
                if !self.sample_column(w, cols_done, budget_end) {
                    return false;
                }
                self.mode = Mode::Grid { cols_done: cols_done + 1, edges_done };
            } else if edges_done < n {
                // one column's edges at a time: it may overrun the budget a little, never a phase
                if self.rays >= budget_end {
                    return false;
                }
                self.column_edges(w, edges_done);
                self.mode = Mode::Grid { cols_done, edges_done: edges_done + 1 };
            } else {
                return true;
            }
        }
    }

    /// Column index at (ix, iz) + offset, None outside the grid.
    fn col_at(&self, c: usize, dx: i32, dz: i32) -> Option<usize> {
        let (jx, jz) = ((c % self.nx) as i32 + dx, (c / self.nx) as i32 + dz);
        ((0..self.nx as i32).contains(&jx) && (0..self.nz as i32).contains(&jz)).then(|| jz as usize * self.nx + jx as usize)
    }

    fn col_nodes(&self, c: usize) -> std::ops::Range<usize> {
        let f = self.col_first[c] as usize;
        f..f + self.col_len[c] as usize
    }

    fn step_flood(&mut self, w: &dyn World, budget_end: usize) -> bool {
        // place the seeds: sample the 3×3 columns around each, queue the nearest node
        loop {
            let Mode::Flood { ref seeds, seed, seed_k, .. } = self.mode else { unreachable!() };
            let Some(&s) = seeds.get(seed) else { break };
            let cx = ((s[0] - self.min[0]) / self.p.cell).floor();
            let cz = ((s[2] - self.min[2]) / self.p.cell).floor();
            let inside = self.nx > 0 && cx >= 0.0 && cz >= 0.0 && (cx as usize) < self.nx && (cz as usize) < self.nz;
            let c = (cz as usize) * self.nx + cx as usize;
            if inside && seed_k < 9 {
                let (dx, dz) = (seed_k as i32 % 3 - 1, seed_k as i32 / 3 - 1);
                if let Some(j) = self.col_at(c, dx, dz) {
                    if self.col_first[j] == UNSAMPLED && !self.sample_column(w, j, budget_end) {
                        return false;
                    }
                }
                if let Mode::Flood { seed_k, .. } = &mut self.mode {
                    *seed_k += 1;
                }
                continue;
            }
            if inside {
                let mut best: Option<(f32, usize)> = None;
                for k in 0..9 {
                    let Some(j) = self.col_at(c, k % 3 - 1, k / 3 - 1) else { continue };
                    for i in self.col_nodes(j) {
                        let n = self.pos[i];
                        let d = (n[0] - s[0]).powi(2) + (n[2] - s[2]).powi(2) + 4.0 * (n[1] - s[1]).powi(2);
                        if best.map_or(true, |(bd, _)| d < bd) {
                            best = Some((d, i));
                        }
                    }
                }
                if let Some((_, i)) = best {
                    if !self.queued[i] {
                        self.queued[i] = true;
                        self.reach[i] = 0.0;
                        if let Mode::Flood { queue, .. } = &mut self.mode {
                            queue.push_back(i);
                        }
                    }
                }
            }
            if let Mode::Flood { seed, seed_k, .. } = &mut self.mode {
                *seed += 1;
                *seed_k = 0;
            }
        }
        // spread: link each reached node to the nodes of its 8 neighbour columns
        loop {
            let Mode::Flood { ref mut queue, ref mut current, .. } = self.mode else { unreachable!() };
            let (a, k0) = match current.take() {
                Some(x) => x,
                None => match queue.pop_front() {
                    Some(a) => (a, 0),
                    None => return true,
                },
            };
            if self.reach[a] > self.p.max_reach {
                continue; // the edge of the graph: kept, not spread from
            }
            let c = self.node_col[a] as usize;
            for k in k0..NEIGHBOURS.len() {
                let (dx, dz) = NEIGHBOURS[k];
                let Some(j) = self.col_at(c, dx, dz) else { continue };
                if self.col_first[j] == UNSAMPLED && !self.sample_column(w, j, budget_end) {
                    self.set_current(a, k);
                    return false;
                }
                for b in self.col_nodes(j) {
                    if self.expanded[b] {
                        continue; // b linked itself to a already
                    }
                    if self.link(w, a, b) && !self.queued[b] {
                        self.queued[b] = true;
                        let (pa, pb) = (self.pos[a], self.pos[b]);
                        self.reach[b] = self.reach[a] + ((pa[0] - pb[0]).powi(2) + (pa[2] - pb[2]).powi(2)).sqrt();
                        if let Mode::Flood { queue, .. } = &mut self.mode {
                            queue.push_back(b);
                        }
                    }
                }
                if self.rays >= budget_end && k + 1 < NEIGHBOURS.len() {
                    self.set_current(a, k + 1);
                    return false;
                }
            }
            self.expanded[a] = true;
            if self.rays >= budget_end {
                return false;
            }
        }
    }

    fn set_current(&mut self, a: usize, k: usize) {
        if let Mode::Flood { current, .. } = &mut self.mode {
            *current = Some((a, k));
        }
    }

    /// Floor candidates of column `c` from the top down. Returns false when the budget ran out;
    /// the column's progress is kept, so the next call (for the same column) resumes it exactly.
    fn sample_column(&mut self, w: &dyn World, c: usize, budget_end: usize) -> bool {
        let x = self.min[0] + self.p.cell * (0.5 + (c % self.nx) as f32);
        let z = self.min[2] + self.p.cell * (0.5 + (c / self.nx) as f32);
        if !self.col_started {
            self.col.clear();
            self.col_door.clear();
            self.col_c = c;
            self.col_y = self.max[1];
            self.col_layers = 0;
            self.move_d = 0.25;
            self.col_started = true;
        }
        debug_assert_eq!(self.col_c, c, "a column is resumed before another starts");
        loop {
            if self.rays >= budget_end {
                return false;
            }
            let y = self.col_y;
            let (from, to) = ([x, y, z], [x, self.min[1], z]);
            self.rays += 1;
            let (mut hit, door, steep) = w.ray_floor(from, to);
            let mut door = if self.p.doors { door } else { 0 };
            if door != 0 && matches!(hit, Some(d) if d < INSIDE_EPS) {
                // inside a door: the floor under it is a node in the door (closed now)
                hit = self.cast_walk(w, from, to).0;
            } else {
                door = 0; // a door's top hit from above is a floor to stand on (a lift)
            }
            match hit {
                Some(d) if d < INSIDE_EPS => {
                    // started inside solid: not a candidate, not a layer; move the start down,
                    // doubling the move, until it is in empty space
                    self.col_y -= self.move_d;
                    self.move_d *= 2.0;
                    if self.col_y <= self.min[1] {
                        break;
                    }
                }
                Some(d) if steep => {
                    // a layer, but no floor to stand on: carry on below it
                    self.move_d = 0.25;
                    self.col_layers += 1;
                    self.col_y = y - d - 0.05;
                    if self.col_layers >= self.p.max_layers || self.col_y <= self.min[1] {
                        break;
                    }
                }
                Some(d) => {
                    self.move_d = 0.25;
                    self.col_layers += 1;
                    let floor = y - d;
                    // clearance: the player needs `height` above the floor
                    let (a, b) = ([x, floor + 0.05, z], [x, floor + self.p.height, z]);
                    let (c, cdoor) = self.cast_walk(w, a, b);
                    if c.is_none() {
                        let door = if door != 0 { door } else { cdoor };
                        if door != 0 {
                            self.probe(door, a, b);
                        }
                        self.col.push([x, floor, z]);
                        self.col_door.push(door);
                    }
                    self.col_y = floor - 0.05;
                    if self.col_layers >= self.p.max_layers || self.col_y <= self.min[1] {
                        break;
                    }
                }
                None => break, // clear all the way to min.y
            }
        }
        self.col_first[c] = self.pos.len() as u32;
        self.col_len[c] = self.col.len() as u8;
        for (p, d) in self.col.drain(..).zip(self.col_door.drain(..)) {
            self.pos.push(p);
            self.node_col.push(c as u32);
            self.node_door.push(d);
            self.neigh.push(Vec::new());
            self.edge_door.push(Vec::new());
            self.queued.push(false);
            self.expanded.push(false);
            self.reach.push(f32::INFINITY);
        }
        self.col_started = false;
        true
    }

    /// Grid phase 2 for column `c`: edges to its neighbours. Each column pair is linked once, from
    /// the lower column index.
    fn column_edges(&mut self, w: &dyn World, c: usize) {
        for (dx, dz) in NEIGHBOURS {
            let Some(j) = self.col_at(c, dx, dz) else { continue };
            if j < c {
                continue;
            }
            for a in self.col_nodes(c) {
                for b in self.col_nodes(j) {
                    self.link(w, a, b);
                }
            }
        }
    }

    /// Test one node pair of neighbouring columns and add its edges, in both directions (walk
    /// both ways, or a drop from whichever is higher). Returns whether there is an edge a → b.
    fn link(&mut self, w: &dyn World, fa: usize, fb: usize) -> bool {
        let (a, b) = (self.pos[fa], self.pos[fb]);
        let dy = b[1] - a[1];
        let run = ((b[0] - a[0]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
        let nd = if self.node_door[fa] != 0 { self.node_door[fa] } else { self.node_door[fb] };
        if dy.abs() <= self.p.step.max(run * self.p.max_slope) {
            if let Some(d) = self.clear(w, a, b, false) {
                let door = if nd != 0 { nd } else { d };
                self.add_edge(fa, fb, door);
                self.add_edge(fb, fa, door);
                return true;
            }
        } else if dy.abs() <= self.p.max_drop {
            // one-way drop from the higher node to the lower one
            let (hi, lo, fhi, flo) = if dy < 0.0 { (a, b, fa, fb) } else { (b, a, fb, fa) };
            if let Some(d) = self.clear(w, hi, lo, true) {
                self.add_edge(fhi, flo, if nd != 0 { nd } else { d });
                return fhi == fa;
            }
        }
        false
    }

    /// Clear-line test: knee and chest rays above each end's own floor; for a drop, both ends use
    /// the upper node's height (the bot walks off the edge). Some(door passed, 0 none) when clear.
    fn clear(&mut self, w: &dyn World, a: [f32; 3], b: [f32; 3], drop: bool) -> Option<u32> {
        let mut door = 0;
        for h in RAY_HEIGHTS {
            let yb = if drop { a[1] + h } else { b[1] + h };
            let (hit, d) = self.cast_walk(w, [a[0], a[1] + h, a[2]], [b[0], yb, b[2]]);
            if hit.is_some() {
                return None;
            }
            if door == 0 {
                door = d;
            }
        }
        Some(door)
    }

    fn add_edge(&mut self, from: usize, to: usize, door: u32) {
        self.neigh[from].push(to);
        self.edge_door[from].push(door);
    }

    pub fn rays_cast(&self) -> usize {
        self.rays
    }

    /// Columns sampled so far (a flood samples only some of the grid).
    pub fn columns_sampled(&self) -> usize {
        self.col_first.iter().filter(|&&f| f != UNSAMPLED).count()
    }

    /// Finish. A grid build keeps the nodes reachable (following edge directions) from the nodes
    /// nearest to `seeds`, everything with no seeds; a flood keeps what its own seeds reached and
    /// ignores these. Panics if `step` isn't done.
    pub fn finish(self, seeds: &[[f32; 3]]) -> NavGraph {
        let n = self.pos.len();
        let keep: Vec<bool> = match &self.mode {
            Mode::Grid { cols_done, edges_done } => {
                assert!(*cols_done == self.nx * self.nz && *edges_done == self.nx * self.nz, "finish() before step() is done");
                if seeds.is_empty() {
                    vec![true; n]
                } else {
                    let mut keep = vec![false; n];
                    let mut stack: Vec<usize> = Vec::new();
                    for s in seeds {
                        // nearest node to the seed (full scan: finish runs once)
                        let best = (0..n).min_by(|&i, &j| {
                            let d = |k: usize| {
                                let p = self.pos[k];
                                (p[0] - s[0]).powi(2) + (p[2] - s[2]).powi(2) + 4.0 * (p[1] - s[1]).powi(2)
                            };
                            d(i).total_cmp(&d(j))
                        });
                        if let Some(b) = best {
                            if !keep[b] {
                                keep[b] = true;
                                stack.push(b);
                            }
                        }
                    }
                    while let Some(i) = stack.pop() {
                        for &j in &self.neigh[i] {
                            if !keep[j] {
                                keep[j] = true;
                                stack.push(j);
                            }
                        }
                    }
                    keep
                }
            }
            Mode::Flood { queue, current, .. } => {
                assert!(queue.is_empty() && current.is_none(), "finish() before step() is done");
                self.queued.clone()
            }
        };
        // Dense order: by column (the lookup grid needs each column's nodes contiguous), then
        // creation order, which within a column is top to bottom.
        let mut order: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
        order.sort_by_key(|&i| (self.node_col[i], i));
        let mut remap = vec![usize::MAX; n];
        for (k, &i) in order.iter().enumerate() {
            remap[i] = k;
        }
        // Dense-node range of each column (hash grid for `nearest`), over the kept columns'
        // bounding box only: a level's bounds are mostly sky. Columns outside the box keep no
        // nodes, and the box's columns in row order are still in dense order.
        let (mut x0, mut x1, mut z0, mut z1) = (usize::MAX, 0, usize::MAX, 0);
        for &i in &order {
            let c = self.node_col[i] as usize;
            let (ix, iz) = (c % self.nx, c / self.nx);
            (x0, x1, z0, z1) = (x0.min(ix), x1.max(ix), z0.min(iz), z1.max(iz));
        }
        let (gx, gz) = if order.is_empty() { (0, 0) } else { (x1 - x0 + 1, z1 - z0 + 1) };
        let mut counts = vec![0usize; gx * gz];
        for &i in &order {
            let c = self.node_col[i] as usize;
            counts[(c / self.nx - z0) * gx + (c % self.nx - x0)] += 1;
        }
        let mut col_start = Vec::with_capacity(gx * gz + 1);
        col_start.push(0usize);
        for k in counts {
            col_start.push(col_start.last().unwrap() + k);
        }
        let (cell, min_x, min_z) = (self.p.cell, self.min[0] + self.p.cell * x0.min(self.nx) as f32, self.min[2] + self.p.cell * z0.min(self.nz) as f32);
        let mut pos = Vec::with_capacity(order.len());
        let mut head = Vec::with_capacity(order.len() + 1);
        let mut dst = Vec::new();
        let mut wgt = Vec::new();
        // doors on kept edges, numbered from 1 in the order first met
        let mut door = Vec::new();
        let mut door_ids: Vec<u32> = Vec::new();
        head.push(0);
        for &i in &order {
            let (c, y) = (self.node_col[i] as usize, self.pos[i][1]);
            pos.push([min_x + cell * (0.5 + (c % self.nx - x0) as f32), y, min_z + cell * (0.5 + (c / self.nx - z0) as f32)]);
            for (m, &j) in self.neigh[i].iter().enumerate() {
                if remap[j] == usize::MAX {
                    continue;
                }
                dst.push(remap[j]);
                let id = self.edge_door[i][m];
                door.push(if id == 0 {
                    0
                } else if let Some(k) = door_ids.iter().position(|&d| d == id) {
                    k as u16 + 1
                } else {
                    door_ids.push(id);
                    door_ids.len() as u16
                });
            }
            head.push(dst.len());
        }
        // costs from the stored positions, the way `from_bytes` computes them
        for i in 0..pos.len() {
            for k in head[i]..head[i + 1] {
                let j = dst[k];
                let back = dst[head[j]..head[j + 1]].contains(&i);
                wgt.push(edge_cost(pos[i], pos[j], back));
            }
        }
        let probes = door_ids
            .iter()
            .map(|id| {
                let p = self.probes.iter().find(|p| p.0 == *id).expect("every door has a probe");
                (p.1, p.2)
            })
            .collect();
        NavGraph {
            pos,
            head,
            dst,
            wgt,
            door,
            probes,
            nx: gx,
            nz: gz,
            cell,
            min_x,
            min_z,
            col_start: if gx * gz > 0 { col_start } else { Vec::new() },
        }
    }
}

pub struct NavGraph {
    pos: Vec<[f32; 3]>,
    head: Vec<usize>, // CSR bounds: node i's edges are dst[head[i]..head[i+1]]
    dst: Vec<usize>,
    wgt: Vec<f32>,
    /// Per edge, parallel to `dst`: the door it goes through, 1-based index into `probes`; 0 none.
    door: Vec<u16>,
    /// Per door: a ray (from, to) that the door blocks while it's closed.
    probes: Vec<([f32; 3], [f32; 3])>,
    nx: usize,
    nz: usize,
    cell: f32,
    min_x: f32,
    min_z: f32,
    /// Dense-node range of each original grid column (hash grid for `nearest`).
    col_start: Vec<usize>,
}

impl NavGraph {
    pub fn node_count(&self) -> usize {
        self.pos.len()
    }

    pub fn edge_count(&self) -> usize {
        self.dst.len()
    }

    /// Doors the graph's edges go through (see `NavParams::doors`).
    pub fn door_count(&self) -> usize {
        self.probes.len()
    }

    /// A ray that door `i` (0-based) blocks while it's closed: cast it to see whether it's open.
    pub fn door_probe(&self, i: usize) -> ([f32; 3], [f32; 3]) {
        self.probes[i]
    }

    /// Edges that go through a door.
    pub fn door_edge_count(&self) -> usize {
        self.door.iter().filter(|&&d| d != 0).count()
    }

    /// The FLOOR point (y = floor height).
    pub fn node_pos(&self, i: usize) -> [f32; 3] {
        self.pos[i]
    }

    fn scan_cell(&self, cx: i32, cz: i32, p: [f32; 3], best: &mut Option<(f32, usize)>) {
        if cx < 0 || cx >= self.nx as i32 || cz < 0 || cz >= self.nz as i32 {
            return;
        }
        let col = (cz as usize) * self.nx + cx as usize;
        for i in self.col_start[col]..self.col_start[col + 1] {
            let n = self.pos[i];
            let d = (n[0] - p[0]).powi(2) + (n[2] - p[2]).powi(2) + 4.0 * (n[1] - p[1]).powi(2);
            if best.map_or(true, |(bd, _)| d < bd) {
                *best = Some((d, i));
            }
        }
    }

    /// Node nearest to p: horizontal distance plus 2 × vertical distance; None for an empty
    /// graph.
    pub fn nearest(&self, p: [f32; 3]) -> Option<usize> {
        if self.pos.is_empty() {
            return None;
        }
        // Hash grid: the cell of the query plus its 8 neighbours.
        let cx = ((p[0] - self.min_x) / self.cell).floor() as i32;
        let cz = ((p[2] - self.min_z) / self.cell).floor() as i32;
        let mut best: Option<(f32, usize)> = None;
        for dx in -1..=1 {
            for dz in -1..=1 {
                self.scan_cell(cx + dx, cz + dz, p, &mut best);
            }
        }
        if best.is_some() {
            return best.map(|(_, i)| i);
        }
        // Fallback: full scan (query lands outside the grid).
        for (i, &n) in self.pos.iter().enumerate() {
            let d = (n[0] - p[0]).powi(2) + (n[2] - p[2]).powi(2) + 4.0 * (n[1] - p[1]).powi(2);
            if best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, i));
            }
        }
        best.map(|(_, i)| i)
    }

    /// A* from the node nearest `from` to the node nearest `to`. Returns floor points from the
    /// start node to the goal node (inclusive), or None when unreachable.
    pub fn path(&self, from: [f32; 3], to: [f32; 3]) -> Option<Vec<[f32; 3]>> {
        self.path_gated(from, to, &[])
    }

    /// `path` that doesn't go through the doors marked closed (`doors_closed[i]` for door i,
    /// 0-based; doors past its end are open).
    pub fn path_gated(&self, from: [f32; 3], to: [f32; 3], doors_closed: &[bool]) -> Option<Vec<[f32; 3]>> {
        let s = self.nearest(from)?;
        let g = self.nearest(to)?;
        if s == g {
            return Some(vec![self.pos[s]]);
        }
        let n = self.pos.len();
        let mut gscore = vec![f32::INFINITY; n];
        let mut came = vec![0usize; n];
        let mut closed = vec![false; n];
        gscore[s] = 0.0;
        use std::cmp::Ordering;
        use std::collections::BinaryHeap;
        struct Item {
            f: f64,
            seq: u64,
            i: usize,
        }
        impl Ord for Item {
            fn cmp(&self, o: &Self) -> Ordering {
                // Min-heap over (f, seq): the sequence breaks f-ties deterministically.
                self.f.partial_cmp(&o.f).unwrap_or(Ordering::Equal)
                    .then(self.seq.cmp(&o.seq))
                    .reverse()
            }
        }
        impl PartialOrd for Item {
            fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Eq for Item {}
        impl PartialEq for Item {
            fn eq(&self, o: &Self) -> bool {
                self.cmp(o) == Ordering::Equal
            }
        }
        let goal = self.pos[g];
        let h = |i: usize| dist3(self.pos[i], goal).sqrt() as f64;
        let mut seq = 0u64;
        let mut heap = BinaryHeap::new();
        let push = |heap: &mut BinaryHeap<Item>, f: f64, i: usize, seq: &mut u64| {
            *seq += 1;
            heap.push(Item { f, seq: *seq, i });
        };
        push(&mut heap, h(s), s, &mut seq);
        while let Some(Item { i, .. }) = heap.pop() {
            if closed[i] {
                continue;
            }
            closed[i] = true;
            if i == g {
                let mut out = vec![self.pos[g]];
                let mut c = g;
                while c != s {
                    c = came[c];
                    out.push(self.pos[c]);
                }
                out.reverse();
                return Some(out);
            }
            for k in self.head[i]..self.head[i + 1] {
                let j = self.dst[k];
                if closed[j] {
                    continue;
                }
                let d = self.door[k] as usize;
                if d != 0 && doors_closed.get(d - 1).copied().unwrap_or(false) {
                    continue;
                }
                let nd = gscore[i] + self.wgt[k];
                if nd < gscore[j] {
                    gscore[j] = nd;
                    came[j] = i;
                    push(&mut heap, nd as f64 + h(j), j, &mut seq);
                }
            }
        }
        None
    }

    /// String pulling: drop waypoints that can be skipped because the straight walk between the
    /// remaining neighbours is clear (same clear-line test as edges). Keeps first and last.
    pub fn smooth(&self, path: &[[f32; 3]], w: &dyn World) -> Vec<[f32; 3]> {
        if path.len() <= 2 {
            return path.to_vec();
        }
        let mut out = vec![path[0]];
        for k in 1..path.len() - 1 {
            let a = *out.last().unwrap();
            let b = path[k + 1];
            if !Self::clear_line(w, a, b) {
                out.push(path[k]);
            }
        }
        out.push(*path.last().unwrap());
        out
    }

    /// Knee + chest rays between two floor points, raised by each end's own floor height.
    fn clear_line(w: &dyn World, a: [f32; 3], b: [f32; 3]) -> bool {
        for &h in &RAY_HEIGHTS {
            if w.ray([a[0], a[1] + h, a[2]], [b[0], b[1] + h, b[2]]).is_some() {
                return false;
            }
        }
        true
    }

    /// A random node within radius r (horizontal) of p, deterministic for a given seed.
    pub fn random_node_near(&self, p: [f32; 3], r: f32, seed: u64) -> Option<[f32; 3]> {
        if self.pos.is_empty() {
            return None;
        }
        let mut rng = Rng(seed);
        let r2 = r * r;
        // Bounded random probes; a deterministic sweep guarantees a hit when one exists.
        for _ in 0..(self.pos.len() * 2) {
            let i = rng.below(self.pos.len());
            let n = self.pos[i];
            let dx = n[0] - p[0];
            let dz = n[2] - p[2];
            if dx * dx + dz * dz <= r2 {
                return Some(n);
            }
        }
        let mut best: Option<(f32, [f32; 3])> = None;
        for &n in &self.pos {
            let dx = n[0] - p[0];
            let dz = n[2] - p[2];
            let d = dx * dx + dz * dz;
            if d <= r2 && best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, n));
            }
        }
        best.map(|(_, n)| n)
    }

    /// The graph as bytes (little-endian, compact: a level's graph has a million edges):
    /// "SE1NAV", version 3; counts and the lookup grid; nodes per grid column (u8 each, a run of empty columns as 0 + u32 length); per node
    /// its floor height (f32) and edge count (u8), then each edge as one byte, its target's
    /// neighbour column (`NEIGHBOURS` index, high 5 bits) and layer in it (low 3 bits); the door
    /// edges (u32 edge index, u16 door); the door probes. Node x/z come from their column, edge
    /// costs from `edge_cost`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        let u = |b: &mut Vec<u8>, v: usize| b.extend_from_slice(&(v as u32).to_le_bytes());
        let f = |b: &mut Vec<u8>, v: f32| b.extend_from_slice(&v.to_bits().to_le_bytes());
        let door_edges: Vec<(usize, u16)> = self.door.iter().enumerate().filter(|(_, &d)| d != 0).map(|(k, &d)| (k, d)).collect();
        b.extend_from_slice(b"SE1NAV");
        b.push(3); // version
        for v in [self.pos.len(), self.dst.len(), self.probes.len(), door_edges.len(), self.nx, self.nz] {
            u(&mut b, v);
        }
        for v in [self.cell, self.min_x, self.min_z] {
            f(&mut b, v);
        }
        // column counts, a run of empty columns as 0 and the run length (u32): most are empty
        let cols = self.nx * self.nz;
        let mut c = 0;
        while c < cols {
            let k = self.col_start[c + 1] - self.col_start[c];
            b.push(k as u8);
            if k == 0 {
                let run = (c..cols).take_while(|&j| self.col_start[j + 1] == self.col_start[j]).count();
                u(&mut b, run);
                c += run;
            } else {
                c += 1;
            }
        }
        let col_of = self.node_columns();
        for i in 0..self.pos.len() {
            f(&mut b, self.pos[i][1]);
            b.push((self.head[i + 1] - self.head[i]) as u8);
            let (ix, iz) = ((col_of[i] % self.nx) as i32, (col_of[i] / self.nx) as i32);
            for k in self.head[i]..self.head[i + 1] {
                let j = self.dst[k];
                let cj = col_of[j];
                let d = ((cj % self.nx) as i32 - ix, (cj / self.nx) as i32 - iz);
                let dir = NEIGHBOURS.iter().position(|&n| n == d).expect("edges link neighbour columns");
                b.push(((dir as u8) << 3) | (j - self.col_start[cj]) as u8);
            }
        }
        for (k, d) in door_edges {
            u(&mut b, k);
            b.extend_from_slice(&d.to_le_bytes());
        }
        for (from, to) in &self.probes {
            from.iter().chain(to).for_each(|&c| f(&mut b, c));
        }
        b
    }

    /// Each node's grid column.
    fn node_columns(&self) -> Vec<usize> {
        let mut col_of = vec![0usize; self.pos.len()];
        for c in 0..self.nx * self.nz {
            for i in self.col_start[c]..self.col_start[c + 1] {
                col_of[i] = c;
            }
        }
        col_of
    }

    /// Reads `to_bytes`; None for anything malformed (wrong magic or version, truncated,
    /// indices out of range).
    pub fn from_bytes(b: &[u8]) -> Option<NavGraph> {
        if b.len() < 7 || &b[0..6] != b"SE1NAV" || b[6] != 3 {
            return None;
        }
        let mut r = Reader { b, o: 7 };
        let c = r.u32s(6)?;
        let (n, e, doors, door_edges, nx, nz) = (c[0], c[1], c[2], c[3], c[4], c[5]);
        let g = r.f32s(3)?;
        let (cell, min_x, min_z) = (g[0], g[1], g[2]);
        let cols = nx.checked_mul(nz)?;
        let mut col_start = Vec::with_capacity(cols + 1);
        col_start.push(0usize);
        while col_start.len() <= cols {
            let k = r.bytes(1)?[0] as usize;
            let last = *col_start.last()?;
            if k > 0 {
                col_start.push(last + k);
                continue;
            }
            let run = r.u32s(1)?[0];
            if run == 0 || col_start.len() + run > cols + 1 {
                return None;
            }
            col_start.extend(std::iter::repeat(last).take(run));
        }
        if *col_start.last()? != n || (n > 0 && cols == 0) {
            return None;
        }
        let mut pos = Vec::with_capacity(n);
        let mut head = Vec::with_capacity(n + 1);
        let mut dst = Vec::with_capacity(e);
        head.push(0usize);
        let mut c = 0usize;
        for i in 0..n {
            while col_start[c + 1] <= i {
                c += 1;
            }
            let (ix, iz) = (c % nx, c / nx);
            let y = r.f32s(1)?[0];
            pos.push([min_x + cell * (0.5 + ix as f32), y, min_z + cell * (0.5 + iz as f32)]);
            let ne = r.bytes(1)?[0] as usize;
            for &code in r.bytes(ne)? {
                let (dx, dz) = *NEIGHBOURS.get((code >> 3) as usize)?;
                let (jx, jz) = (ix as i64 + dx as i64, iz as i64 + dz as i64);
                if jx < 0 || jz < 0 || jx >= nx as i64 || jz >= nz as i64 {
                    return None;
                }
                let cj = jz as usize * nx + jx as usize;
                let j = col_start[cj] + (code & 7) as usize;
                if j >= col_start[cj + 1] {
                    return None;
                }
                dst.push(j);
            }
            head.push(dst.len());
        }
        if dst.len() != e {
            return None;
        }
        let mut wgt = Vec::with_capacity(e);
        for i in 0..n {
            for k in head[i]..head[i + 1] {
                let j = dst[k];
                wgt.push(edge_cost(pos[i], pos[j], dst[head[j]..head[j + 1]].contains(&i)));
            }
        }
        let mut door = vec![0u16; e];
        for _ in 0..door_edges {
            let k = r.u32s(1)?[0];
            let d = u16::from_le_bytes(r.bytes(2)?.try_into().ok()?);
            if k >= e || d == 0 || d as usize > doors {
                return None;
            }
            door[k] = d;
        }
        let probes: Vec<([f32; 3], [f32; 3])> =
            r.f32s(doors.checked_mul(6)?)?.chunks_exact(6).map(|c| ([c[0], c[1], c[2]], [c[3], c[4], c[5]])).collect();
        if r.o != b.len() {
            return None;
        }
        Some(NavGraph { pos, head, dst, wgt, door, probes, nx, nz, cell, min_x, min_z, col_start: if cols > 0 { col_start } else { Vec::new() } })
    }
}

/// Little-endian reads over a byte slice for `NavGraph::from_bytes`; None past the end.
struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.o..self.o.checked_add(n)?)?;
        self.o += n;
        Some(s)
    }
    fn u32s(&mut self, n: usize) -> Option<Vec<usize>> {
        Some(self.bytes(n.checked_mul(4)?)?.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]) as usize).collect())
    }
    fn f32s(&mut self, n: usize) -> Option<Vec<f32>> {
        Some(self.u32s(n)?.into_iter().map(|x| f32::from_bits(x as u32)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Axis-aligned solid boxes (slab intersection), same idea as the acceptance test.
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
        while !b.step(w, budget) {}
        b.finish(seeds)
    }

    fn len(p: &[[f32; 3]]) -> f32 {
        p.windows(2)
            .map(|w| dist3(w[0], w[1]).sqrt())
            .sum()
    }

    #[test]
    fn flat_floor_connects() {
        let w = Boxes(vec![floor()]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        assert_eq!(g.node_count(), 100);
        let p = g.path([1.0, 0.0, 1.0], [19.0, 0.0, 19.0]).unwrap();
        assert!(p.len() >= 2);
        assert!((len(&p) - 25.46).abs() < 5.0, "path ~ diagonal, got {}", len(&p));
        // Neighbours are linked: the graph has edges.
        assert!(g.edge_count() > 0);
    }

    #[test]
    fn wall_doorway_detour() {
        let w = Boxes(vec![
            floor(),
            ([9.5, 0.0, -1.0], [10.5, 3.0, 14.0]),
            ([9.5, 0.0, 18.0], [10.5, 3.0, 21.0]),
        ]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        let p = g.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]).expect("through the door");
        assert!(len(&p) > 20.0, "detour length {}", len(&p));
        // Any segment crossing x=10 must cross inside the doorway (z in 14..=18).
        for s in p.windows(2) {
            let (a, b) = (s[0], s[1]);
            if (a[0] - 10.0) * (b[0] - 10.0) < 0.0 {
                let t = (10.0 - a[0]) / (b[0] - a[0]);
                let z = a[2] + t * (b[2] - a[2]);
                assert!((14.0..=18.0).contains(&z), "crosses wall at z={z}");
            }
        }
    }

    #[test]
    fn stairs_connect_floors() {
        let mut boxes = vec![floor(), ([-1.0, 2.0, 12.0], [21.0, 2.4, 21.0])];
        for k in 0..8 {
            let z = 4.0 + k as f32;
            boxes.push(([8.0, 0.0, z], [12.0, 0.3 * (k + 1) as f32, z + 1.0]));
        }
        let w = Boxes(boxes);
        let p = NavParams { cell: 1.0, ..NavParams::default() };
        let g = build(&w, 6.0, p, usize::MAX, &[]);
        let path = g.path([10.0, 0.0, 1.0], [10.0, 2.4, 18.0]).expect("up the stairs");
        let end = *path.last().unwrap();
        assert!((end[1] - 2.4).abs() < 0.1, "ends on upper floor y={}", end[1]);
        assert!(
            path.iter().any(|n| n[1] > 0.5 && n[1] < 2.0 && n[2] > 4.0 && n[2] < 12.0),
            "path uses the stairs"
        );
    }

    #[test]
    fn low_ceiling_no_nodes() {
        // 1.2 m of clearance (slab 1.2–1.6): no node under the slab with the default 1.8 m
        // player height, but the slab top is a floor.
        let w = Boxes(vec![floor(), ([-1.0, 1.2, -1.0], [10.0, 1.6, 21.0])]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        for i in 0..g.node_count() {
            let n = g.node_pos(i);
            assert!(
                !(n[0] < 10.0 && n[1] < 0.5),
                "node under the 1.2 m ceiling: {n:?}"
            );
        }
        // The slab top is a floor before pruning.
        assert!(
            (0..g.node_count()).any(|i| g.node_pos(i)[1] > 1.5),
            "slab top is a floor"
        );
    }

    #[test]
    fn drop_is_one_way() {
        let w = Boxes(vec![floor(), ([-1.0, 0.0, -1.0], [21.0, 3.0, 10.0])]);
        let g = build(&w, 6.0, NavParams::default(), usize::MAX, &[]);
        assert!(g.path([10.0, 3.0, 5.0], [10.0, 0.0, 15.0]).is_some(), "drop 3 m");
        assert!(g.path([10.0, 0.0, 15.0], [10.0, 3.0, 5.0]).is_none(), "climb 3 m");
    }

    #[test]
    fn seed_pruning() {
        let w = Boxes(vec![floor(), ([-1.0, 0.0, -1.0], [21.0, 3.0, 10.0])]);
        let all = build(&w, 6.0, NavParams::default(), usize::MAX, &[]);
        let pruned = build(&w, 6.0, NavParams::default(), usize::MAX, &[[10.0, 0.0, 15.0]]);
        assert!(
            pruned.node_count() < all.node_count(),
            "pruned {} < {}",
            pruned.node_count(),
            all.node_count()
        );
        // The slab top is unreachable from the ground seed (no climb edge).
        for i in 0..pruned.node_count() {
            assert!(
                pruned.node_pos(i)[1] < 1.0,
                "unreachable slab node kept: {:?}",
                pruned.node_pos(i)
            );
        }
        // No seeds keeps everything.
        assert_eq!(
            all.node_count(),
            build(&w, 6.0, NavParams::default(), usize::MAX, &[]).node_count()
        );
    }

    #[test]
    fn stepped_build_equals_one_shot() {
        let w = Boxes(vec![
            floor(),
            ([9.5, 0.0, -1.0], [10.5, 3.0, 14.0]),
            ([9.5, 0.0, 18.0], [10.5, 3.0, 21.0]),
        ]);
        let a = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        let mut b = NavBuilder::new([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default());
        while !b.step(&w, 3) {}
        let b = b.finish(&[]);
        assert_eq!(a.node_count(), b.node_count());
        assert_eq!(a.edge_count(), b.edge_count());
        for i in 0..a.node_count() {
            assert_eq!(a.node_pos(i), b.node_pos(i));
        }
        assert_eq!(
            a.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]),
            b.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0])
        );
    }

    #[test]
    fn flood_stops_spreading_past_max_reach() {
        let w = Boxes(vec![floor()]);
        let p = NavParams { max_reach: 5.0, ..NavParams::default() };
        let mut b = NavBuilder::flood([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], p, &[[1.0, 0.0, 1.0]]);
        while !b.step(&w, usize::MAX) {}
        let g = b.finish(&[]);
        let far = (0..g.node_count()).map(|i| g.node_pos(i)).map(|q| ((q[0] - 1.0).powi(2) + (q[2] - 1.0).powi(2)).sqrt()).fold(0.0, f32::max);
        assert!(g.node_count() > 4 && g.node_count() < 100, "{} nodes", g.node_count());
        assert!(far <= 5.0 + 2.0 * 2.0f32.sqrt() + 1e-3, "spread to {far} m");
    }

    /// A flat floor whose part x > 10 is a surface too steep to stand on.
    struct Slide(Boxes);
    impl World for Slide {
        fn ray(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
            self.0.ray(a, b)
        }
        fn ray_floor(&self, a: [f32; 3], b: [f32; 3]) -> (Option<f32>, u32, bool) {
            (self.0.ray(a, b), 0, a[0] > 10.0)
        }
    }

    #[test]
    fn steep_surfaces_have_no_nodes() {
        let w = Slide(Boxes(vec![floor()]));
        let g = build(&Boxes(vec![floor()]), 5.0, NavParams::default(), usize::MAX, &[]);
        let mut b = NavBuilder::new([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default());
        while !b.step(&w, usize::MAX) {}
        let s = b.finish(&[]);
        assert_eq!(s.node_count(), g.node_count() / 2);
        assert!((0..s.node_count()).all(|i| s.node_pos(i)[0] < 10.0));
    }

    /// Node positions and edge count, comparable across builds.
    fn shape(g: &NavGraph) -> (Vec<[i32; 3]>, usize) {
        let mut v: Vec<[i32; 3]> = (0..g.node_count()).map(|i| g.node_pos(i).map(|c| (c * 100.0).round() as i32)).collect();
        v.sort();
        (v, g.edge_count())
    }

    #[test]
    fn flood_matches_grid_with_seeds() {
        let worlds = [
            Boxes(vec![floor(), ([9.5, 0.0, -1.0], [10.5, 3.0, 14.0]), ([9.5, 0.0, 18.0], [10.5, 3.0, 21.0])]),
            Boxes(vec![floor(), ([-1.0, 0.0, -1.0], [21.0, 3.0, 10.0])]),
            // a closed room: nothing outside it is reachable from inside
            Boxes(vec![floor(), ([4.0, 0.0, 4.0], [12.0, 3.0, 4.5]), ([4.0, 0.0, 11.5], [12.0, 3.0, 12.0]), ([4.0, 0.0, 4.0], [4.5, 3.0, 12.0]), ([11.5, 0.0, 4.0], [12.0, 3.0, 12.0])]),
        ];
        // seeds stand on a floor (a flood looks for the seed's node in its 3×3 columns only)
        let seeds: [&[[f32; 3]]; 3] = [
            &[[1.0, 0.0, 1.0], [15.0, 0.0, 15.0], [7.0, 0.0, 7.0]],
            &[[15.0, 0.0, 15.0], [7.0, 3.0, 5.0]],
            &[[1.0, 0.0, 1.0], [7.0, 0.0, 7.0]],
        ];
        for (k, w) in worlds.iter().enumerate() {
            for &seed in seeds[k] {
                let grid = build(w, 5.0, NavParams::default(), usize::MAX, &[seed]);
                let mut f = NavBuilder::flood([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default(), &[seed]);
                while !f.step(w, usize::MAX) {}
                let flood = f.finish(&[]);
                assert_eq!(shape(&grid), shape(&flood), "world {k} seed {seed:?}");
                assert_eq!(grid.path(seed, [19.0, 0.0, 19.0]), flood.path(seed, [19.0, 0.0, 19.0]));
            }
        }
    }

    #[test]
    fn flood_stepped_equals_one_shot_and_skips_the_unreachable() {
        let w = Boxes(vec![floor(), ([4.0, 0.0, 4.0], [12.0, 3.0, 4.5]), ([4.0, 0.0, 11.5], [12.0, 3.0, 12.0]), ([4.0, 0.0, 4.0], [4.5, 3.0, 12.0]), ([11.5, 0.0, 4.0], [12.0, 3.0, 12.0])]);
        let seeds = [[7.0, 0.0, 7.0], [30.0, 0.0, 30.0]]; // the second is outside the bounds
        let mut a = NavBuilder::flood([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default(), &seeds);
        while !a.step(&w, usize::MAX) {}
        let (rays, cols) = (a.rays_cast(), a.columns_sampled());
        let a = a.finish(&[]);
        let mut b = NavBuilder::flood([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default(), &seeds);
        while !b.step(&w, 3) {}
        assert_eq!(b.rays_cast(), rays);
        let b = b.finish(&[]);
        assert_eq!(shape(&a), shape(&b));
        assert_eq!(a.node_count(), 16, "only the room's 4×4 cells");
        assert!(cols < 40, "sampled {cols} of 100 columns");
        let mut g = NavBuilder::new([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default());
        while !g.step(&w, usize::MAX) {}
        assert!(rays * 3 < g.rays_cast(), "flood {rays} rays, grid {}", g.rays_cast());
    }

    /// Solid boxes plus doors: boxes that `ray_door` can pass, with ids 1, 2, ...
    struct Doors {
        walls: Boxes,
        doors: Vec<([f32; 3], [f32; 3])>,
    }

    impl World for Doors {
        fn ray(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
            self.ray_door(a, b, false).0
        }
        fn ray_door(&self, a: [f32; 3], b: [f32; 3], pass: bool) -> (Option<f32>, u32) {
            let wall = self.walls.ray(a, b);
            let door = self
                .doors
                .iter()
                .enumerate()
                .filter_map(|(i, d)| Boxes(vec![*d]).ray(a, b).map(|t| (t, i as u32 + 1)))
                .min_by(|x, y| x.0.total_cmp(&y.0));
            match door {
                Some((t, id)) if wall.map_or(true, |w| t <= w) => {
                    if pass { (wall, id) } else { (Some(t), id) }
                }
                _ => (wall, 0),
            }
        }
    }

    /// A wall across x = 10 whose only doorway (z 8..12) holds a closed door.
    fn door_world() -> Doors {
        Doors {
            walls: Boxes(vec![
                floor(),
                ([9.5, 0.0, -1.0], [10.5, 3.0, 8.0]),
                ([9.5, 0.0, 12.0], [10.5, 3.0, 21.0]),
                ([9.5, 2.5, 8.0], [10.5, 3.0, 12.0]), // lintel
            ]),
            doors: vec![([9.8, 0.0, 8.0], [10.2, 2.5, 12.0])],
        }
    }

    #[test]
    fn doors_closed_at_build_still_connect() {
        let w = door_world();
        let (a, b) = ([3.0, 0.0, 10.0], [17.0, 0.0, 10.0]);
        let mut nb = NavBuilder::new([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], NavParams::default());
        while !nb.step(&w, usize::MAX) {}
        let plain = nb.finish(&[a]);
        assert!(plain.path(a, b).map_or(true, |p| p.last().unwrap()[0] < 10.0), "without doors the far side isn't reached");
        assert_eq!(plain.door_count(), 0);

        let p = NavParams { doors: true, ..NavParams::default() };
        let mut nb = NavBuilder::new([0.0, -2.0, 0.0], [20.0, 5.0, 20.0], p);
        while !nb.step(&w, usize::MAX) {}
        let g = nb.finish(&[a]);
        assert_eq!(g.door_count(), 1);
        assert!(g.door_edge_count() > 0);
        let path = g.path(a, b).expect("through the door");
        assert!(path.iter().all(|q| !(9.5..10.5).contains(&q[0]) || (8.0..12.0).contains(&q[2])), "goes through the doorway");
        assert!(g.path_gated(a, b, &[true]).map_or(true, |p| p.last().unwrap()[0] < 10.0), "a closed door blocks");
        assert_eq!(g.path_gated(a, b, &[false]), Some(path));
        // the probe is blocked while the door is there, clear once it's gone
        let (pa, pb) = g.door_probe(0);
        assert!(w.ray(pa, pb).is_some());
        assert!(w.walls.ray(pa, pb).is_none());
        let h = NavGraph::from_bytes(&g.to_bytes()).unwrap();
        assert_eq!((h.door_count(), h.door_edge_count()), (1, g.door_edge_count()));
        assert_eq!(h.path_gated(a, b, &[true]), g.path_gated(a, b, &[true]));
        assert_eq!(h.nearest([17.0, 0.0, 10.0]), g.nearest([17.0, 0.0, 10.0]));
        // every node, edge and cost comes back exactly
        assert_eq!((h.pos.clone(), h.head.clone(), h.dst.clone(), h.door.clone()), (g.pos.clone(), g.head.clone(), g.dst.clone(), g.door.clone()));
        assert!(h.wgt.iter().zip(&g.wgt).all(|(a, b)| a.to_bits() == b.to_bits()));
        assert_eq!(h.col_start, g.col_start);
    }

    #[test]
    fn serialisation_round_trip() {
        let w = Boxes(vec![floor(), ([9.5, 0.0, -1.0], [10.5, 3.0, 14.0])]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        let bytes = g.to_bytes();
        assert!(bytes.starts_with(b"SE1NAV"));
        let h = NavGraph::from_bytes(&bytes).unwrap();
        assert_eq!(g.node_count(), h.node_count());
        assert_eq!(g.edge_count(), h.edge_count());
        assert_eq!(
            g.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0]),
            h.path([3.0, 0.0, 3.0], [17.0, 0.0, 3.0])
        );
        assert!(NavGraph::from_bytes(&bytes[..bytes.len() / 2]).is_none());
        let mut bad = bytes;
        bad[0] = b'X';
        assert!(NavGraph::from_bytes(&bad).is_none());
        assert!(NavGraph::from_bytes(b"SE1NAV\x02").is_none(), "bad version");
    }

    #[test]
    fn smooth_collapses_flat_path() {
        let w = Boxes(vec![floor()]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        let p = g.path([1.0, 0.0, 1.0], [19.0, 0.0, 19.0]).unwrap();
        assert!(p.len() > 2);
        let s = g.smooth(&p, &w);
        assert_eq!(s.len(), 2, "flat floor: nothing in the way");
    }

    #[test]
    fn random_node_near_deterministic_and_inside() {
        let w = Boxes(vec![floor()]);
        let g = build(&w, 5.0, NavParams::default(), usize::MAX, &[]);
        let a = g.random_node_near([10.0, 0.0, 10.0], 5.0, 42).unwrap();
        assert_eq!(Some(a), g.random_node_near([10.0, 0.0, 10.0], 5.0, 42));
        let d = ((a[0] - 10.0).powi(2) + (a[2] - 10.0).powi(2)).sqrt();
        assert!(d <= 5.0 + 1e-3, "outside radius: {d}");
        let picks: std::collections::HashSet<(i32, i32)> = (0..20u64)
            .map(|s| {
                let p = g.random_node_near([10.0, 0.0, 10.0], 5.0, s).unwrap();
                (p[0] as i32, p[2] as i32)
            })
            .collect();
        assert!(picks.len() > 3, "seeds should vary the pick");
    }
}
