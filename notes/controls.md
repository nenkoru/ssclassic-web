# Controls

## Keyboard / Mouse

- W/A/S/D: move
- Mouse: look
- Left click: fire
- Right click: use
- Middle click: flip weapon
- Mouse wheel up: previous weapon
- Mouse wheel down: next weapon
- Space: jump
- C: duck
- Left Shift: walk (toggle)
- Caps Lock: walk (toggle)
- Home: center view
- 1-8: select weapon
- Escape: menu

## Touch (port/web/touch.js)

Enabled with `?touch=1` (or auto on coarse-pointer devices).

- Left half: move stick
- Right half: look drag
- Fire button: fire
- Jump button: jump
- Weapon button: next weapon
- Menu button: open menu

## Gamepad (port/web/gamepad.js)

Standard mapping (Xbox / PlayStation layout).

| Button | Action |
|--------|--------|
| Left stick | Move |
| Right stick | Look |
| A (0) | Jump |
| B (1) | Duck |
| X (2) | Use |
| Y (3) | Flip weapon |
| LB (4) | Previous weapon |
| RB (5) | Next weapon |
| LT (6) | Walk |
| RT (7) | Fire (analog: fires past 30% of the pull; every press lasts at least 60 ms) |
| Back/Select (8) | Cycle aim assist |
| Start (9) | Menu |
| Left stick click (10) | Walk toggle |
| Right stick click (11) | Center view |
| D-pad (12-15) | Move (in menus: navigate) |

In menus:

- D-pad / left stick: navigate
- A: confirm
- B: back
- Start: back

## Aim Assist

Levels: off (0), low (1), medium (2), high (3). Default: medium (2) when a pad or touch is in use.

| Level | Friction cone | Friction | Pull cone | Pull | Bigger hit zone |
|-------|--------------|----------|-----------|------|-----------------|
| Off | – | 1.0 | – | none | – |
| Low | 4° | 0.6 | – | none | +0.15 m |
| Medium | 6° | 0.5 | 6° | 25%/s while aiming | +0.30 m |
| High | 10° | 0.4 | 12° | 90%/s (near lock-on) | +0.50 m |

- Bigger hit zone ("bullet magnetism"): the player's bullets are thick rays that hit monsters
  within a radius of their path (0.1 m for most guns in co-op). Assist adds the amount above, so a
  shot that passes just beside a monster still hits it. Hooked in `CWorld::CastRay`
  (`WorldRayCasting.cpp`) for rays cast by the local player only; on a co-op host it helps the
  host's player, not the clients (their bullets are cast on the host).

- Friction: slows look deltas when aiming at a target within the friction cone.
- Pull: turns the view toward the target within the pull cone, removing the given share of the
  remaining angle per second (medium only while you are aiming with the stick; high always).
- Only gamepad and touch look are assisted, and only while one was used in the last 3 s: the mouse
  never is.
- Targets: live monsters within 60 m that you can see (walls block; monsters do not), the one
  closest to the crosshair; it is kept for 0.25 s before re-picking.
- Engine side: `port/common/AimAssist.cpp` (targeting, friction, pull), called from
  `CControls::CreateAction` (GameMP/Game.cpp) and `CInput::GetInput` (SDLInput.cpp).
- Target: nearest live enemy within 60m with clear line of sight. Sticky for 0.25s.

## URL Options

- `aimassist=<0-3>`: aim assist level (default 2)
- `padsens=<n>`: gamepad look sensitivity, mouse counts/sec at full deflection (default 900)
- `touch=<0-1>`: enable/disable touch controls
- `touchsens=<n>`: touch look sensitivity (default 3)
