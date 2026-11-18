//! `SE1Mod/config.toml`: everything a mod can change without touching code.

use std::collections::HashMap;

use serde::Deserialize;

use crate::host::Host;

pub const CONFIG_PATH: &str = "SE1Mod/config.toml";

#[derive(Debug, Clone, PartialEq)]
pub enum CvarValue {
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(String),
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Startup {
    /// printed to the console when the mod layer starts
    pub message: Option<String>,
    /// console commands run once after startup, e.g. `"hud_bShowInfo = 1"`
    pub commands: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Level {
    /// console commands run whenever any level starts
    pub commands: Vec<String>,
    /// extra commands for one level, keyed by world file, e.g. `"Levels/KarnakDemo.wld"`
    pub per_world: HashMap<String, Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawConfig {
    startup: Startup,
    level: Level,
    /// console variable overrides applied at startup
    cvars: toml::Table,
}

#[derive(Debug, Default)]
pub struct ModConfig {
    pub startup: Startup,
    pub level: Level,
    pub cvars: Vec<(String, CvarValue)>,
}

impl ModConfig {
    pub fn parse(text: &str) -> Result<ModConfig, String> {
        let raw: RawConfig = toml::from_str(text).map_err(|e| e.to_string())?;
        let mut cvars = Vec::new();
        for (name, v) in raw.cvars {
            let v = match v {
                toml::Value::Integer(i) => CvarValue::Int(i),
                toml::Value::Float(f) => CvarValue::Float(f),
                toml::Value::Boolean(b) => CvarValue::Bool(b),
                toml::Value::String(s) => CvarValue::Str(s),
                other => return Err(format!("cvar '{name}': unsupported value type {}", other.type_str())),
            };
            cvars.push((name, v));
        }
        cvars.sort_by(|a, b| a.0.cmp(&b.0)); // deterministic order
        Ok(ModConfig { startup: raw.startup, level: raw.level, cvars })
    }

    /// Load from the game data folder; a missing file is fine (defaults), a broken one is
    /// reported in the console and ignored.
    pub fn load(host: &Host) -> ModConfig {
        let mut path = host.data_dir().to_string();
        if !path.ends_with('/') {
            path.push('/');
        }
        path.push_str(CONFIG_PATH);
        match std::fs::read_to_string(&path) {
            Ok(text) => match ModConfig::parse(&text) {
                Ok(c) => {
                    host.log(&format!("se1mod: loaded {path} ({} cvars)", c.cvars.len()));
                    c
                }
                Err(e) => {
                    host.log(&format!("se1mod: error in {path}: {e}"));
                    ModConfig::default()
                }
            },
            Err(_) => {
                host.log(&format!("se1mod: no {path}, using defaults"));
                ModConfig::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_config() {
        let c = ModConfig::parse(
            r#"
            [startup]
            message = "hi"
            commands = ["a", "b"]
            [level]
            commands = ["c"]
            [level.per_world]
            "Levels/KarnakDemo.wld" = ["d"]
            [cvars]
            sam_iMaxFPSActive = 60
            gfx_fBrightness = 0.5
            hud_bShowInfo = true
            plr_strName = "Sam"
            "#,
        )
        .unwrap();
        assert_eq!(c.startup.message.as_deref(), Some("hi"));
        assert_eq!(c.startup.commands, ["a", "b"]);
        assert_eq!(c.level.per_world["Levels/KarnakDemo.wld"], ["d"]);
        assert_eq!(c.cvars.len(), 4);
        assert!(c.cvars.contains(&("sam_iMaxFPSActive".into(), CvarValue::Int(60))));
        assert!(c.cvars.contains(&("hud_bShowInfo".into(), CvarValue::Bool(true))));
    }

    #[test]
    fn empty_is_default() {
        let c = ModConfig::parse("").unwrap();
        assert!(c.cvars.is_empty() && c.startup.commands.is_empty());
    }

    #[test]
    fn rejects_typos() {
        assert!(ModConfig::parse("[startupp]\nmessage = 'x'").is_err());
        assert!(ModConfig::parse("[cvars]\nx = [1, 2]").is_err());
    }
}
