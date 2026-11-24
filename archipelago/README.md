# Serious Sam TFE — Archipelago world

An [Archipelago](https://archipelago.gg/) world package for Serious Sam: The First Encounter,
for randomizing the web port's weapons and pickups. The item/location table is
`serioussam_tfe/data/tfe.toml`, shared with the game's Rust mod
(`rust/se1-mod/src/archipelago.rs`) — the single source of truth. Design: `notes/archipelago.md`.

## Layout

- `serioussam_tfe/` — the APWorld: `__init__.py` (world logic), `data.py` (toml loader).
- `players/Sam.yaml` — a ready-made player file for a local test game.
- `build_apworld.py` — packs the world into `dist/serioussam_tfe.apworld`.
- `dist/` — build output (gitignored).

## Build the .apworld

```sh
python3 archipelago/build_apworld.py
```

Produces `archipelago/dist/serioussam_tfe.apworld` (a zip with entries under `serioussam_tfe/`,
including `data/tfe.toml` and an `archipelago.json` manifest).

## Install into a local Archipelago checkout

Copy the .apworld into the Archipelago checkout's `custom_worlds/` folder (AP 0.6.9 loads
`*.apworld` files from there; `worlds/__init__.py` picks them up automatically):

```sh
cp archipelago/dist/serioussam_tfe.apworld /path/to/Archipelago/custom_worlds/
```

Rebuild the .apworld and copy it again whenever `serioussam_tfe/` changes.

## Generate and host a test game

From the Archipelago checkout:

```sh
cd /path/to/Archipelago
.venv/bin/python Generate.py \
  --player_files_path /path/to/serioussam-web/archipelago/players \
  --outputpath /path/to/serioussam-web/archipelago/dist/out \
  --seed 1
.venv/bin/python MultiServer.py --port 38281 /path/to/serioussam-web/archipelago/dist/out/AP_*.zip
```

Generation writes an `AP_<seed>.zip` plus spoiler; MultiServer hosts it on port 38281.
