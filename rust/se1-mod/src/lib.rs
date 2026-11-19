//! Rust mod layer for the Serious Engine web build.
//!
//! The C++ engine runs the game exactly as Croteam wrote it; this crate adds new systems on
//! top and takes its behaviour from config files, so mods are data, not recompiled C++.
//! The C interface lives in `port/common/se1mod.h`; keep the two in sync.
//!
//! Config: `<data_dir>/SE1Mod/config.toml` (see `SE1Mod/config.example.toml`).

mod config;
mod host;
mod quality;
mod survivors;

use std::collections::HashMap;
use std::ffi::{c_char, c_int, CStr};

use config::{CvarValue, ModConfig};
use host::{Host, SE1ModHost};

struct ModState {
    host: Host,
    config: ModConfig,
    frames: u64,
    survivors: Option<survivors::Survivors>,
    // ?quality=auto: created on the first frame when the page option is set
    quality: Option<QualityState>,
    quality_last_tm: Option<f64>,
    quality_checked: bool,   // page option read once (it is a main-thread call in the threaded build)
}

/// The auto quality controller plus the original cvar values it restores to.
struct QualityState {
    controller: quality::Controller,
    orig: HashMap<&'static str, CvarKind>,
}

#[derive(Clone, Copy)]
enum CvarKind {
    Float(f32),
    Int(i32),
}

// The engine is single-threaded on the web; all entry points are called from its main loop.
static mut STATE: Option<ModState> = None;

#[allow(static_mut_refs)]
fn state() -> Option<&'static mut ModState> {
    unsafe { STATE.as_mut() }
}

fn apply_cvars(host: &Host, cvars: &[(String, CvarValue)]) {
    for (name, value) in cvars {
        if !host.set_cvar(name, value) {
            host.log(&format!("se1mod: cannot set '{name}' (unknown symbol or wrong type)"));
        }
    }
}

fn run_commands(host: &Host, commands: &[String]) {
    for cmd in commands {
        host.shell_execute(cmd);
    }
}

// ---- ?quality=auto (quality.rs): lower rendering cvars while frames keep missing, restore when fast ----

/// Read the original value of each quality cvar once; `None` entries are skipped when applying.
fn quality_originals(host: &Host) -> HashMap<&'static str, CvarKind> {
    let mut orig = HashMap::new();
    if let Some(v) = host.get_float("gfx_fEnvParticlesDensity") {
        orig.insert("gfx_fEnvParticlesDensity", CvarKind::Float(v));
    }
    if let Some(v) = host.get_float("mdl_fLODMul") {
        orig.insert("mdl_fLODMul", CvarKind::Float(v));
    }
    if let Some(v) = host.get_index("gfx_iLensFlareQuality") {
        orig.insert("gfx_iLensFlareQuality", CvarKind::Int(v));
    }
    if let Some(v) = host.get_index("mdl_iShadowQuality") {
        orig.insert("mdl_iShadowQuality", CvarKind::Int(v));
    }
    if let Some(v) = host.get_index("mdl_bRenderDetail") {
        orig.insert("mdl_bRenderDetail", CvarKind::Int(v));
    }
    orig
}

/// Set one quality cvar from its original value through a transform (float cvars).
fn quality_set_f(host: &Host, orig: &HashMap<&'static str, CvarKind>, name: &str, f: impl FnOnce(f32) -> f32) {
    if let Some(CvarKind::Float(v)) = orig.get(name) {
        if !host.set_cvar(name, &CvarValue::Float(f64::from(f(*v)))) {
            host.log(&format!("quality: cannot set '{name}'"));
        }
    }
}

/// Set one quality cvar from its original value through a transform (index cvars).
fn quality_set_i(host: &Host, orig: &HashMap<&'static str, CvarKind>, name: &str, f: impl FnOnce(i32) -> i32) {
    if let Some(CvarKind::Int(v)) = orig.get(name) {
        if !host.set_cvar(name, &CvarValue::Int(f(*v) as i64)) {
            host.log(&format!("quality: cannot set '{name}'"));
        }
    }
}

/// Apply the cvar table for a quality level. Every level starts from the original values, so
/// stepping back up (3 -> 2 -> 1) also restores what only the higher levels changed.
fn quality_apply_level(host: &Host, orig: &HashMap<&'static str, CvarKind>, level: u8) {
    for (name, kind) in orig.iter() {
        let v = match kind {
            CvarKind::Float(v) => CvarValue::Float(f64::from(*v)),
            CvarKind::Int(v) => CvarValue::Int(*v as i64),
        };
        if !host.set_cvar(name, &v) {
            host.log(&format!("quality: cannot set '{name}'"));
        }
    }
    match level {
        0 => {}
        1 => {
            quality_set_f(host, orig, "gfx_fEnvParticlesDensity", |v| v * 0.5);
            quality_set_f(host, orig, "mdl_fLODMul", |v| v * 1.5);
            quality_set_i(host, orig, "gfx_iLensFlareQuality", |v| v.min(1));
        }
        2 => {
            quality_set_f(host, orig, "gfx_fEnvParticlesDensity", |_| 0.0);
            quality_set_f(host, orig, "mdl_fLODMul", |v| v * 2.5);
            quality_set_i(host, orig, "gfx_iLensFlareQuality", |_| 0);
            quality_set_i(host, orig, "mdl_iShadowQuality", |v| v.min(1));
        }
        _ => {
            quality_set_f(host, orig, "gfx_fEnvParticlesDensity", |_| 0.0);
            quality_set_f(host, orig, "mdl_fLODMul", |v| v * 4.0);
            quality_set_i(host, orig, "gfx_iLensFlareQuality", |_| 0);
            quality_set_i(host, orig, "mdl_iShadowQuality", |_| 0);
            quality_set_i(host, orig, "mdl_bRenderDetail", |_| 0);
        }
    }
}

/// Called once after engine + game init. Returns 0 on success.
#[no_mangle]
pub extern "C" fn se1mod_init(raw: *const SE1ModHost) -> c_int {
    let Some(host) = (unsafe { Host::from_raw(raw) }) else {
        return -1;
    };
    host.log(&format!(
        "se1mod {} (Rust) attached to {}",
        env!("CARGO_PKG_VERSION"),
        host.game()
    ));

    let config = ModConfig::load(&host);
    if let Some(msg) = &config.startup.message {
        host.log(msg);
    }
    apply_cvars(&host, &config.cvars);
    run_commands(&host, &config.startup.commands);

    unsafe { STATE = Some(ModState { host, config, frames: 0, survivors: None, quality: None, quality_last_tm: None, quality_checked: false }) };
    0
}

/// Called once per presented frame.
#[no_mangle]
pub extern "C" fn se1mod_frame(tm_real: f64) {
    let Some(st) = state() else { return };
    st.frames += 1;
    if let Some(sv) = st.survivors.as_mut() {
        sv.frame(&st.host);
    }
    // ?quality=auto: create the controller on the first frame when the page option is set
    if !st.quality_checked {
        st.quality_checked = true;
        if st.host.page_option("se1QualityAuto") > 0.0 {
            st.quality = Some(QualityState { controller: quality::Controller::new(), orig: quality_originals(&st.host) });
            st.host.log("quality: auto (budget detection…)");
        }
    }
    if let Some(q) = st.quality.as_mut() {
        if let Some(last) = st.quality_last_tm {
            let prev_budget = q.controller.budget();
            if let Some(new_level) = q.controller.frame(tm_real - last) {
                quality_apply_level(&st.host, &q.orig, new_level);
                let budget_ms = q.controller.budget() * 1000.0;
                st.host.log(&format!("quality: level {new_level} (slow frames {:.0}% in the last window, budget {budget_ms:.1} ms)", q.controller.last_slow_frac() * 100.0));
            }
            // log once when the budget is first known
            if prev_budget == 0.0 && q.controller.budget() > 0.0 {
                let budget_ms = q.controller.budget() * 1000.0;
                st.host.log(&format!("quality: budget {budget_ms:.1} ms"));
            }
        }
        st.quality_last_tm = Some(tm_real);
    }
}

/// Called when a session (level) has started.
#[no_mangle]
pub extern "C" fn se1mod_level_started(world_file: *const c_char) {
    let Some(st) = state() else { return };
    let world = if world_file.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(world_file) }.to_string_lossy().replace('\\', "/")
    };
    st.host.log(&format!("se1mod: level started: {world}"));
    run_commands(&st.host, &st.config.level.commands);
    // ?mode=survivors (port/web/survivors.js): run Serious Survivors in this level
    st.survivors = (st.host.page_option("se1Survivors") > 0.0).then(|| survivors::Survivors::new(&st.host));
    if let Some(cmds) = st.config.level.per_world.get(&world) {
        run_commands(&st.host, cmds);
    }
}

/// Called before the engine shuts down.
#[no_mangle]
pub extern "C" fn se1mod_shutdown() {
    if let Some(st) = state() {
        st.host.log(&format!("se1mod: shutdown after {} frames", st.frames));
    }
    unsafe { STATE = None };
}
