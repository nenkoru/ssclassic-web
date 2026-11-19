//! Safe wrapper around the engine's `SE1ModHost` function table (port/common/se1mod.h).

use std::ffi::{c_char, c_int, CStr, CString};

use crate::config::CvarValue;

pub const API_VERSION: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SE1ModHost {
    pub api_version: u32,
    pub game: *const c_char,
    pub data_dir: *const c_char,
    pub log: Option<extern "C" fn(*const c_char)>,
    pub shell_execute: Option<extern "C" fn(*const c_char)>,
    pub get_index: Option<extern "C" fn(*const c_char, *mut i32) -> c_int>,
    pub get_float: Option<extern "C" fn(*const c_char, *mut f32) -> c_int>,
    pub set_index: Option<extern "C" fn(*const c_char, i32) -> c_int>,
    pub set_float: Option<extern "C" fn(*const c_char, f32) -> c_int>,
    pub set_string: Option<extern "C" fn(*const c_char, *const c_char) -> c_int>,
    // API 2: gameplay (port/common/se1mod.h)
    pub game_time: Option<extern "C" fn() -> f64>,
    pub player: Option<extern "C" fn(*mut f32, *mut f32) -> c_int>,
    pub player_heal: Option<extern "C" fn(f32, f32)>,
    pub spawn: Option<extern "C" fn(*const c_char, *const f32) -> c_int>,
    pub alive: Option<extern "C" fn(c_int) -> c_int>,
    pub position: Option<extern "C" fn(c_int, *mut f32) -> c_int>,
    pub damage: Option<extern "C" fn(c_int, f32)>,
    pub release: Option<extern "C" fn(c_int)>,
    pub set_pause: Option<extern "C" fn(c_int)>,
    pub page_option: Option<extern "C" fn(*const c_char) -> f64>,
    pub ui_post: Option<extern "C" fn(*const c_char)>,
    pub ui_poll: Option<extern "C" fn() -> c_int>,
    pub close_computer: Option<extern "C" fn()>,
    pub player_view: Option<extern "C" fn(dir3: *mut f32) -> c_int>,
    // API 4: gameplay toolkit
    pub spawn_enemy: Option<extern "C" fn(*const c_char, c_int, *const f32, f32, f32, u32, c_int) -> c_int>,
    pub health: Option<extern "C" fn(c_int) -> f32>,
    pub max_health: Option<extern "C" fn(c_int) -> f32>,
    pub file_exists: Option<extern "C" fn(*const c_char) -> c_int>,
    pub effect: Option<extern "C" fn(c_int, *const f32, f32)>,
    pub lightning: Option<extern "C" fn(*const f32, *const f32, f32, f32)>,
    pub sound: Option<extern "C" fn(*const c_char, f32)>,
    pub spawn_item: Option<extern "C" fn(*const c_char, c_int, *const f32) -> c_int>,
    pub exists: Option<extern "C" fn(c_int) -> c_int>,
    pub set_position: Option<extern "C" fn(c_int, *const f32)>,
    pub destroy: Option<extern "C" fn(c_int)>,
    pub weapon: Option<extern "C" fn() -> c_int>,
    pub weapons_owned: Option<extern "C" fn() -> c_int>,
    pub ammo: Option<extern "C" fn(*mut i32)>,
    pub give_ammo: Option<extern "C" fn(c_int, c_int)>,
    pub give_weapon: Option<extern "C" fn(c_int)>,
    pub projectile: Option<extern "C" fn(c_int, *const f32, *const f32, f32)>,
    pub armor: Option<extern "C" fn(f32, f32) -> f32>,
    pub player_eye: Option<extern "C" fn(*mut f32, *mut f32) -> c_int>,
}

/// Options for `Host::spawn_enemy`.
#[derive(Clone, Copy)]
pub struct EnemyOpts {
    pub variant: i32,
    pub hp_mul: f32,
    pub stretch: f32,
    pub glow: u32,
    pub boss: bool,
}
impl Default for EnemyOpts {
    fn default() -> Self {
        EnemyOpts { variant: -1, hp_mul: 1.0, stretch: 0.0, glow: 0, boss: false }
    }
}

pub struct Host {
    raw: SE1ModHost,
    game: String,
    data_dir: String,
}

fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

fn from_c(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

impl Host {
    /// # Safety
    /// `raw` must point to a valid `SE1ModHost` whose function pointers stay valid for the
    /// lifetime of the engine.
    pub unsafe fn from_raw(raw: *const SE1ModHost) -> Option<Host> {
        if raw.is_null() {
            return None;
        }
        let raw = *raw;
        if raw.api_version != API_VERSION {
            return None;
        }
        Some(Host { game: from_c(raw.game), data_dir: from_c(raw.data_dir), raw })
    }

    /// Game name: "SamTFE" or "SamTSE".
    pub fn game(&self) -> &str {
        &self.game
    }

    /// Game data root in the (virtual) filesystem, e.g. "/".
    pub fn data_dir(&self) -> &str {
        &self.data_dir
    }

    /// Print a message to the engine console / log.
    pub fn log(&self, msg: &str) {
        if let Some(f) = self.raw.log {
            f(cstr(msg).as_ptr());
        }
    }

    /// Run a console script, exactly as typed in the in-game console (appends `;` if missing).
    pub fn shell_execute(&self, script: &str) {
        if let Some(f) = self.raw.shell_execute {
            // the engine's shell wants complete statements
            let mut s = script.trim().to_string();
            if !s.ends_with(';') {
                s.push(';');
            }
            f(cstr(&s).as_ptr());
        }
    }

    /// Read a console INDEX symbol; `None` if the symbol doesn't exist or has another type.
    pub fn get_index(&self, name: &str) -> Option<i32> {
        let f = self.raw.get_index?;
        let mut v = 0;
        (f(cstr(name).as_ptr(), &mut v) != 0).then_some(v)
    }

    /// Read a console FLOAT symbol; `None` if the symbol doesn't exist or has another type.
    pub fn get_float(&self, name: &str) -> Option<f32> {
        let f = self.raw.get_float?;
        let mut v = 0.0;
        (f(cstr(name).as_ptr(), &mut v) != 0).then_some(v)
    }

    // ---- API 2: gameplay ----
    /// Simulation time in seconds; it stops while the game is paused.
    pub fn game_time(&self) -> f64 {
        self.raw.game_time.map_or(0.0, |f| f())
    }
    /// Local player position (x, y, z; y is up) and health, if alive.
    pub fn player(&self) -> Option<([f32; 3], f32)> {
        let f = self.raw.player?;
        let (mut p, mut h) = ([0f32; 3], 0f32);
        (f(p.as_mut_ptr(), &mut h) != 0).then_some((p, h))
    }
    /// Add health to the local player, never above `max`.
    pub fn player_heal(&self, amount: f32, max: f32) {
        if let Some(f) = self.raw.player_heal {
            f(amount, max)
        }
    }
    /// Spawn an entity class at a position; returns a handle.
    pub fn spawn(&self, class_file: &str, pos: [f32; 3]) -> Option<i32> {
        let f = self.raw.spawn?;
        let h = f(cstr(class_file).as_ptr(), pos.as_ptr());
        (h > 0).then_some(h)
    }
    /// Whether an entity handle is alive (`false` if dead, gone, or unknown).
    pub fn alive(&self, h: i32) -> bool {
        self.raw.alive.map_or(false, |f| f(h) != 0)
    }
    /// Position (x, y, z; y is up) of a live entity handle; `None` if dead or gone.
    pub fn position(&self, h: i32) -> Option<[f32; 3]> {
        let f = self.raw.position?;
        let mut p = [0f32; 3];
        (f(h, p.as_mut_ptr()) != 0).then_some(p)
    }
    /// Damage an entity handle as if the local player hit it.
    pub fn damage(&self, h: i32, amount: f32) {
        if let Some(f) = self.raw.damage {
            f(h, amount)
        }
    }
    /// Forget an entity handle (frees the slot).
    pub fn release(&self, h: i32) {
        if let Some(f) = self.raw.release {
            f(h)
        }
    }
    /// Pause (`true`) or unpause (`false`) the local game.
    pub fn set_pause(&self, on: bool) {
        if let Some(f) = self.raw.set_pause {
            f(on as c_int)
        }
    }
    /// A numeric page option (`Module[name]` on the web page), 0 if unset.
    pub fn page_option(&self, name: &str) -> f64 {
        self.raw.page_option.map_or(0.0, |f| f(cstr(name).as_ptr()))
    }
    /// Post a JSON message to the page overlay (`Module.se1ModUi`).
    pub fn ui_post(&self, json: &str) {
        if let Some(f) = self.raw.ui_post {
            f(cstr(json).as_ptr())
        }
    }
    /// Close the in-game computer (NETRICSA) if it is open.
    /// The local player's view direction (unit vector), if there is a player.
    pub fn player_view(&self) -> Option<[f32; 3]> {
        let f = self.raw.player_view?;
        let mut d = [0f32; 3];
        (f(d.as_mut_ptr()) != 0).then_some(d)
    }
    /// Close the in-game computer (NETRICSA) if it is open.
    pub fn close_computer(&self) {
        if let Some(f) = self.raw.close_computer {
            f()
        }
    }

    /// A value the page sent back, if any.
    pub fn ui_poll(&self) -> Option<i32> {
        let v = self.raw.ui_poll.map_or(-1, |f| f());
        (v >= 0).then_some(v)
    }

    /// Set a console variable, coercing between INDEX and FLOAT the way the shell would.
    pub fn set_cvar(&self, name: &str, value: &CvarValue) -> bool {
        let n = cstr(name);
        let call_i = |v: i32| self.raw.set_index.map_or(false, |f| f(n.as_ptr(), v) != 0);
        let call_f = |v: f32| self.raw.set_float.map_or(false, |f| f(n.as_ptr(), v) != 0);
        match value {
            CvarValue::Int(v) => call_i(*v as i32) || call_f(*v as f32),
            CvarValue::Float(v) => call_f(*v as f32),
            CvarValue::Bool(b) => call_i(*b as i32),
            CvarValue::Str(s) => {
                let v = cstr(s);
                self.raw.set_string.map_or(false, |f| f(n.as_ptr(), v.as_ptr()) != 0)
            }
        }
    }

    // ---- API 4: gameplay toolkit ----
    /// Spawn a monster that hunts the player at once. Check `file_exists` for its model first.
    pub fn spawn_enemy(&self, class: &str, pos: [f32; 3], o: EnemyOpts) -> Option<i32> {
        let f = self.raw.spawn_enemy?;
        let c = cstr(class);
        let h = f(c.as_ptr(), o.variant, pos.as_ptr(), o.hp_mul, o.stretch, o.glow, o.boss as c_int);
        (h > 0).then_some(h)
    }
    /// Health of an entity handle; 0 when dead or gone.
    pub fn health(&self, h: i32) -> f32 {
        self.raw.health.map_or(0.0, |f| f(h))
    }
    /// Maximum health of an entity handle; 0 when dead or gone.
    pub fn max_health(&self, h: i32) -> f32 {
        self.raw.max_health.map_or(0.0, |f| f(h))
    }
    /// Whether a file exists in the game data; spawn classes whose assets are missing are fatal.
    pub fn file_exists(&self, path: &str) -> bool {
        let c = cstr(path);
        self.raw.file_exists.is_some_and(|f| f(c.as_ptr()) != 0)
    }
    /// Play a `BasicEffect` (`BET_*` type) at a position: visual plus sound.
    pub fn effect(&self, kind: i32, pos: [f32; 3], size: f32) {
        if let Some(f) = self.raw.effect {
            f(kind, pos.as_ptr(), size);
        }
    }
    /// Play a lightning arc between two positions, with the given size and life.
    pub fn lightning(&self, from: [f32; 3], to: [f32; 3], size: f32, life: f32) {
        if let Some(f) = self.raw.lightning {
            f(from.as_ptr(), to.as_ptr(), size, life);
        }
    }
    /// Play a 2D sound from a file path; it plays while the game is paused too.
    pub fn sound(&self, path: &str, volume: f32) {
        if let Some(f) = self.raw.sound {
            let c = cstr(path);
            f(c.as_ptr(), volume);
        }
    }
    /// Spawn an item class of a given type at a position; returns a handle, `None` on failure.
    pub fn spawn_item(&self, class: &str, kind: i32, pos: [f32; 3]) -> Option<i32> {
        let f = self.raw.spawn_item?;
        let c = cstr(class);
        let h = f(c.as_ptr(), kind, pos.as_ptr());
        (h > 0).then_some(h)
    }
    /// Whether an entity handle (items, effects) is still in the world.
    pub fn exists(&self, h: i32) -> bool {
        self.raw.exists.is_some_and(|f| f(h) != 0)
    }
    /// Move an entity handle to a new position.
    pub fn set_position(&self, h: i32, pos: [f32; 3]) {
        if let Some(f) = self.raw.set_position {
            f(h, pos.as_ptr());
        }
    }
    /// Remove an entity and free its handle.
    pub fn destroy(&self, h: i32) {
        if let Some(f) = self.raw.destroy {
            f(h);
        }
    }
    /// The local player's current `WeaponType`; 0 if unavailable.
    pub fn weapon(&self) -> i32 {
        self.raw.weapon.map_or(0, |f| f())
    }
    /// Owned weapons as a bitmask: bit `1 << (WeaponType-1)` per owned weapon.
    pub fn weapons_owned(&self) -> i32 {
        self.raw.weapons_owned.map_or(0, |f| f())
    }
    /// [bullets, shells, rockets, grenades, cells, ironballs] and their maxima.
    pub fn ammo(&self) -> ([i32; 6], [i32; 6]) {
        let mut a = [0i32; 12];
        if let Some(f) = self.raw.ammo {
            f(a.as_mut_ptr());
        }
        ([a[0], a[1], a[2], a[3], a[4], a[5]], [a[6], a[7], a[8], a[9], a[10], a[11]])
    }
    /// Give the player ammo of an `AmmoItemType`; capped by the player's maximum.
    pub fn give_ammo(&self, ait_type: i32, amount: i32) {
        if let Some(f) = self.raw.give_ammo {
            f(ait_type, amount);
        }
    }
    /// Give the player a weapon of a `WeaponItemType`.
    pub fn give_weapon(&self, wit_type: i32) {
        if let Some(f) = self.raw.give_weapon {
            f(wit_type);
        }
    }
    /// Launch a projectile of the given type from a position along a direction; launched by the player.
    pub fn projectile(&self, kind: i32, pos: [f32; 3], dir: [f32; 3], speed: f32) {
        if let Some(f) = self.raw.projectile {
            f(kind, pos.as_ptr(), dir.as_ptr(), speed);
        }
    }
    /// Add armor up to `max` (0 to just read it); returns the player's armor.
    pub fn armor(&self, add: f32, max: f32) -> f32 {
        self.raw.armor.map_or(0.0, |f| f(add, max))
    }
    /// Eye position and view direction of the local player.
    pub fn player_eye(&self) -> Option<([f32; 3], [f32; 3])> {
        let f = self.raw.player_eye?;
        let (mut p, mut d) = ([0f32; 3], [0f32; 3]);
        (f(p.as_mut_ptr(), d.as_mut_ptr()) != 0).then_some((p, d))
    }
}
