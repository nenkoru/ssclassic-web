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

## How to use

`?bots=N` (0..15) puts N co-op bots on the host; `?botskill=0..1` sets their skill. Bots join
once a human is in the level, build a nav graph around the player (logged as
`se1mod: bots nav ready`), fight nearby monsters and follow the nearest human.
Test: `tools/bottest.mjs <url> [outdir]` (wired into `tools/test.sh` as the "bots" step).

Behaviour worth knowing (2026-11-20):
- Bots join on the first tick a human exists and are put 3 m from it, 120° apart. When the human
  is teleported (Survivors moves the player into its arena) they follow at once; a bot more than
  40 m from every human for 10 s, not fighting, is brought back.
- A level's intro holds a player that joins after it (auto-actions, or a camera): the runtime asks
  the engine to let go (`bot_release`; a camera is skipped with USE).
- They stay within 20 m of the leader (fighting only what is within 8 m beyond that) and shoot
  while they follow.
- The view is steered by the angles the bot commanded, not by its state: the engine shows an
  action a few ticks late, more with many bots, and steering by the late value swung the view to
  the pitch limit (bots looking at the sky).
- The host's own controls lagged by seconds while many players moved (fixed 2026-11-20): the engine
  paced the server's in-process loopback to its own client at `cli_iMaxBPS` (4000 B/s by default,
  a modem preset), and 16 moving players' actions outgrow that, so a queue built up while they
  moved and drained when they stopped. Client 0 is now unpaced (Server.cpp `HandleAllForAClient`).
  Measured with 15 bots, time the player keeps moving after the keys are let go: 7.4 s before,
  0.2 s after. Remote clients still get their connection preset (a `?room=` game uses 5mb-Fiber,
  457 000 B/s).
- Cost per server tick, 15 bots on Hatshepsut: about 4 ms on average, about 11 ms at worst
  (status line: `tick avg`). Path searches are capped at 2 a tick for all bots, sight rays at the
  2 nearest foes per bot every other tick, the graph at 400 rays or 4 ms a tick.

Known limits (2026-11-20):
- The graph covers 150 m around the player at the time it's built, and isn't refreshed. Doors are
  solid to the rays, so the graph depends on which doors are open: on the KarnakDemo Survivors
  arena it came out at 116 or 2593 nodes in different runs. Phase 3 refreshes it.
- In single player all players start on the same marker, so the bots spawn on the player's spot
  and spread out once they move.
- Sight checks hit level geometry only (not monsters or players), so a bot can shoot through
  another monster at its target.

## Phases

1. **Brain and navigation in pure Rust** (omp, done): behind traits, tested against
   synthetic worlds; acceptance tests in `rust/se1-mod/tests/bots_*_accept.rs`.
2. **Engine wiring** (landed):
   - host API v8: `bot_add(name)`, `bot_remove(id)`, a per-tick callback with senses and actions,
     `ray`, `world_bounds`, an enemy and item list;
   - `AddVirtualPlayer` and the `ServerLoop` hook;
   - the runtime (`rust/se1-mod/src/bots/runtime.rs`) driving the bots on the server tick,
     tested by `tools/bottest.mjs` (`?bots=2`: join, move, fight, nav graph, human unaffected).
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

## War mode design ideas (from the user, 2026-11-20)

- **The Game Master.** Like Helldivers' game master, the user sometimes joins Mental's side to
  break humanity's last stand.
  - The GM's page gets a free camera and a threat budget.
  - With the budget the GM spends on waves, places bosses and picks where the horde hits.
  - Later the GM can take direct control of a monster, a boss included.
  - The Survivors director (`rust/se1-mod/src/survivors`) already spawns and steers hordes. The GM is
    a human driving that director through the mod's UI channel, on the host.
- **Players depend on each other.** Roles:
  - a medic heals;
  - crewed weapons need two players, e.g. a heavy minigun one fires while another feeds it, or a
    rocket team with a loader;
  - builders put down sentries and walls, as in Orcs Must Die.

  The Survivors upgrade system is a start for role stats and abilities.
- **Building.**
  - Sentries can be mod-driven: an entity that aims and fires projectiles with the existing host
    `projectile` call.
  - Walls are the hard part. They need spawnable solid geometry with collision: a model entity
    with a collision box, or movable brushes. That is engine work, to scout first.
  - Bots then need the nav graph to update when walls appear: mark the blocked nodes, no full
    rebuild.
- **Player count.** Up to 128, "possibly unlimited". One Serious Engine game can't be unlimited:
  every client simulates the whole world and the server sends every player's actions to everyone,
  so cost grows with players × players. Beyond about 128, the war has to be many parallel matches
  (fronts, sectors) feeding one shared war state (phase 7). Massive at the war level, bounded per
  match.

## Open questions

- Whether TFE levels have enough `NavigationMarker`s to be useful (count them at runtime).
- Whether the switch must be running for a solo host game (net.js waits for an IP).
- How much ray casting a big level's graph costs: a 2 m grid over 500×500 m is 62 500 columns.
  Measure it, then choose between building over frames and building once and caching.
