//! Automatic quality controller (opt-in via `?quality=auto`).
//!
//! Pure state machine: `frame(dt)` is fed one presented-frame interval in seconds and decides
//! when to lower the rendering quality (level 0 = full … `MAX_LEVEL`) while frames keep coming
//! in too slowly, and when to restore it after the device has caught up. No Host calls here;
//! the caller (lib.rs) applies the cvars when `frame` reports a level change.

/// Full quality … lowest.
pub const MAX_LEVEL: u8 = 3;

const HITCH_DT: f64 = 0.5;      // longer than this: pause/hidden tab/loading, ignore the frame
const BUDGET_FRAMES: usize = 120; // how many valid frames measure the initial budget
const BUDGET_MIN: f64 = 1.0 / 144.0;
const BUDGET_MAX: f64 = 1.0 / 30.0;
const WINDOW_SECONDS: f64 = 2.0; // a window is evaluated once its frames sum to this many seconds
const SLOW_FACTOR: f64 = 1.5;   // a frame is slow when dt > SLOW_FACTOR * budget
const SLOW_FRAC_RAISE: f64 = 0.10;  // slow fraction above this lowers the quality
const GOOD_FRAC: f64 = 0.02;      // slow fraction below this counts as a good window
const HOLD_START: u32 = 5;       // good windows needed to restore one level
const HOLD_MAX: u32 = 80;
const OSCILLATION_WINDOW: u32 = 3; // a raise within this many evaluated windows after a restore doubles the hold
pub struct Controller {
    level: u8,
    budget: f64,                 // 0 until known
    budget_samples: Vec<f64>,
    window_sum: f64,
    window_frames: u32,
    window_slow: u32,
    warmup: bool,                // this window is discarded (first after budget, first after a level change)
    good_streak: u32,
    hold: u32,
    since_restore: u32,          // evaluated windows since the last restore (for oscillation detection)
    had_restore: bool,           // a restore has happened at least once (gates oscillation detection)
    last_frac: f64,              // slow fraction of the last evaluated window (for the log line)
}

impl Default for Controller {
    fn default() -> Self {
        Self {
            level: 0,
            budget: 0.0,
            budget_samples: Vec::with_capacity(BUDGET_FRAMES),
            window_sum: 0.0,
            window_frames: 0,
            window_slow: 0,
            warmup: true,               // first window after the budget (and after every level change) is discarded
            good_streak: 0,
            hold: HOLD_START,
            since_restore: 0,
            had_restore: false,
            last_frac: 0.0,
        }
    }
}

impl Controller {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one frame interval in seconds. Returns `Some(new_level)` when the level changes.
    pub fn frame(&mut self, dt: f64) -> Option<u8> {
        // A huge interval (pause, hidden tab, loading) is not a slow frame: drop it and the
        // partially filled window so it can't skew the next evaluation.
        if dt > HITCH_DT {
            self.window_sum = 0.0;
            self.window_frames = 0;
            self.window_slow = 0;
            return None;
        }
        if self.budget_samples.len() < BUDGET_FRAMES {
            self.budget_samples.push(dt);
            if self.budget_samples.len() == BUDGET_FRAMES {
                let mut s = self.budget_samples.clone();
                s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                self.budget = s[BUDGET_FRAMES / 2].clamp(BUDGET_MIN, BUDGET_MAX);
            }
            return None; // no level changes while the budget is being measured
        }
        self.window_sum += dt;
        self.window_frames += 1;
        if dt > SLOW_FACTOR * self.budget {
            self.window_slow += 1;
        }
        if self.window_sum < WINDOW_SECONDS {
            return None;
        }
        // Window complete: evaluate it and start the next one.
        let slow_frac = self.window_slow as f64 / self.window_frames as f64;
        self.last_frac = slow_frac;
        let mut changed = None;
        if self.warmup {
            // first window after the budget, and after every level change: not evaluated
            self.warmup = false;
        } else {
            self.since_restore += 1;
            let old_level = self.level;
            if slow_frac > SLOW_FRAC_RAISE && self.level < MAX_LEVEL {
                self.level += 1;
                self.good_streak = 0;
                self.warmup = true;
                changed = Some(self.level);
            } else if slow_frac < GOOD_FRAC && self.level > 0 {
                self.good_streak += 1;
                if self.good_streak >= self.hold {
                    self.level -= 1;
                    self.good_streak = 0;
                    self.warmup = true;
                    changed = Some(self.level);
                }
            } else if slow_frac >= GOOD_FRAC {
                // neither good nor bad: the restore streak breaks
                self.good_streak = 0;
            }
            if let Some(l) = changed {
                // oscillation: a raise within OSCILLATION_WINDOW evaluated windows after a
                // restore means the device is right on the boundary, be more conservative
                if l > old_level && l > 0 && self.had_restore && self.since_restore <= OSCILLATION_WINDOW {
                    self.hold = (self.hold * 2).min(HOLD_MAX);
                }
                if l < old_level {
                    // restore: reset the oscillation counter
                    self.since_restore = 0;
                    self.had_restore = true;
                }
            }
        }
        self.window_sum = 0.0;
        self.window_frames = 0;
        self.window_slow = 0;
        changed
    }

    /// 0 = full quality … MAX_LEVEL.
    pub fn level(&self) -> u8 {
        self.level
    }

    /// Detected frame budget in seconds (0 until known).
    pub fn budget(&self) -> f64 {
        self.budget
    }

    /// Slow fraction (0..=1) of the last evaluated window, for log lines.
    pub fn last_slow_frac(&self) -> f64 {
        self.last_frac
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed frames, collecting every reported level change in order.
    fn feed(c: &mut Controller, dts: &[f64]) -> Vec<u8> {
        dts.iter().filter_map(|dt| c.frame(*dt)).collect()
    }

    fn n(n: usize, dt: f64) -> Vec<f64> {
        vec![dt; n]
    }

    #[test]
    fn steady_60hz_stays_full() {
        let mut c = Controller::new();
        let changes = feed(&mut c, &n(3600, 1.0 / 60.0));
        assert!(changes.is_empty());
        assert_eq!(c.level(), 0);
        assert!((c.budget() - 1.0 / 60.0).abs() < 1e-6);
    }

    #[test]
    fn steady_30hz_and_144hz_stay_full() {
        let mut c = Controller::new();
        let changes = feed(&mut c, &n(3600, 1.0 / 30.0));
        assert!(changes.is_empty());
        assert_eq!(c.level(), 0);

        let mut c = Controller::new();
        let changes = feed(&mut c, &n(17280, 1.0 / 144.0));
        assert!(changes.is_empty());
        assert_eq!(c.level(), 0);
    }

    #[test]
    fn slow_device_lowers_step_by_step() {
        let mut c = Controller::new();
        feed(&mut c, &n(120, 1.0 / 60.0)); // budget = 1/60
        // 30% of frames take 0.040 s (slow, > 1.5 * budget), the rest 1/60: slow_frac = 0.3
        let pattern: Vec<f64> = (0..1000).map(|i| if i % 10 < 3 { 0.040 } else { 1.0 / 60.0 }).collect();
        let levels = feed(&mut c, &pattern);
        assert_eq!(levels, vec![1, 2, 3]);
        assert_eq!(c.level(), 3);
        // and it stays there
        let more: Vec<f64> = (0..200).map(|i| if i % 10 < 3 { 0.040 } else { 1.0 / 60.0 }).collect();
        assert!(feed(&mut c, &more).is_empty());
        assert_eq!(c.level(), 3);
    }

    #[test]
    fn recovers_after_hold() {
        let mut c = Controller::new();
        feed(&mut c, &n(120, 1.0 / 60.0));
        // 30% slow frames: each 2 s window holds ~84 frames, so 400 frames cover the
        // warm-up + bad + warm-up + bad windows needed to reach level 2
        let slow: Vec<f64> = (0..400).map(|i| if i % 10 < 3 { 0.040 } else { 1.0 / 60.0 }).collect();
        assert_eq!(feed(&mut c, &slow), vec![1, 2]);
        // now steady 60 fps: each window is 2.0 s of 1/60 frames
        let mut changes = Vec::new();
        let mut first_change_window = 0;
        for w in 1..=30 {
            let before = changes.len();
            changes.extend(feed(&mut c, &n(120, 1.0 / 60.0)));
            if changes.len() > before && first_change_window == 0 {
                first_change_window = w;
            }
        }
        assert_eq!(changes, vec![1, 0], "restores one level per hold period");
        assert!(
            first_change_window >= 5,
            "first restore needs >= 5 good windows (>= 10 s), got window {first_change_window}"
        );
    }

    #[test]
    fn oscillation_doubles_hold() {
        let mut c = Controller::new();
        feed(&mut c, &n(120, 1.0 / 60.0)); // budget = 1/60, warmup = true

        // 20 slow (0.040 s) + 96 fast (1/60 s) = 2.0 s; 20/116 ≈ 17% slow → bad window
        let slow = || -> Vec<f64> { (0..116).map(|i| if i < 20 { 0.040 } else { 1.0 / 60.0 }).collect() };
        let good = || n(120, 1.0 / 60.0);

        // warm-up window, then one bad window: level 0 → 1
        feed(&mut c, &good());
        feed(&mut c, &slow());
        assert_eq!(c.level(), 1);

        // recover: warm-up + 5 good windows → 0 (hold = 5)
        feed(&mut c, &good());
        for _ in 0..5 { feed(&mut c, &good()); }
        assert_eq!(c.level(), 0, "restored after the initial hold of 5");

        // slow again right away: warm-up + one bad window → back to 1 (oscillation)
        feed(&mut c, &good());
        feed(&mut c, &slow());
        assert_eq!(c.level(), 1, "raise within the oscillation window doubles the hold");

        // the next recovery needs the doubled hold (10): warm-up + 9 good windows are not enough
        feed(&mut c, &good());
        for _ in 0..9 { feed(&mut c, &good()); }
        assert_eq!(c.level(), 1, "no restore within 9 good windows after an oscillation");

        // the 10th good window restores
        feed(&mut c, &good());
        assert_eq!(c.level(), 0);
    }

    #[test]
    fn hitches_are_ignored() {
        let mut c = Controller::new();
        // 60 s of 60 fps with one 2.0 s hitch every 10 s
        let dts: Vec<f64> = (0..3600).map(|i| if i % 600 == 0 { 2.0 } else { 1.0 / 60.0 }).collect();
        let changes = feed(&mut c, &dts);
        assert!(changes.is_empty(), "hitches must not change the level: {changes:?}");
        assert_eq!(c.level(), 0);
    }

    #[test]
    fn mixed_window_resets_streak() {
        let mut c = Controller::new();
        feed(&mut c, &n(120, 1.0 / 60.0));
        // 25% slow frames until level 1 (warm-up + one bad window)
        let slow = || -> Vec<f64> { (0..100).map(|i| if i % 4 < 1 { 0.040 } else { 1.0 / 60.0 }).collect() };
        feed(&mut c, &n(120, 1.0 / 60.0)); // warm-up
        feed(&mut c, &slow());
        assert_eq!(c.level(), 1);
        // 5% slow frames (0.040 s > 1.5 * budget = 0.025 s): neither good (< 2%) nor bad (> 10%) -> resets the streak
        let mixed = || -> Vec<f64> { (0..100).map(|i| if i % 20 == 0 { 0.040 } else { 1.0 / 60.0 }).collect() };
        feed(&mut c, &n(120, 1.0 / 60.0)); // warm-up after the raise
        // alternate good / mixed windows for far longer than the hold: no restore
        for _ in 0..20 {
            feed(&mut c, &n(120, 1.0 / 60.0)); // good
            feed(&mut c, &mixed());           // resets the good streak
        }
        assert_eq!(c.level(), 1);
    }
}
