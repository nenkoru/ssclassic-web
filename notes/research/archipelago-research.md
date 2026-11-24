# Archipelago research: adding Serious Sam TFE


## 1. Network protocol

Source: https://github.com/ArchipelagoMW/Archipelago/blob/main/docs/network%20protocol.md (raw: https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

### Transport

- Transport is WebSocket. The client "establishes a WebSocket connection to Archipelago server". https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md
- Default server port is 38281: `MultiServer.py` declares `port: int = 38281`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/MultiServer.py
- Clients must handle both secure and unsecure websocket connections (ws:// and wss://): "Handle both secure and unsecure websocket connections". https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/adding%20games.md
- Packets are "simple JSON lists in which any number of ordered network commands can be sent", each command an object with a `"cmd"` key. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md
- "Websocket connections should support per-message compression. Uncompressed connections are deprecated". https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md
- Example frame: `[{"cmd": "RoomInfo", "version": {"major": 0, "minor": 1, "build": 3, "class": "Version"}, "tags": ["WebHost"], ... }]`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

### Handshake order

1. Client establishes WebSocket connection.
2. Server sends `RoomInfo`.
3. Client may send `GetDataPackage`.
4. Server sends `DataPackage` (only if client sent GetDataPackage).
5. Client sends `Connect`.
6. Server responds `Connected` or `ConnectionRefused`.
7. Server may send `ReceivedItems` for queued items.
8. Server sends `PrintJSON` to all players about the new connection.

If refused, the server keeps the connection open and allows a follow-up `Connect`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

### Packet fields (minimal examples)

**RoomInfo** (server→client): `version` (NetworkVersion), `generator_version`, `tags: list[str]`, `password: bool`, `permissions: dict` (keys "release"/"collect"/"remaining"), `hint_cost: int`, `location_check_points: int`, `games: list[str]`, `datapackage_checksums: dict[str,str]`, `seed_name: str`, `time: float`.
```json
{"cmd": "RoomInfo", "version": {"class": "Version", "major": 0, "minor": 6, "build": 1},
 "tags": [], "password": false, "games": ["Serious Sam TFE"],
 "datapackage_checksums": {"Serious Sam TFE": "abc"}, "seed_name": "x", "time": 1700000000.0}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**ConnectionRefused** (server→client): `errors: list[str]` with one of `InvalidSlot`, `InvalidGame`, `IncompatibleVersion`, `InvalidPassword`, `InvalidItemsHandling`.
```json
{"cmd": "ConnectionRefused", "errors": ["InvalidGame"]}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**Connect** (client→server): `password: str`, `game: str`, `name: str`, `uuid: str`, `version: NetworkVersion`, `items_handling: int`, `tags: list[str]`, `slot_data: bool`.
```json
{"cmd": "Connect", "game": "Serious Sam TFE", "name": "Meow", "uuid": "abc-123",
 "password": "", "version": {"class": "Version", "major": 0, "minor": 6, "build": 1},
 "items_handling": 3, "tags": [], "slot_data": true}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

`items_handling` bit flags: `0b001` get items from other worlds; `0b010` get items from your own world (requires 0b001); `0b100` get starting inventory (requires 0b001); `0b000` no ReceivedItems ever. Value `3` = other-world + own-world items. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

`NetworkVersion` is `{major, minor, build}`; a hand-built dict MUST add `"class": "Version"` or the server cannot compare versions. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**Connected** (server→client): `team: int`, `slot: int`, `players: list[NetworkPlayer]`, `missing_locations: list[int]`, `checked_locations: list[int]`, `slot_data: dict[str, any]` (absent if Connect.slot_data was false), `slot_info: dict[int, NetworkSlot]`, `hint_points: int`.
```json
{"cmd": "Connected", "team": 0, "slot": 1,
 "players": [{"team": 0, "slot": 1, "alias": "Meow", "name": "Meow"}],
 "missing_locations": [1, 2, 3], "checked_locations": [],
 "slot_data": {}, "slot_info": {"1": {"name": "Meow", "game": "Serious Sam TFE", "type": 1, "group_members": []}},
 "hint_points": 0}
```
`NetworkPlayer` = `{team, slot, alias, name}`. Team 0-based, slots 1-based per team; slot 0 = the server. `NetworkSlot` = `{name, game, type, group_members}`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**ReceivedItems** (server→client): `index: int` (next empty slot in the client's item list), `items: list[NetworkItem]`.
```json
{"cmd": "ReceivedItems", "index": 5,
 "items": [{"item": 101, "location": 201, "player": 2, "flags": 1}]}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**NetworkItem**: `{item: int, location: int, player: int, flags: int}`. `player` is the slot the item sits in. Flags: `0b001` progression, `0b010` especially useful, `0b100` trap. Item/location ids must be in ±2^53-1, with ≤ 0 reserved for Archipelago. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**LocationChecks** (client→server): `locations: list[int]`. Duplicates are fine.
```json
{"cmd": "LocationChecks", "locations": [101, 102]}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**LocationScouts** (client→server): `locations: list[int]`, `create_as_hint: int` (0 = plain scout; non-zero creates a persistent hint; 2 only broadcasts new hints). Server answers with `LocationInfo` containing `locations: list[NetworkItem]` — the items in the scouted locations. Fully-remote clients use this to learn what each location holds before the player picks it up.
```json
{"cmd": "LocationScouts", "locations": [101], "create_as_hint": 0}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**StatusUpdate** (client→server): `status: int`. `ClientStatus`: `CLIENT_UNKNOWN=0, CLIENT_CONNECTED=5, CLIENT_READY=10, CLIENT_PLAYING=20, CLIENT_GOAL=30`. The server sets `CLIENT_CONNECTED` automatically on first connection. Sending `CLIENT_GOAL` is how the player tells the server they completed their goal.
```json
{"cmd": "StatusUpdate", "status": 30}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**Sync** (client→server): no arguments; requests a full `ReceivedItems` resync.
```json
{"cmd": "Sync"}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**Bounce** (client→server) / **Bounced** (server→client): client sends `Bounce` with `teams`, `games`, `slots`, `tags` (all optional lists), `operator` ("or"/"and"/"legacy", default legacy), `data: dict`; server forwards `Bounced` with the same targeting fields plus `data`. DeathLink is a Bounce targeting the "DeathLink" tag with `data = {time: float, cause?: str, source: str}`.
```json
{"cmd": "Bounce", "tags": ["DeathLink"], "data": {"time": 1700000000.5, "cause": "Player died", "source": "Meow"}}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**PrintJSON** (server→client): `data: list[JSONMessagePart]` (each part `{type?, text?, color?, flags?, player?, hint_status?}`; `type` e.g. text/item_id/location_id/player_id/color), plus optional `type` (e.g. ItemSend, Join, Goal, Chat, Tutorial), `item`, `receiving`, `team`, `slot`, `message`, `tags`, `countdown`. Clients only need `data` to render text.
```json
{"cmd": "PrintJSON", "data": [{"text": "Meow joined the game"}]}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

**GetDataPackage** (client→server): `games: list[str]` — no auth required.
```json
{"cmd": "GetDataPackage", "games": ["Serious Sam TFE"]}
```
**DataPackage** (server→client): `data: {games: {<GameName>: {item_name_to_id: dict, location_name_to_id: dict, checksum: str}}}`. IDs ≤ 0 are reserved ("Archipelago" generic world: location -1 "Cheat Console", -2 "Server"); ids are only unique within a game's package.
```json
{"cmd": "DataPackage", "data": {"games": {"Serious Sam TFE": {"item_name_to_id": {"Shotgun": 1}, "location_name_to_id": {"Level 1 - Ammo": 100}, "checksum": "abc"}}}}
```
https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

## 2. How the server sends items

Source: https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md

- After connecting, the client receives all previously collected items for its slot in one `ReceivedItems` packet, including items from prior play sessions.
- Each item has an `index` = "the next empty slot in the list of items for the receiving client". The client must persist its "last processed item index" (savegame/local file) and compare on receipt.
- If `index` does not match the next expected index, the client should re-sync: send `Sync` then `LocationChecks` (its known checks). It may also accept the items to avoid gameplay interruption.
- If `index` is `0`, the client should accept the `items` list as its full inventory (abandon previous inventory).
- Which items arrive at all depends on `items_handling`: 0b001 = items from other worlds; 0b010 = items from your own world (in addition); 0b100 = starting inventory. With only 0b001, a non-remote-items game's own-world items are NOT sent (see also "Coop": "If the game in question is not a remote-items game, then any items that are placed within the same world will not be sent by the server").
- The client must be able to reward copies of any item any number of times (starting inventory, item links, admin commands, cheating), and to receive items sent while disconnected. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/adding%20games.md

## 3. Adding a game (APWorld)

Sources: https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/adding%20games.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/apworld%20specification.md

- A world is a Python package under `worlds/<name>/` with `__init__.py`, containing a `World` subclass (usually in `__init__.py`). https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/adding%20games.md
- Required `World` fields: unique `game` name; an instance of a `WebWorld` subclass (`web`); `item_name_to_id` and `location_name_to_id` dicts; `create_item(self, item: str) -> Item`; at least one Region (the "Origin Region", default name "Menu", configurable via `origin_region_name`); non-zero locations; items count equal to locations count; a completion condition set as `multiworld.completion_condition[player]`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/adding%20games.md
- `options_dataclass`: a dataclass subclass of `PerGameCommonOptions`, assigned to the World; option values then available as `self.options.<name>`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- Generation methods, called in this order: `stage_assert_generate(cls, multiworld)` (prerequisite files) → `generate_early(self)` (per player, before items/locations; options+RNG available) → `create_regions(self)` → `create_items(self)` (by its end ALL regions/locations/items must be in the MultiWorld; no adding/removing after) → `set_rules(self)` (access + item rules) → `connect_entrances(self)` (all entrances connected) → `generate_basic(self)` (non-logic randomization) → `pre_fill`/`fill_hook`/`post_fill` → `generate_output(self, output_directory)` → `fill_slot_data(self)` and `modify_multidata(self, multidata)` (modify server data). Instance methods may be followed by `stage_*` class methods run after all instances. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- `Item`/`Location` subclasses just set `game: str`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- `ItemClassification` values: `progression` (may be required for logic; must be progression if referenced in rules), `filler`, `useful`, `trap`, `skip_balancing`, `progression_skip_balancing`, `deprioritized`, `progression_deprioritized`, `progression_deprioritized_skip_balancing`. Location progress types: `DEFAULT`, `PRIORITY`, `EXCLUDED`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- IDs: world-specific ids MUST be 1..2^53-1; ≤ 0 reserved globally. Recommended 1..2^31-1. Names must be unique within the game and non-numeric. Items and locations can share IDs; ids can be reused across games. Skeleton example numbers ids via `enumerate(mygame_items, base_id)` with e.g. `base_id = 1234`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- Events: item+location pair with `id = None`, placed via `Location.place_locked_item()`; generation-only, never checked/received at runtime. Goal is NOT an event — it is signaled by `StatusUpdate`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md
- `.apworld` file format: a zip archive, all lower case, ending `.apworld`, containing a folder with the same name as the zip which holds the world's folder contents (e.g. `ror2.apworld` containing `ror2/__init__.py`). Package via the "Build APWorlds" launcher component (`Launcher.py "Build APWorlds" -- "Game Name"`, output to `build/apworlds`). https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/apworld%20specification.md
- `archipelago.json` manifest in the world folder/zip: required field `game`; optional `minimum_ap_version`, `maximum_ap_version` ("major.minor.build"), `world_version`, `authors`; zipped .apworlds also get `version`/`compatible_version` (APContainer scheme) added automatically by the build component. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/apworld%20specification.md
- Install location: APWorlds live in `worlds/` (source) or `<install dir>/lib/worlds/` (installed); when running from source, user worlds load from `custom_worlds/` (see `worlds/__init__.py`: `user_folder = user_path("worlds") if user_path() != local_path() else user_path("custom_worlds")`). https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/apworld%20specification.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/__init__.py
- The `game` name in `World.game` / `archipelago.json` must exactly match the `game` string the client sends in `Connect` (e.g. "DOOM 1993"); a mismatch yields `ConnectionRefused` with `InvalidGame`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/__init__.py
- Relative imports within the world (`from .options import ...`), absolute imports for AP core (`from worlds.AutoWorld import World`). World-specific pip deps go in `worlds/<world>/requirements.txt`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/world%20api.md

## 4. APDOOM / doom_1993 as a template

Sources: https://github.com/Daivuk/apdoom, https://github.com/ArchipelagoMW/Archipelago/tree/main/worlds/doom_1993

- `worlds/doom_1993/` contains `__init__.py`, `Items.py`, `Locations.py`, `Maps.py`, `Options.py`, `Regions.py`, `Rules.py`, `docs/` (directory listing via GitHub contents API). https://api.github.com/repos/ArchipelagoMW/Archipelago/contents/worlds/doom_1993
- `Items.py`/`Locations.py`/`Regions.py`/`Rules.py` are auto-generated by the `ap_gen_tool` from the WAD file: `ap_gen_tool DOOM.WAD worlds/doom_1993 src/archipelago`. https://raw.githubusercontent.com/Daivuk/apdoom/master/README.md

### Items (doom_1993/Items.py)

`item_table: Dict[int, ItemDict]` with fields `classification`, `count`, `name`, `doom_type` (engine pickup type; -1 = level-unlock item, -2 = level complete), `episode`, `map`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/Items.py

- Level unlocks ("Level X (EpY)") are progression items with `doom_type: -1`.
- Real examples with ids (items start at 350000):
  - `350000` "Hangar (E1M1)" — progression, level unlock
  - `350001` "Hangar (E1M1) - Computer area map" — filler
  - `350003` "Nuclear Plant (E1M2) - Red keycard" — progression
  - `350007` "Toxin Refinery (E1M3) - Blue keycard" — progression
  - `350100` "Shotgun" — progression
  - `350101` "Rocket launcher" — progression
  - `350102` "Plasma gun" — progression
  - `350103` "Chainsaw" — progression
  - `350104` "Chaingun" — progression
  - `350105` "BFG9000" — progression
  - `350107` "Armor" — filler; `350108` "Mega Armor" — filler
  - `350109` "Berserk" — filler; `350110` "Invulnerability" — filler
  - `350114` "Box of bullets" — filler; `350115` "Box of rockets" — filler; `350116` "Box of shotgun shells" — filler; `350117` "Energy cell pack" — filler
- Item name groups: `Ammos`, `Computer area maps`, `Keys`, `Levels`, `Powerups`, `Weapons`.
- Weapon/ammo/powerup items are global (not tied to a map); keys/maps are per-map with `episode`/`map` fields.

### Locations (doom_1993/Locations.py)

`location_table: Dict[int, LocationDict]` with `name`, `episode`, `map`, `index` (WAD thing index), `doom_type`, `region`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/Locations.py

- Locations are individual item pickups in each map, plus one "Exit" location per map (32 exits, ids 351321-351352).
- Real examples (locations start at 351000):
  - `351000` "Hangar (E1M1) - Mega Armor" (region "Hangar (E1M1) Main")
  - `351001` "Hangar (E1M1) - Armor"
  - `351002` "Hangar (E1M1) - Shotgun"
  - `351003` "Nuclear Plant (E1M2) - Chainsaw" (region "Nuclear Plant (E1M2) Red" — gated area)
  - `351006` "Nuclear Plant (E1M2) - Supercharge"
  - `351321` "Central Processing (E1M6) - Exit"
  - `351325` "Containment Area (E2M2) - Exit" (region "Containment Area (E2M2) Red Exit")
  - `351473` "Fear (E4M9) - Exit"
- Total: 474 locations (351000-351473).

### Regions and rules

- `Regions.py`: per-map sub-regions (e.g. "Hangar (E1M1) Main", "Nuclear Plant (E1M2) Red", "Toxin Refinery (E1M3) Blue/Yellow/Start"), each with `connects_to_hub` and `connections` (list of `{target, pro}`). A "Hub" region connects to every map's hub-connected region.
- `Rules.py`: entrance rules generated per episode. Level gating: `set_rule(multiworld.get_entrance("Hub -> Nuclear Plant (E1M2) Main", player), lambda state: state.has("Nuclear Plant (E1M2)", player, 1) and (state.has("Shotgun", player, 1) or state.has("Chaingun", player, 1)))` — entering a map requires the level-unlock item AND a weapon. Key gating: `set_rule(... "Nuclear Plant (E1M2) Main -> Nuclear Plant (E1M2) Red" ..., lambda state: state.has("Nuclear Plant (E1M2) - Red keycard", player, 1))`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/Rules.py
- `__init__.py`: `game = "DOOM 1993"`, `options_dataclass = DOOM1993Options`, `web = DOOM1993Web()`, `required_client_version = (0, 5, 0)`; maps `item_table`/`location_table` into `item_name_to_id`/`location_name_to_id`. `create_items` builds the pool (level unlocks + keys + maps per included episode, ratioed ammo/powerups) and appends to `multiworld.itempool`. `fill_slot_data` packs options (goal, difficulty, random_monsters, ..., episode1-4) into JSON for the client. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/__init__.py

### Options (doom_1993/Options.py)

`goal` (Choice: complete_all_levels / complete_boss_levels), `difficulty` (baby/easy/medium/hard/nightmare), `random_monsters`, `random_pickups`, `random_music`, `flip_levels`, `allow_death_logic` (Toggle), `pro` (Toggle — Pro Doom keyless maps), `start_with_computer_area_maps` (Toggle), `reset_level_on_death` (DefaultOnToggle), `episode1..4` (toggles for which episodes are included), `split_backpack`, `backpack_count`, `max_ammo_*` (Ranges), plus DeathLink/StartInventoryPool from AP core. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/worlds/doom_1993/Options.py

### APDOOM client (C++)

- APDOOM is a fork of crispy-doom (GPL-2+) with Archipelago integration in `src/archipelago/`: `apdoom.cpp`, `apdoom.h`, plus generated header files (`apdoom_def.h`, `apdoom_c_def.h`, `apdoom_def_types.h`, ...). https://github.com/Daivuk/apdoom
- It uses the APCpp C++ client library (https://github.com/N00byKing/APCpp). Setup calls: `AP_SetClientVersion`, `AP_SetDeathLinkSupported`, `AP_SetItemClearCallback(f_itemclr)`, `AP_SetItemRecvCallback(f_itemrecv)`, `AP_SetLocationCheckedCallback(f_locrecv)`, `AP_SetLocationInfoCallback(f_locinfo)`, then `AP_Start()`; the game blocks on `AP_GetConnectionStatus()` until `Authenticated`/`ConnectionRefused`/timeout (10s). https://raw.githubusercontent.com/Daivuk/apdoom/master/src/archipelago/apdoom.cpp
- `f_itemrecv(item_id, player_id, notify_player)` maps the item id to the generated `doom_type` table and mutates game state: backpack (doom_type 8) raises ammo capacity, keys set `level_state->keys[...]`, weapons set `weapon_owned[...]`, computer area maps reveal the map; level items (doom_type -1) unlock the level. https://raw.githubusercontent.com/Daivuk/apdoom/master/src/archipelago/apdoom.cpp
- `f_locrecv(loc_id)` (called when the player picks up a thing in-game) resolves the location id to (episode, map, WAD thing index), dedupes against already-checked locations, and records the check. APCpp's `AP_SendItem(location)` sends the `LocationChecks` packet: `req_t[0]["cmd"] = "LocationChecks"; req_t[0]["locations"] = [loc, ...]`. https://raw.githubusercontent.com/Daivuk/apdoom/master/src/archipelago/apdoom.cpp, https://raw.githubusercontent.com/N00byKing/APCpp/main/Archipelago.cpp
- On connect, APDOOM scouts progression item locations (`AP_SendLocationScouts`) to learn placement, and saves/loads per-level state (keys, weapons, checks) so reconnects resync; on win it (re)sends the victory status. https://raw.githubusercontent.com/Daivuk/apdoom/master/src/archipelago/apdoom.cpp

## 5. Running a local server for testing

Sources: https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/running%20from%20source.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/ModuleUpdate.py, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/Generate.py, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/MultiServer.py

- Supported Python: 3.12.10 or newer, < 3.14 (official: "3.12.10 through 3.13.x"); on Linux/macOS 3.12.0-3.13.x accepted by `ModuleUpdate.py`. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/running%20from%20source.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/ModuleUpdate.py
- Setup: clone the repo, run `python ModuleUpdate.py` (installs pinned deps from `requirements.txt`: websockets==13.1, PyYAML==6.0.3, etc.). https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/running%20from%20source.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/requirements.txt
- Generate: put player yaml files in the `Players/` folder (default `player_files_path`), then `python Generate.py` → produces the multiworld zip (plus spoiler) in the output path. `--multi N` generates N players from the weights file if fewer per-player yamls exist. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/running%20from%20source.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/Generate.py
- Host: `python MultiServer.py <path/to/multiworld.zip>`; default port 38281 (`port: int = 38281` in MultiServer.py); `--log_network` for debugging. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/running%20from%20source.md, https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/MultiServer.py
- The server DOES import world code: `MultiServer.py` does `import worlds` and iterates `worlds.AutoWorldRegister.world_types`. So a custom game's `.apworld`/folder must be present where the server runs (source tree `worlds/` or `custom_worlds/`); the multidata zip alone is not enough. https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/MultiServer.py

## 6. JS client options: archipelago.js

Sources: https://github.com/ThePhar/archipelago.js

- "A runtime-agnostic and zero dependency TypeScript/JavaScript library for communicating with Archipelago servers". https://raw.githubusercontent.com/ThePhar/archipelago.js/main/README.md
- Runs in browsers: "Targeted to work on all major desktop and mobile browsers (Firefox, Chromium, Safari) and server-side runtimes such as Node.js, Bun, and Deno". https://raw.githubusercontent.com/ThePhar/archipelago.js/main/README.md
- "Supports 100% of the Archipelago network protocol ... as of 2026-04-11 (0.6.7)" — i.e. connect/handshake, ReceivedItems events, LocationChecks, scouts, status updates, bounce, etc. https://raw.githubusercontent.com/ThePhar/archipelago.js/main/README.md
- License: MIT (Copyright 2024 Zach "Phar" Parks). Version on npm: 2.1.0 (`archipelago.js`, main `dist/index.js`, types `dist/index.d.ts`). Install: `npm install archipelago.js`. https://raw.githubusercontent.com/ThePhar/archipelago.js/main/LICENSE, https://raw.githubusercontent.com/ThePhar/archipelago.js/main/package.json
- API docs: https://thephar.github.io/archipelago.js/ ; intro: https://archipelago.js.org/stable/documents/Introduction.html. https://raw.githubusercontent.com/ThePhar/archipelago.js/main/README.md

## 7. Open questions

- Exact current Archipelago release version to target for `minimum_ap_version` / client `NetworkVersion` (docs reference 0.6.7 as of 2026-04-11, but the current tag wasn't fetched).
- Whether `MultiServer.py` can run with only the multidata + a stub world, or the world package must be importable and complete (source shows `import worlds`; a minimal importable world may suffice, unverified).
- APDOOM's exact ws:// vs wss:// URL handling and how the server host/port are configured in the launcher (checked apdoom.cpp; the launcher/C# side was not read).
- How the Doom world handles `starting inventory` options vs `episode1-4` toggles for the initial level state on the client side (slot_data carries episode flags; the client-side application path beyond `f_itemrecv` was not traced in full).
- Whether `items_handling` should include 0b100 (starting inventory) for a remote-items game like Serious Sam, or start inventory should be pushed locally by the client (Doom uses slot_data + episode toggles; no direct evidence either way for TFE).
