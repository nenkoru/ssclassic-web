//! Safe wrapper around the engine's `SE1ModHost` function table (port/common/se1mod.h).

use std::ffi::{c_char, c_int, CStr, CString};

use crate::config::CvarValue;

pub const API_VERSION: u32 = 3;

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

    pub fn game(&self) -> &str {
        &self.game
    }

    pub fn data_dir(&self) -> &str {
        &self.data_dir
    }

    pub fn log(&self, msg: &str) {
        if let Some(f) = self.raw.log {
            f(cstr(msg).as_ptr());
        }
    }

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

    pub fn get_index(&self, name: &str) -> Option<i32> {
        let f = self.raw.get_index?;
        let mut v = 0;
        (f(cstr(name).as_ptr(), &mut v) != 0).then_some(v)
    }

    pub fn get_float(&self, name: &str) -> Option<f32> {
        let f = self.raw.get_float?;
        let mut v = 0.0;
        (f(cstr(name).as_ptr(), &mut v) != 0).then_some(v)
    }

    // ---- API 2: gameplay ----
    pub fn game_time(&self) -> f64 {
        self.raw.game_time.map_or(0.0, |f| f())
    }
    /// Local player position (x, y, z; y is up) and health, if alive.
    pub fn player(&self) -> Option<([f32; 3], f32)> {
        let f = self.raw.player?;
        let (mut p, mut h) = ([0f32; 3], 0f32);
        (f(p.as_mut_ptr(), &mut h) != 0).then_some((p, h))
    }
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
    pub fn alive(&self, h: i32) -> bool {
        self.raw.alive.map_or(false, |f| f(h) != 0)
    }
    pub fn position(&self, h: i32) -> Option<[f32; 3]> {
        let f = self.raw.position?;
        let mut p = [0f32; 3];
        (f(h, p.as_mut_ptr()) != 0).then_some(p)
    }
    pub fn damage(&self, h: i32, amount: f32) {
        if let Some(f) = self.raw.damage {
            f(h, amount)
        }
    }
    pub fn release(&self, h: i32) {
        if let Some(f) = self.raw.release {
            f(h)
        }
    }
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
}
