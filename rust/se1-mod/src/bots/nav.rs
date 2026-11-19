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
}

#[derive(Clone, Copy, Debug)]
pub struct NavParams {
    pub cell: f32,       // grid spacing, default 2.0
    pub height: f32,     // clearance a player needs above the floor, default 1.8
    pub step: f32,       // max height difference walked up/down between neighbours, default 0.6
    pub max_drop: f32,   // max height a bot drops down (one-way edge), default 4.0
    pub max_layers: usize, // floors found per column, default 8
}

impl Default for NavParams {
    fn default() -> Self {
        Self { cell: 2.0, height: 1.8, step: 0.6, max_drop: 4.0, max_layers: 8 }
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

pub struct NavBuilder {
    min: [f32; 3],
    max: [f32; 3],
    p: NavParams,
    nx: usize,
    nz: usize,
    /// Floor nodes per column (grid order), found by the column phase.
    nodes: Vec<Vec<[f32; 3]>>,
    /// Per flat node: directed neighbour flat indices (filled by the edge phase).
    neigh: Vec<Vec<usize>>,
    /// Per flat node: costs of the edges above, parallel to `neigh`.
    costs: Vec<Vec<f32>>,
    /// Flat index of the first node in each column (columns are contiguous in the flat list).
    col_start: Vec<usize>,
    /// Columns whose floor nodes are found.
    cols_done: usize,
    /// Columns whose edges are computed.
    edges_done: usize,
    rays: usize,
    /// The column being sampled, kept across `step` calls so a pause mid-column resumes exactly.
    col: Vec<[f32; 3]>,
    col_y: f32,
    col_layers: usize,
    col_started: bool,
    /// Doubled move-down size while a column start is inside solid.
    move_d: f32,
}

impl NavBuilder {
    /// Level bounds (min, max corners).
    pub fn new(min: [f32; 3], max: [f32; 3], p: NavParams) -> Self {
        let nx = ((max[0] - min[0]) / p.cell).floor() as usize;
        let nz = ((max[2] - min[2]) / p.cell).floor() as usize;
        Self {
            min,
            max,
            p,
            nx,
            nz,
            nodes: Vec::with_capacity(nx * nz),
            neigh: Vec::new(),
            costs: Vec::new(),
            col_start: Vec::new(),
            cols_done: 0,
            edges_done: 0,
            rays: 0,
            col: Vec::new(),
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

    /// Do up to `max_rays` ray casts of work; returns true when everything is built. Lets the
    /// game spread the work over frames. Building in many small steps must give the SAME graph
    /// as one call with a huge budget.
    pub fn step(&mut self, w: &dyn World, max_rays: usize) -> bool {
        let budget_end = self.rays + max_rays.max(1);
        while self.cols_done < self.nx * self.nz {
            if !self.sample_column(w, budget_end) {
                return false;
            }
        }
        while self.edges_done < self.nx * self.nz {
            // one column's edges at a time: it may overrun the budget a little, never a phase
            if self.rays >= budget_end {
                return false;
            }
            self.column_edges(w, self.edges_done);
            self.edges_done += 1;
        }
        true
    }

    /// Phase 1 for the current column: floor candidates from the top down. Returns false when
    /// the budget ran out; the column's progress is kept, so the next call resumes it exactly.
    fn sample_column(&mut self, w: &dyn World, budget_end: usize) -> bool {
        let c = self.cols_done;
        let x = self.min[0] + self.p.cell * (0.5 + (c % self.nx) as f32);
        let z = self.min[2] + self.p.cell * (0.5 + (c / self.nx) as f32);
        if !self.col_started {
            self.col.clear();
            self.col_y = self.max[1];
            self.col_layers = 0;
            self.move_d = 0.25;
            self.col_started = true;
        }
        loop {
            if self.rays >= budget_end {
                return false;
            }
            let y = self.col_y;
            match self.cast(w, [x, y, z], [x, self.min[1], z]) {
                Some(d) if d < INSIDE_EPS => {
                    // started inside solid: not a candidate, not a layer; move the start down,
                    // doubling the move, until it is in empty space
                    self.col_y -= self.move_d;
                    self.move_d *= 2.0;
                    if self.col_y <= self.min[1] {
                        break;
                    }
                }
                Some(d) => {
                    self.move_d = 0.25;
                    self.col_layers += 1;
                    let floor = y - d;
                    // clearance: the player needs `height` above the floor
                    if self.cast(w, [x, floor + 0.05, z], [x, floor + self.p.height, z]).is_none() {
                        self.col.push([x, floor, z]);
                    }
                    self.col_y = floor - 0.05;
                    if self.col_layers >= self.p.max_layers || self.col_y <= self.min[1] {
                        break;
                    }
                }
                None => break, // clear all the way to min.y
            }
        }
        self.col_start.push(self.neigh.len());
        for _ in 0..self.col.len() {
            self.neigh.push(Vec::new());
            self.costs.push(Vec::new());
        }
        self.nodes.push(std::mem::take(&mut self.col));
        self.col_started = false;
        self.cols_done += 1;
        true
    }

    /// Phase 2 for column `c`: edges to its neighbours. Each column pair is tested once, from the
    /// lower column index, in both directions (walk both ways, or a drop from whichever is higher).
    fn column_edges(&mut self, w: &dyn World, c: usize) {
        let (ix, iz) = (c % self.nx, c / self.nx);
        for (dx, dz) in NEIGHBOURS {
            let (jx, jz) = (ix as i32 + dx, iz as i32 + dz);
            if !(0..self.nx as i32).contains(&jx) || !(0..self.nz as i32).contains(&jz) {
                continue;
            }
            let j = (jz as usize) * self.nx + jx as usize;
            if j < c {
                continue;
            }
            for ka in 0..self.nodes[c].len() {
                for kb in 0..self.nodes[j].len() {
                    let (a, b) = (self.nodes[c][ka], self.nodes[j][kb]);
                    let (fa, fb) = (self.col_start[c] + ka, self.col_start[j] + kb);
                    let dy = b[1] - a[1];
                    if dy.abs() <= self.p.step {
                        if self.clear(w, a, b, false) {
                            let cost = dist3(a, b);
                            self.add_edge(fa, fb, cost);
                            self.add_edge(fb, fa, cost);
                        }
                    } else if dy.abs() <= self.p.max_drop {
                        // one-way drop from the higher node to the lower one
                        let (hi, lo, fhi, flo) = if dy < 0.0 { (a, b, fa, fb) } else { (b, a, fb, fa) };
                        if self.clear(w, hi, lo, true) {
                            self.add_edge(fhi, flo, dist3(hi, lo) + 1.0);
                        }
                    }
                }
            }
        }
    }

    /// Clear-line test: knee and chest rays above each end's own floor; for a drop, both ends use
    /// the upper node's height (the bot walks off the edge).
    fn clear(&mut self, w: &dyn World, a: [f32; 3], b: [f32; 3], drop: bool) -> bool {
        RAY_HEIGHTS.iter().all(|&h| {
            let yb = if drop { a[1] + h } else { b[1] + h };
            self.cast(w, [a[0], a[1] + h, a[2]], [b[0], yb, b[2]]).is_none()
        })
    }

    fn add_edge(&mut self, from: usize, to: usize, cost: f32) {
        self.neigh[from].push(to);
        self.costs[from].push(cost);
    }

    pub fn rays_cast(&self) -> usize {
        self.rays
    }

    /// Finish: keep only the nodes reachable (following edge directions) from the nodes nearest
    /// to `seeds` (e.g. player starts). With no seeds, keep everything. Panics if `step` isn't
    /// done.
    pub fn finish(self, seeds: &[[f32; 3]]) -> NavGraph {
        assert!(
            self.cols_done == self.nx * self.nz && self.edges_done == self.nx * self.nz,
            "finish() before step() is done"
        );
        let n = self.neigh.len();
        let mut keep = vec![true; n];
        if !seeds.is_empty() {
            keep.fill(false);
            let mut stack: Vec<usize> = Vec::new();
            for s in seeds {
                // Nearest node to the seed (full scan: finish runs once).
                let mut best = 0usize;
                let mut best_d = f32::INFINITY;
                for (c, list) in self.nodes.iter().enumerate() {
                    for (k, &nd) in list.iter().enumerate() {
                        let d = (nd[0] - s[0]).powi(2) + (nd[2] - s[2]).powi(2) + 4.0 * (nd[1] - s[1]).powi(2);
                        if d < best_d {
                            best_d = d;
                            best = self.col_start[c] + k;
                        }
                    }
                }
                if !keep[best] {
                    keep[best] = true;
                    stack.push(best);
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
        }
        // Compact to a dense node list; CSR adjacency.
        let mut remap = vec![0usize; n];
        let mut next = 0usize;
        for i in 0..n {
            if keep[i] {
                remap[i] = next;
                next += 1;
            }
        }
        let mut pos = Vec::with_capacity(next);
        let mut head = Vec::with_capacity(next + 1);
        let mut dst = Vec::new();
        let mut wgt = Vec::new();
        head.push(0);
        for i in 0..n {
            if !keep[i] {
                continue;
            }
            let (c, k) = self.flat_col_layer(i);
            pos.push(self.nodes[c][k]);
            for (m, &j) in self.neigh[i].iter().enumerate() {
                if keep[j] {
                    dst.push(remap[j]);
                    wgt.push(self.costs[i][m]);
                }
            }
            head.push(dst.len());
        }
        // Dense-node range of each original column (hash grid for `nearest`).
        let cols = self.nx * self.nz;
        let mut col_start = vec![0usize; cols + 1];
        let mut next = 0usize;
        for c in 0..cols {
            for k in 0..self.nodes[c].len() {
                if keep[self.col_start[c] + k] {
                    next += 1;
                }
            }
            col_start[c + 1] = next;
        }
        NavGraph {
            pos,
            head,
            dst,
            wgt,
            nx: self.nx,
            nz: self.nz,
            cell: self.p.cell,
            min_x: self.min[0],
            min_z: self.min[2],
            col_start,
        }
    }

    /// Flat index → (column, layer).
    fn flat_col_layer(&self, i: usize) -> (usize, usize) {
        // col_start is sorted; the column is the last one starting at or before i.
        let mut lo = 0usize;
        let mut hi = self.col_start.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.col_start[mid] <= i {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let c = lo - 1;
        (c, i - self.col_start[c])
    }
}

pub struct NavGraph {
    pos: Vec<[f32; 3]>,
    head: Vec<usize>, // CSR bounds: node i's edges are dst[head[i]..head[i+1]]
    dst: Vec<usize>,
    wgt: Vec<f32>,
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

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"SE1NAV");
        b.push(1); // version
        b.extend_from_slice(&(self.pos.len() as u32).to_le_bytes());
        b.extend_from_slice(&(self.dst.len() as u32).to_le_bytes());
        for &p in &self.pos {
            for c in p {
                b.extend_from_slice(&c.to_bits().to_le_bytes());
            }
        }
        for &h in &self.head {
            b.extend_from_slice(&(h as u32).to_le_bytes());
        }
        for &d in &self.dst {
            b.extend_from_slice(&(d as u32).to_le_bytes());
        }
        for &w in &self.wgt {
            b.extend_from_slice(&w.to_bits().to_le_bytes());
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<NavGraph> {
        if b.len() < 9 || &b[0..6] != b"SE1NAV" || b[6] != 1 {
            return None;
        }
        let mut o = 7;
        let r = |b: &[u8], o: &mut usize| -> Option<u32> {
            if *o + 4 > b.len() {
                return None;
            }
            let mut v = [0u8; 4];
            v.copy_from_slice(&b[*o..*o + 4]);
            *o += 4;
            Some(u32::from_le_bytes(v))
        };
        let n = r(b, &mut o)? as usize;
        let e = r(b, &mut o)? as usize;
        let mut pos = Vec::with_capacity(n);
        for _ in 0..n {
            let mut p = [0f32; 3];
            for c in p.iter_mut() {
                *c = f32::from_bits(r(b, &mut o)?);
            }
            pos.push(p);
        }
        let mut head = Vec::with_capacity(n + 1);
        for _ in 0..=n {
            head.push(r(b, &mut o)? as usize);
        }
        let mut dst = Vec::with_capacity(e);
        for _ in 0..e {
            dst.push(r(b, &mut o)? as usize);
        }
        let mut wgt = Vec::with_capacity(e);
        for _ in 0..e {
            wgt.push(f32::from_bits(r(b, &mut o)?));
        }
        if o != b.len() || head[n] != e {
            return None;
        }
        // A deserialised graph has no grid layout; `nearest` falls back to a full scan.
        Some(NavGraph {
            pos,
            head,
            dst,
            wgt,
            nx: 0,
            nz: 0,
            cell: 2.0,
            min_x: 0.0,
            min_z: 0.0,
            col_start: Vec::new(),
        })
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
