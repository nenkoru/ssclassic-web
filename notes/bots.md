# Bots and the war against Mental

The goal for multiplayer is a mass-scale PvE war against Mental. Picture Foxhole or Battlefront 2,
up to 128 players per level, and every level a mission:
- hold the lines;
- complete randomized side missions, as in Helldivers;
- the finale is the Ugh-Zan stand, humanity's last stand.

Later, a war map on top: players move between encounters (TFE, TSE, and maps inspired by the other
games) and push Mental back together until he is stopped.

Bots matter for all of it:
- they fill empty slots so a war works with few humans;
- they let one person playtest alone;
- later they hold positions and do objectives.

They are co-op soldiers, not deathmatch opponents.

## Architecture

```
engine (C++)                         Rust mod (rust/se1-mod/src/bots/)
 CServer::ServerLoop                  nav.rs    walkable graph from ray casts, A*, smoothing
   └ SE1Mod_BotTick (per tick)  ───►  brain.rs  state choice, aim model, steering, unstuck
       senses: ray casts, enemies,    mod.rs    one Brain per bot, Sense from the host,
       items, players                           Action → CPlayerAction
   ◄── actions into CPlayerBuffer
 other clients see normal players
```

- **Virtual players on the server.** Bots skip `CPlayerSource`, which allows only 4 local players
  (the human included) and is wired into the `MSG_ACTION` format. Instead a new
  `CServer::AddVirtualPlayer` does what `MSG_REQ_CONNECTPLAYER` does:
  - takes a free `CPlayerBuffer`;
  - activates it for the server's own client;
  - announces the player with `MSG_SEQ_ADDPLAYER`.

  A hook in `CServer::ServerLoop`, just before `MakeAllActions` (Server.cpp:752), then fills each
  bot's action for the tick. Every client applies it like a human's action.
- **Actions.** `CPlayerAction`:
  - Rotation is absolute: send the heading and pitch the bot wants, not a change.
  - Translation is (strafe +right, up +jump/−crouch, forward NEGATIVE).
  - Buttons are edge-triggered: FIRE 1, USE 32, weapon select `type << 9`, etc. (Entities/Player.es:255).
  - A dead bot respawns by releasing fire, then pressing it.
- **Senses.** These come from the same hook, so they match the server tick:
  - ray casts (`CCastRay`, physical) for line of sight and the nav graph;
  - enemies from `wo_cenEntities` (the AimAssist.cpp loop);
  - items (Se1ModEntities.cpp);
  - players' positions.
- **Navigation.**
  - Levels have no nav mesh, so `nav.rs` builds one by sampling the level with rays, spread over
    frames.
  - It is cached per world file (OPFS/IndexedDB) after the first build.
  - The level's own `NavigationMarker` graph, built for monsters, could seed or check it later.
- **Hosting.** Bots exist only on the host of a network game. A solo player hosts a game on the
  virtual LAN as today (`?room=X&host=1`) and adds bots with `?bots=N`.

## Phases

1. **Brain and navigation in pure Rust** (omp, in progress): behind traits, tested against
   synthetic worlds; acceptance tests in `rust/se1-mod/tests/bots_*_accept.rs`.
2. **Engine wiring** (after the threat-warning host API v7 lands, since both extend the host table):
   - host API v8: `bot_add(name)`, `bot_remove(id)`, a per-tick callback with senses and actions,
     `ray`, `world_bounds`, an enemy and item list;
   - `AddVirtualPlayer` and the `ServerLoop` hook.
   - Test: host a game with `?bots=2`. A second browser that joins sees two extra players that move,
     shoot monsters and follow the host.
3. **Navigation in real levels:**
   - build the graph in the background on level start, then cache it;
   - a debug overlay that draws the nodes and the current paths (`?botdebug=1`);
   - tune on Hatshepsut and the demo levels;
   - check: a bot reaches randomly chosen reachable points.
4. **Filling the server:**
   - bots fill the slots up to `?fill=N` and leave as humans join;
   - skill levels, names and skins.
5. **Beyond 16 players**, also needed by humans:
   - `NET_MAXGAMEPLAYERS` and `SERVER_CLIENTS` are 16;
   - the player index on the wire is 4 bits (16 players);
   - chat masks are 32-bit;
   - arrays across the engine are sized by these (listed in the scouting notes).

   Then interest management, so 128 players don't send every action to everyone.
6. **War mode:**
   - lines to hold: spawn waves, capture zones;
   - randomized side missions (destroy, escort, defend, retrieve);
   - bots take orders from the mission (hold here, push there);
   - the Ugh-Zan finale.
7. **The war map:** a persistent front on the server (`rust/se1-server`). Matches report results and
   the lobby becomes a map of fronts across TFE and TSE levels.

## Open questions

- Whether TFE levels have enough `NavigationMarker`s to be useful (count them at runtime).
- Whether the switch must be running for a solo host game (net.js waits for an IP).
- How much ray casting a big level's graph costs: a 2 m grid over 500×500 m is 62 500 columns.
  Measure it, then choose between building over frames and building once and caching.
