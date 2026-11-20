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
  - Levels have no nav mesh, so `nav.rs` builds one by sampling the level with rays.
  - Each level's graph is baked ahead of time (`tools/navbake.mjs`, below) and shipped with the game
    data; a level without one gets a graph built around the player while it plays, spread over ticks.
  - The level's own `NavigationMarker` graph, built for monsters, could seed or check it later.
- **Hosting.** Bots exist only on the host of a network game. A solo player hosts a game on the
  virtual LAN as today (`?room=X&host=1`) and adds bots with `?bots=N`.

## Baked nav graphs and doors

`tools/navbake.mjs <url> <data dir> [--jobs N] [level.wld ...]` opens each level (all
`Levels/*.wld` when none are given) in headless Chrome with `?navbake=1`. The mod maps the level
in one go and writes it to the page's in-memory filesystem, and the tool copies it to
`<data dir>/Nav/Levels/<level>.nav`:

```bash
node tools/navbake.mjs http://127.0.0.1:8096/serioussam.html data/tfe-full-web
```

The next build packages the files with the rest of the data folder. At level start the mod loads
`Nav/<world>.nav` when it's there (`lib.rs` `load_baked_nav`, logged as `bots nav ready: N nodes,
D doors (baked)`), so bots are ready at once and the graph covers the whole level. Rebake after
changing how the graph is built: the file has a version byte (`SE1NAV` + 2), and a mod that reads
another version builds a graph live instead.

How the graph is built (`nav.rs`):
- **From seeds, not the whole box** (`NavBuilder::flood`). The graph spreads breadth first from
  the players and every item in the level (items are placed where a player can reach them). Only
  the columns next to a reached node are sampled, so the scenery around a level costs nothing.
  Hatshepsut's bounds are 4.8 × 2.9 km. Sampling all of them took 24.7 M rays and 11 minutes.
- **The start can be anywhere.** A level's intro may hold the player far from the level:
  Hatshepsut's is a closed 64 m box at the edge of the world. Seeded only at the player, the first
  bake was that box (1024 nodes). The item seeds fix that.
- **Doors** are brushes that move: doors, lifts, bridges, anything with `EPF_MOVABLE`. A closed
  door is solid to a normal ray, so a graph built while it's closed ends at the door. The bake uses
  `ray_door` (host API v10), which can pass doors: the engine hides each door it hits for the rest
  of that one ray and casts again. Every edge through a door, or touching a node that stands in one,
  remembers the door. Each door also keeps one probe ray, which the door blocks while it's closed.
- **Slopes players slide down** have no nodes: the floor ray reports whether the polygon hit is
  steeper than its surface type's climb slope (Standard 45°, "no step" 10°, the ices 5–15°).
- **A reach limit** (`NavParams::max_reach`, 80 m for bakes): nodes farther than that from every
  seed are kept but not spread from. Hatshepsut's desert bowl in front of the temple is walkable
  out to the mountains, 3.7 km², with nothing in it.
- **Seeds**: the humans, all items, and the monsters present at level start, except spawner
  templates (`m_bTemplate`, parked in hidden rooms; also no longer foes for the bots).
- **No floor inside a solid.** The engine's rays see no face of a solid they start inside. After
  hitting a ramp's top, the next ray down started inside the ramp and found the ground under it,
  and the 1.8 m clearance ray, all inside the ramp, saw nothing: 1600 nodes on Hatshepsut were
  inside its ramps and steps, and bots walked into them. A floor under an earlier surface now
  needs a ceiling: a ray up from it must hit the underside of that surface.
- **A tall step isn't a slope.** Rises of up to 45° between neighbours count as slopes, and the
  knee and chest rays can pass just over the corner of a step: the side of Hatshepsut's ramp,
  2.5 m, was linked as walkable. A rise of more than a step now needs the floor halfway between
  to be about halfway up (one more ray down).
- **Statues and pillars** (model holders that don't move: what blocks a player for good) stop the
  bake's walk rays; monsters and items don't. Live builds skip that: with Survivors' hundred
  monsters about, such a ray cost about 60 µs and a live build no longer finished in time.
- Result on Hatshepsut (2026-11-20): 14 002 nodes, 11 doors, 204 000 rays, baked in 9.3 s, 187 KB
  (format 3: a node is its height and one byte per edge, x/z come from its grid column). The
  first versions: 1024 nodes (the intro box), then 1.06 M nodes and 107 MB (the desert).
  A few small islands remain (the intro box and two closed rooms seeded by something in them).
- **While playing**, the runtime casts 8 door probes a tick, round-robin, and the bots' paths skip
  the doors that are closed right now (`NavGraph::path_gated`).

**Testing navigation:** `tools/navroamtest.mjs <url> [level] [seconds]` (full game data). With
`?botroam=N` the bots ignore the players and the monsters and roam to random points of the graph
up to N m away; each bot's status line counts `goals reached/given up` (a goal is given up after
max(15 s, N/2 s) or after being stuck three times). Hatshepsut, 4 bots, 60 m goals, 150 s: from
37% of goals reached to 93-95%, every bot over 100 m from its start, after these fixes:
- Paths were asked from the bot's eye, so the nearest node could be a ledge above its floor (a
  terrace edge 2.6 m up beat the floor under the bot). The runtime asks from the feet.
- Roam goals were any node in range, often on a roof or a floor below that can't be walked to.
  They are now in the bot's own strongly connected part of the graph (`NavGraph::comp`).
- A bot back from a fight threw its roam goal away and never got anywhere; it carries on now.
  A teleport (`keep_near_humans`) clears the route.

Limits:
- A door that opens when someone walks up to it looks closed until a human opens it, so bots won't
  plan through it on their own.
- A lift's platform counts as a door wherever the links pass through it, so bots treat the lift
  as closed.
- Teleporters aren't followed. A part of a level reached only by a teleporter is in the graph only
  if an item is there.

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
- Without a baked file the graph covers 150 m around the player at the time it's built, rebuilt
  when the player gets 105 m from its centre.
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
