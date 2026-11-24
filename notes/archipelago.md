# Serious Sam TFE as an Archipelago game

Roadmap: "Next: the multiverse", step 1. Background: `notes/multiverse-games.md`. Protocol and
APWorld research with sources: `notes/research/archipelago-research.md` (cited below as [R§n]).

Archipelago (AP) shuffles the "items" of many games into each other's "locations". A game joins by
shipping two halves: an **APWorld** (a Python package the generator and the server import, which
lists the items, the locations and the logic) and a **client** (the game itself, which reports
checked locations and applies received items over a WebSocket) [R§1, R§3]. APDOOM is the closest
model: a source port with a built-in client, locations = map pickups plus one exit per map,
items = weapons, keys, level unlocks and filler [R§4].

## Status

| Piece | State | Where |
|---|---|---|
| Item and location table (shared by the APWorld and the mod) | 🧪 8 weapons, 7 Hatshepsut weapon pickups | `archipelago/serioussam_tfe/data/tfe.toml` |
| APWorld `Serious Sam TFE` | 🧪 one region, goal = all locations | `archipelago/serioussam_tfe/` |
| Page client (WebSocket, handshake, checks, items, reconnect) | 🧪 | `port/web/archipelago.js` |
| Mod client (map pickups to checks, apply items) | 🧪 weapons only | `rust/se1-mod/src/archipelago.rs` |
| Engine hook: a weapon pickup can become a check | 🧪 | `WeaponItem.es` (`SE1_WITH_RUSTMOD`) |
| Test: check sent, item received, headless | 🧪 | `tools/aptest.mjs` |

URL options: `?ap=host:port` (connect; `ws://` added, or give a full `ws://`/`wss://` URL),
`slot=Sam`, `appass=`, `apscan=1` (log every pickup of each level as JSON: the tool for writing the
location table), `level=Levels/01_Hatshepsut.wld` (start in that level).

## Locations (what the player checks)

A location needs a stable id and a way to know it was done. Entity ids are read from the world
file (`WorldIO.cpp`), so an entity id names the same pickup in every session of the same level.
Location id = `5340000 + level * 1000 + n`.

| TFE thing | Location? | Detect | Notes |
|---|---|---|---|
| Weapon pickups | ✅ first | `WeaponItem.es` ItemCollected → `SE1Mod_Pickup` | done (slice) |
| Key pickups | ✅ | `KeyItem.es` ItemCollected, same hook | the key itself becomes an item (below) |
| Health / armor / ammo pickups | ✅ optional | `HealthItem.es`, `ArmorItem.es`, `AmmoItem.es`, same hook | many per level: an option, like APDOOM's `random_pickups`; big ones only (Super health, Strong armor, packs) by default |
| Secrets | ✅ | `Trigger.es:119` sends `ESecretFound` to the player; hook it there | ids = trigger entity ids |
| Level end | ✅ | `WorldLink.es:55` `ChangeLevel`; one "Exit" location per level, like APDOOM [R§4] | |
| Kill milestones (50 %, 100 %) | maybe | `m_psLevelStats.ps_iKills` / `m_psLevelTotal.ps_iKills` in `Player.es` | read per frame by the mod; no engine change |
| NETRICSA messages | maybe | `MessageItem.es` | cheap, many are on the main path |
| Precache rooms | ❌ | | each level has a hidden showcase room (Hatshepsut: entities 1400, 1401 at x≈2840) that the player never reaches; `apscan` shows them by position, leave them out |

Pickups are checks only when they are in the table: an unknown pickup behaves as in the
original game, so the table can grow level by level.

When a pickup is a check, the hook plays the pickup sound and removes the item without giving its
contents (`CItem::ItemReceived`). The player gets what the server sends back, maybe from another
game.

## Items (what the player receives)

Item id = `5330000 + WeaponItemType` for weapons; other kinds get their own hundreds.

| Item | Class | Apply | Hook |
|---|---|---|---|
| Weapons (Colt ... Cannon) | progression (shotguns, Tommygun, Minigun), useful (others) | `give_weapon` | exists (host API) |
| Per-level keys | progression | set the bit in the player's `m_ulKeys` | **missing**: `give_key` |
| Level unlocks ("Hatshepsut", "Sand Canyon", ...) | progression | the level's exit `WorldLink` only works when owned; the mod tells the player "locked" | **missing**: level gate |
| Health, armor, ammo packs | filler | `give_ammo`; health and armor by `spawn_item` at the player's feet | exists (`give_ammo`, `spawn_item`) |
| Serious Damage, Invulnerability, Serious Bomb | useful | power-up timer | **missing** |
| Traps (an enemy group spawns near the player) | trap | `spawn_enemy` | exists (Survivors) |

DeathLink (optional): on death the page sends a `Bounce` with the `DeathLink` tag; a received one
kills the player [R§1 Bounce].

Starting inventory: TFE gives the Knife and the Colt at the start of a level (`PlayerMarker.es`
`m_iGiveWeapons`). Keep that, so a level is never unplayable; weapons beyond it come only from AP.
Needs a hook so a later level's marker does not hand out its usual set (**missing**).

Logic, as in APDOOM [R§4]: the hub region connects to each level, entering a level needs its
unlock item and, past the first levels, a shotgun or better; key-gated parts of a level are
sub-regions behind the key. The goal is "finish level N" (`StatusUpdate` 30 from the page).

## Data flow

```
 AP server ──WebSocket── page (archipelago.js) ──Module.se1ModInbox──► mod (archipelago.rs)
                         ▲                                              │
                         └──────────── Module.se1ModUi(json) ◄──────────┘
 engine: WeaponItem.es ──SE1Mod_Pickup──► se1mod_pickup() in the mod (1 = take it as a check)
```

- **Page → mod.** The page pushes JSON strings on `Module.se1ModInbox`; the mod pops them each frame
  with the host call `page_recv` (host API v11). Messages: `ap_connected {slot, checked}`,
  `ap_items {index, items}` (AP's `ReceivedItems`, item ids only), `ap_scan_now`, `ap_where`.
- **Mod → page.** `ui_post(json)` (host API v4) reaches the page's `Module.se1ModUi`. Messages:
  `ap_check {locations}` (becomes `LocationChecks`), `ap_sync` (becomes `Sync`), `ap_scan`.
- **Engine → mod.** `se1mod_pickup(entity id, kind<<8|type, pos)`, called by the pickup hook for
  the local player only. The mod answers 1 when the pickup is a location in the table.
- **Mod → engine.** The existing host calls: `give_weapon`, `pickups` (v11: every pickup in the
  level, for the scan), `local_player`.
- The page owns the socket, the handshake (`RoomInfo` → `Connect` with `items_handling` 7, the
  version copied from `RoomInfo`), reconnects every 3 s, and queues checks until `Connected`.
- Received items: AP sends the whole list with index 0 on each connect and then appends [R§2]. The
  mod keeps the index of the next item it expects, applies each new item once, asks for `Sync` on a
  gap, and re-applies owned weapons after a level change (the engine resets weapons per level).
  Applying an item twice must be harmless (weapons: `give_weapon` on an owned weapon is a no-op).

Why the page and not the mod: the mod is wasm without sockets; the page already owns the network
(`net.js`), and AP's protocol is JSON, which is easier in JS. The mod keeps all game logic: what a
location is, and how an item is applied.

## Engine hooks still missing

All guarded by `SE1_WITH_RUSTMOD` (set for the `entities` target) and listed in
`notes/features.md` when they land.

1. **Other pickups as checks**: the same three lines as in `WeaponItem.es` in `KeyItem.es`,
   `HealthItem.es`, `ArmorItem.es`, `AmmoItem.es`, `PowerUpItem.es`. The helper
   `SE1ModTakesPickup` lives in each `.es` file's `%{ %}` block: Ecc cannot parse `#ifdef` inside a
   procedure.
2. **Secrets**: `Trigger.es:119`, report the trigger's id to the mod.
3. **Level end and level gates**: `WorldLink.es:55`, report the exit (a location) and ask the mod
   whether the next level is unlocked.
4. **`give_key`**: set a bit of `m_ulKeys` (`Player.es:953`) from the host API.
5. **Starting weapons**: let the mod replace `PlayerMarker.es` `m_iGiveWeapons` when AP is active.
6. **Save state**: the next-item index and the checked locations must survive a reload. AP resends
   both on connect (`Connected.checked_locations`, `ReceivedItems` from 0), so the first version
   keeps nothing; a saved game started before the items arrived would need them re-applied, which
   the re-apply after a level change already does.

## Running it

```
# once: the Archipelago source checkout with Python 3.12 (see archipelago/README.md)
python3 archipelago/build_apworld.py      # archipelago/dist/serioussam_tfe.apworld
cp archipelago/dist/serioussam_tfe.apworld ~/code/repos/Archipelago/custom_worlds/
cd ~/code/repos/Archipelago
.venv/bin/python Generate.py --player_files_path <repo>/archipelago/players --outputpath <out>
.venv/bin/python MultiServer.py --port 38281 <out>/AP_*.zip
# then open the game with ?ap=127.0.0.1:38281&slot=Sam
```

`tools/aptest.mjs` does all of it headless and checks the log.

## Open questions

- Game name: "Serious Sam TFE". The roadmap mentions an existing Serious Sam Fusion integration;
  check its game name before publishing so the two never collide.
- `minimum_ap_version`: we copy the server's version in `Connect`, which works with any server;
  pin the oldest one we test.
- Multiplayer (co-op in one slot): checks from any local player, items to all players? Not yet.
