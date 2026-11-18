//! Safe wrapper around the engine's `SE1ModHost` function table (port/common/se1mod.h).

use std::ffi::{c_char, c_int, CStr, CString};

use crate::config::CvarValue;

pub const API_VERSION: u32 = 1;

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
