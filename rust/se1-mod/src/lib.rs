//! Rust mod layer for the Serious Engine web build.
//!
//! The C++ engine runs the game exactly as Croteam wrote it; this crate adds new systems on
//! top and takes its behaviour from config files, so mods are data, not recompiled C++.
//! The C interface lives in `port/common/se1mod.h`; keep the two in sync.
//!
//! Config: `<data_dir>/SE1Mod/config.toml` (see `SE1Mod/config.example.toml`).

mod config;
mod host;
mod survivors;

use std::ffi::{c_char, c_int, CStr};

use config::{CvarValue, ModConfig};
use host::{Host, SE1ModHost};

struct ModState {
    host: Host,
    config: ModConfig,
    frames: u64,
    survivors: Option<survivors::Survivors>,
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

    unsafe { STATE = Some(ModState { host, config, frames: 0, survivors: None }) };
    0
}

/// Called once per presented frame.
#[no_mangle]
pub extern "C" fn se1mod_frame(_tm_real: f64) {
    if let Some(st) = state() {
        st.frames += 1;
        if let Some(sv) = st.survivors.as_mut() {
            sv.frame(&st.host);
        }
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
