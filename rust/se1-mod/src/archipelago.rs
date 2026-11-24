//! Archipelago client (API v11, notes/archipelago.md).
//!
//! The page runs the Archipelago websocket; we relay it to the engine. Location checks come
//! from the engine (`se1mod_pickup`), received items from the page (`ap_items` messages on
//! `Module.se1ModInbox`). The item/location tables live in the APWorld data (tfe.toml),
//! embedded here so the mod and the world share one source of truth.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::json;

use crate::host::Host;

const DATA: &str = include_str!("../../../archipelago/serioussam_tfe/data/tfe.toml");

#[derive(Deserialize)]
#[allow(dead_code)] // fields kept: the table documents itself, and future item kinds will use them
struct Data {
    game: String,
    #[serde(default)]
    item: Vec<ItemDef>,
    #[serde(default)]
    location: Vec<LocDef>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ItemDef {
    id: i64,
    name: String,
    kind: String,
    wit: i32,
    weapon: i32,
    classification: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct LocDef {
    id: i64,
    name: String,
    world: String,
    entity: u32,
    kind: String,
    wit: i32,
}

pub struct Archipelago {
    data: Data,
    /// ?ap=…: take mapped pickups as checks; scan-only (?apscan=1 alone) just reports pickups
    active: bool,
    scan: bool,
    world: String,
    checked: HashSet<i64>,
    pending: Vec<i64>,
    received: Vec<i64>,
    /// re-apply the inventory when a new game starts (weapons are lost then)
    reapply: bool,
}

/// The AP `ReceivedItems` index semantics: given the length of the inventory we already have,
/// an `index`, and the message's item list, which part to apply.
/// `(replace, to_append)`: replace means the full inventory was resent (index 0).
fn new_items(received_len: usize, index: usize, items: &[i64]) -> Result<(bool, Vec<i64>), ()> {
    if index == 0 {
        // full inventory: replace and apply everything
        return Ok((true, items.to_vec()));
    }
    match index.cmp(&received_len) {
        std::cmp::Ordering::Less => {
            // overlap: the message re-sends some items we already have; apply the rest
            Ok((false, items[received_len - index..].to_vec()))
        }
        std::cmp::Ordering::Equal => Ok((false, items.to_vec())),
        std::cmp::Ordering::Greater => Err(()), // gap: ask the page for a full resync
    }
}

impl Archipelago {
    pub fn new(host: &Host, active: bool, scan: bool) -> Option<Self> {
        let data: Data = match toml::from_str(DATA) {
            Ok(d) => d,
            Err(e) => {
                host.log(&format!("ap: bad tfe.toml: {e}"));
                return None;
            }
        };
        host.log(&format!("ap: {} items, {} locations", data.item.len(), data.location.len()));
        Some(Self {
            data,
            active,
            scan,
            world: String::new(),
            checked: HashSet::new(),
            pending: Vec::new(),
            received: Vec::new(),
            reapply: true,
        })
    }

    pub fn level_started(&mut self, host: &Host, world: &str) {
        self.world = world.to_string();
        self.reapply = true;
        if self.scan {
            self.post_scan(host);
        }
    }

    /// Report every pickup of the level to the page (?apscan=1, tools/apscan): at level start,
    /// and again when the page asks (`ap_scan_now`), since the game-mode filter and triggered
    /// spawns change what is live after the first ticks.
    fn post_scan(&self, host: &Host) {
        let world = &self.world;
        let pickups = host.pickups(1024);
        host.log(&format!("ap: scan {world}: {} pickups", pickups.len()));
        let list = pickups
            .iter()
            .map(|(id, kt, pos)| json!({"id": id, "kind": (kt >> 8) & 255, "type": kt & 255, "visible": kt & 0x10000 != 0, "pos": pos.map(|v| (v * 100.0).round() / 100.0)})
            )
            .collect::<Vec<_>>();
        host.ui_post(&json!({"type": "ap_scan", "world": world, "pickups": list}).to_string());
    }

    /// The local player touched a pickup. Returns true to take it (a location check); the
    /// game then gives nothing, the item disappears.
    pub fn pickup(&mut self, host: &Host, id: u32, kind_type: i32) -> bool {
        if !self.active {
            return false;
        }
        let Some(loc) = self.data.location.iter().find(|l| l.world == self.world && l.entity == id) else {
            host.log(&format!("ap: unmapped pickup world={} id={} kind={} type={}", self.world, id, (kind_type >> 8) & 255, kind_type & 255));
            return false;
        };
        if self.checked.insert(loc.id) {
            self.pending.push(loc.id);
            host.log(&format!("ap: check {} {}", loc.id, loc.name));
        }
        true
    }

    pub fn frame(&mut self, host: &Host) {
        // a) page messages
        for _ in 0..64 {
            let Some(msg) = host.page_recv() else { break };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) else {
                host.log(&format!("ap: bad message: {msg}"));
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("ap_connected") => {
                    let n = v.get("checked")
                        .and_then(|c| c.as_array())
                        .map(|a| {
                            let n = a.len();
                            for c in a {
                                if let Some(id) = c.as_i64() {
                                    self.checked.insert(id);
                                }
                            }
                            n
                        })
                        .unwrap_or(0);
                    host.log(&format!("ap: connected, {n} locations already checked"));
                }
                Some("ap_scan_now") => self.post_scan(host),
                // diagnostics for tests: where the player is and the nearest pickups
                Some("ap_where") => {
                    if let Some((p, hp)) = host.player() {
                        let mut near: Vec<(f32, u32, i32)> = host.pickups(1024).into_iter()
                            .map(|(id, kt, q)| (((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) + (q[2] - p[2]).powi(2)).sqrt(), id, kt))
                            .collect();
                        near.sort_by(|a, b| a.0.total_cmp(&b.0));
                        let list: Vec<String> = near.iter().take(3).map(|(d, id, kt)| format!("{id}(kind {} type {}{}) at {d:.1} m", (kt >> 8) & 255, kt & 255, if kt & 0x10000 != 0 { "" } else { ", hidden" })).collect();
                        host.log(&format!("ap: player at [{:.1}, {:.1}, {:.1}] hp {hp:.0}; nearest {}", p[0], p[1], p[2], list.join(", ")));
                    } else {
                        host.log("ap: no player");
                    }
                }
                Some("ap_items") => {
                    let Some(index) = v.get("index").and_then(|i| i.as_u64()) else {
                        host.log("ap: ap_items without index");
                        continue;
                    };
                    let Some(items) = v.get("items").and_then(|i| i.as_array()) else {
                        host.log("ap: ap_items without items");
                        continue;
                    };
                    let ids: Vec<i64> = items.iter().filter_map(|i| i.get("item").and_then(|m| m.as_i64())).collect();
                    if index == 0 {
                        // full inventory: replace and apply everything (idempotent)
                        self.received = ids.clone();
                        for id in &ids {
                            self.apply_item(host, *id);
                        }
                    } else {
                        match new_items(self.received.len(), index as usize, &ids) {
                            Ok((_, to_append)) => {
                                self.received.extend(to_append.iter());
                                for id in &to_append {
                                    self.apply_item(host, *id);
                                }
                            }
                            Err(()) => host.ui_post(&json!({"type": "ap_sync"}).to_string()),
                        }
                    }
                }
                _ => {}
            }
        }
        // b) a new game lost the weapons: re-apply the inventory once the player exists
        if self.reapply && host.player().is_some() {
            self.reapply = false;
            for id in &self.received {
                self.apply_item(host, *id);
            }
        }
        // c) report location checks
        if !self.pending.is_empty() {
            let locs = std::mem::take(&mut self.pending);
            host.ui_post(&json!({"type": "ap_check", "locations": locs}).to_string());
        }
    }

    /// Give the player the item, if they don't have it yet (idempotent: a resync does not
    /// refill ammo).
    fn apply_item(&self, host: &Host, id: i64) {
        let Some(def) = self.data.item.iter().find(|i| i.id == id) else {
            host.log(&format!("ap: unknown item {id}"));
            return;
        };
        if def.kind == "weapon" {
            if host.weapons_owned() & (1 << (def.weapon - 1)) == 0 {
                host.give_weapon(def.wit);
                host.log(&format!("ap: received {}", def.name));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_parses() {
        let data: Data = toml::from_str(DATA).unwrap();
        assert_eq!(data.game, "Serious Sam TFE");
        assert!(!data.item.is_empty());
        assert!(!data.location.is_empty());
    }

    #[test]
    fn ids_are_unique() {
        let data: Data = toml::from_str(DATA).unwrap();
        let mut item_ids: HashSet<i64> = HashSet::new();
        for i in &data.item {
            assert!(item_ids.insert(i.id), "duplicate item id {}", i.id);
        }
        let mut loc_ids: HashSet<i64> = HashSet::new();
        for l in &data.location {
            assert!(loc_ids.insert(l.id), "duplicate location id {}", l.id);
        }
    }

    #[test]
    fn index_semantics() {
        // index 0: full inventory
        assert_eq!(new_items(3, 0, &[1, 2, 3, 4]).unwrap(), (true, vec![1, 2, 3, 4]));
        // index == len: plain append
        assert_eq!(new_items(3, 3, &[4, 5]).unwrap(), (false, vec![4, 5]));
        // index < len: overlap, apply only the new tail
        assert_eq!(new_items(3, 1, &[2, 3, 4, 5]).unwrap(), (false, vec![4, 5]));
        // index > len: gap
        assert!(new_items(3, 5, &[6]).is_err());
    }
}
