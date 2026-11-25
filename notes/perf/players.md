# Perf track K: hundreds of players in one game

Branch `t3/8c450b0d`. The perf build is `tools/optbuild.sh` (build-opt), served with
`tools/perfsnap.py` on port 8232; the bench is `tools/perfbench.mjs` against the shared ref (8181)
and r1 (8192). Every engine change is guarded by `__EMSCRIPTEN__` (or only takes effect past the
original 16 players), so native builds and games of up to 16 players behave as before.

## Result

The web build now takes **256 players** (humans and bots) and **256 computers** in one game, and
255 bots plus the host play without faults. Upstream stopped at 16; past 16 the game hit, in order:
the 16-slot arrays, 2048-byte network messages (stall at ~80 players), and 1400-byte packets
(memory fault at ~138 players). Saved games and demos with up to 16 players keep the upstream
format byte for byte.

`perfbench --check --reps 3 --scenarios stress500,demo,bots15`, engine ms per frame (median of
three reps). ref can't run more than 15 bots, so `bots15` is the comparable bots scenario:

| scenario | ref | r1 | new | new vs ref |
|---|---|---|---|---|
| stress500 | 5.718 | 3.174 | 3.222 | 1.77x |
| demo | 0.329 | 0.311 | 0.314 | 1.05x |
| bots15 | 4.236 | 3.393 | 3.387 | 1.25x |

Check: `SAME simulation`, 384 ticks, ref final 7d4eb99b. new matches r1 (this branch's base)
within noise: nothing here changes the cost of a game of up to 16 players. The gain of this
track is what becomes possible past 16, measured below.

Functional tests (svtest, bottest, flowtest, mptest, and mptest with a 200-bot host to send
messages over 1400 B through the switch) were not run on this branch: the shared Chrome lock was
busy with other tracks for more than two hours. They are the first thing to run before merging.
What was checked: `--check` SAME (above), 255 bots joined with no exception in any worker
(`tools/crashcatch.mjs`), and `ser_iStatMismatch` 0 up to 256 players. The quicksave fix
(Player.es) came after the `--check` run. It only affects virtual players, and the demo has none.

## Measurements

### Engine cost per player (one browser, the host)

`botsN` scenario (new in perfbench): N server-side bots and 100 Survivors monsters around a
god-mode player, paced at 60 fps. Engine thread ms per frame (`Module.se1Perf`), one run each,
measured with se1d after the bots joined and settled:

| bots | ms/frame mean | p50 | p95 | fps | bots' AI per tick (mod) |
|---|---|---|---|---|---|
| 0 | 1.97 | 1.56 | 4.33 | 60 | - |
| 16 | 3.76 | 1.72 | 9.06 | 60 | (nav build) |
| 64 | 4.75 | 2.16 | 11.69 | 60 | (nav build) |
| 128 | 6.62 | 4.81 | 15.56 | 59.2 | 5.9 ms |
| 255 | 11.08 | 11.17 | 23.39 | 49.6 | 15.9 ms |

The frame cost includes the bots' own AI, which runs in the mod on the engine thread at each
20 Hz tick (`tick avg` in the mod's status line): 15.9 ms per tick at 255 bots is about 62 µs per
bot per tick, or 6.4 ms per frame at 50 fps, more than half of the 11.08 ms. Real human players
don't have that cost.

Profile (`perfbench --profile`, bots64, 7.6 ms per frame while profiled): 66% of engine time is
in the bots' tick, and almost all of it is ray casts. `CCastRay::Cast` takes 42% self time and
`TestBrushSector` 22%. Of that, the mod's nav-mesh build (`NavBuilder::step`, through
`host_ray_door`) takes 44% inclusive. The build runs once per level, spread over the first
seconds, which is why the 16 and 64 rows say "(nav build)". The bots' sensing rays (`host_ray`)
take 20%. The simulation itself (`ProcessGameStream`) is 17% and rendering 14%. The ray cost
belongs to track G (rays). A faster `CCastRay` speeds up both the nav build and per-bot sensing.
The network code doesn't show up in the profile at 64.

Not measured: a bots255 profile with steady-state play. The first one was 79% `write()`: one
quicksave for each bot that joined (fixed, see the limits). The rerun after the fix never got
the shared Chrome lock in two hours.

### Network messages (measured in the engine)

`ser_bNetStats=1` (new console variable, web build) builds the all-actions block of each tick
the upstream way too, for the server's own client (who gets their own time tags) and for a remote
client (who gets none), and stores its raw and packed sizes and the times in `ser_iStat*` and
`ser_fStat*`. It also decodes the new O(N) block (below) against the upstream one: `ser_iStatMismatch`
stayed 0 in every run.

One tick's `MSG_SEQ_ALLACTIONS` block, wrapped in `MSG_GAMESTREAMBLOCKS` as sent:

| players | raw (host) | packed (host) | raw (remote) | packed (remote) | packed per player |
|---|---|---|---|---|---|
| 1 | 24 B | 25 B | 24 B | 25 B | |
| 17 | 332 | 228 | 328 | 247 | 14.5 B |
| 65 | 1216 | 779 | 1180 | 676 | 10.4 B |
| 129 | 2244 | 1296 | 2236 | **1412** | 10.9 B |
| 256 | 4154 | 2225 | 4206 | 2379 | 9.3 B |

Raw per player is 16.4 B: the 8-byte time tag (zero for every player but the receiver's own) and
about 8 B of action (a bit per unchanged axis, 32 bits per changed one, the button prefix code).
LZ (`net_iCompression=1`) halves it, mostly by squeezing the zero tags.

Times per tick at 256 players (the engine timer here steps by ~5 µs, so these are coarse):
encoding every action the upstream way for one client 20-25 µs, copying the pre-encoded actions
for one client ~5 µs, packing one client's message 10-15 µs.

## Limits found, and what was done

| limit | where | what happened past it | done |
|---|---|---|---|
| 16 players | `NET_MAXGAMEPLAYERS` (Network.h) | no slot | 256 |
| 16 computers | `SERVER_CLIENTS` (CommunicationInterface.h) | no session | 256 |
| 15 bots | `MAX_BOTS` (runtime.rs), `se1Bots` (pre.js) | | 255 |
| saved game slot count | SessionState.cpp writes every slot | the save format would change for everyone | writes 16 slots unless a player past slot 15 is active, then up to the highest; reading takes any count up to 256 and refuses more |
| `GetMaxPlayers()` loops | Watcher, Player, Common (every monster's player scan) | 256-slot loops for every watcher | returns the slot high-water (at least 16, so exactly 16 as before for small games; a pure function of the active slots, so all machines agree) |
| 2048-byte messages | `MAX_NETWORKMESSAGE_SIZE` | "Message over-writing" at ~80-200 players, the stream stalls | 16384 |
| 1400-byte packets | `MAX_UDP_BLOCK_SIZE` (CPacket.h) | an unreliable message bigger than a packet is split, and the receiver reads each piece as a whole message: "Message over-reading", then a wasm out-of-bounds fault, at ~138 players (one tick's block packs to 1412 B at 129) | 16384 for unreliable messages in the web build; reliable messages and acks still go in 1400-byte pieces, so a game that never makes a big message sends exactly what it did |
| 4096-byte frames | NetLan.c, net.js (WebRTC), rust/se1-server | the bigger packets would be dropped | 16384 + 64 |
| 128 peers per room | rust/se1-server `MAX_PEERS` | "room is full" | 254 (a room is a /24: host .1, others .2-.254) |
| O(N²) all-actions encoding | `CServer::MakeAllActions` | every action bit-encoded once per client per tick: 65 536 encodings per tick at 256x256 | each action encoded once per tick, copied per client (exact, checked by `ser_iStatMismatch`) |
| chat masks | `MaskOfPlayersOnClient` (ULONG) | players 32+ can't be named as chat targets; chat to all still works | guarded (no out-of-range shift); not widened |
| pings | `MSG_INF_PINGS`: 1 bit per slot + 10 bits per player | 352 B per ping message at 256 | none needed |
| stream memory | `ser_iRememberBehind` = 3000 blocks per session | every session keeps 150 s of blocks: 3000 x 4.2 KB x 256 sessions = 3.2 GB, more than wasm's 4 GB can hold next to the game | not changed: see the architecture below |
| quicksave per join | Player.es (single player only) | every player joining a single-player game asks for a quicksave: 255 bots joining = 255 saves of the whole world, written to OPFS, still running well after the joins (79% of the bots255 profile was `write`) | a server-side virtual player (bot) no longer asks; a human joining still does |
| chat sender | `SessionState.cpp` `ProcessGameStreamBlock` (MSG_CHAT_OUT) | the sender loop shifted `1<<ipl` for every slot | stops at slot 31, like `MaskOfPlayersOnClient` |
| item pickup mask | `Item.es` `m_ulPickedMask` (32 bits, a saved property) | `1<<iPlayer` wraps in wasm (the shift count is taken mod 32), so player 32+n shares "picked already" with player n on items each player picks once (`MarkPickedBy`: weapons, ammo, armour, health in co-op). Deterministic: every machine computes the same | not changed: widening it changes the saved-game layout of every item. Matters only with more than 32 players in co-op |
| rendering mask | `Player.es` `_ulPlayerRenderingMask` (32 bits) | an item picked by player n looks picked to the viewer 32+n too | not changed: rendering only, not simulation |
| bot status line | runtime.rs, every 200 ticks | one ~30 KB console line at 255 bots | not changed |

Upstream code paths that loop over all 256 slots but only on events (connect, save, scoreboard,
`GetPlayersCount`) cost nothing measurable.

## Network model

20 ticks per second. The numbers are per 256-player game, using the measured 2.4 KB packed block
per tick (bots moving and fighting; human input changes more axes per tick and would be ~20-40%
bigger).

**Down, each client:** 2.4 KB x 20 = 48 KB/s = 0.38 Mbit/s, plus a few hundred bytes of pings.
Any broadband or 4G link carries it. It grows linearly: 16 players 5 KB/s, 64 players 14 KB/s.

**Up, each client:** its own actions (~20-60 B per message at the client's frame rate, with
`cli_iBufferActions` resends): 2-4 KB/s. Not a limit.

**Up, the host (the server is a browser):** the same 2.4 KB to each of the other N-1 clients,
48 KB/s x 255 = **12.2 MB/s = 98 Mbit/s** sustained. That is the binding limit of the current
design: a home uplink of 10-40 Mbit/s carries 25-100 players at most, and the browser's
JS pump (net.js copies bytes one by one between the ring and the socket) adds CPU per byte.

**The switch (rust/se1-server):** forwards every unicast frame: 98 Mbit/s in and 98 Mbit/s out
for one 256-player room, one thread per connection and a room mutex per frame. A small VPS has
about 1 Gbit/s: ~10 such rooms.

**Host CPU for the stream, per tick at 256 players:** upstream encode 255 x 22 µs = 5.6 ms (now
removed: one encode of all actions, ~25 µs, plus 255 copies x 5 µs = 1.3 ms) and packing
255 x 12 µs = 3 ms. `SendGameStreamBlocks` also re-packs the message for every block it adds
(up to 1000 bytes per message), so a client that is behind costs a few packs more. Together about
4.5 ms per tick = 90 ms per second of one core, on top of the simulation.

**Host memory:** `ser_iRememberBehind` (3000 blocks per session) at 256 sessions = 3.2 GB: it has
to come down (or be shared) before a real 256-human game.

**Each client's CPU:** lockstep means every client simulates every player and every monster, so
the per-client cost is the "engine cost per player" above minus the bots' AI. Interest management
can't drop far players from the simulation without breaking the identical-simulation contract;
it can only skip rendering them, which the visibility code already does.

## Recommended architecture

Keep lockstep. Every client already simulates everything, the protocol is tiny per player
(~9 B packed per tick), demos, saves and the `--check` oracle all depend on it, and the client CPU
for 256 players is affordable (above). What doesn't scale is the star around a browser host. In
steps, each one usable on its own:

1. **Done here: 256 slots, O(N) encoding, whole-message packets.** A browser host on a
   25 Mbit/s uplink carries about 64 humans: 64 players pack to 676 B per tick, 13.5 KB/s per
   client, x 63 = 0.85 MB/s = 6.8 Mbit/s up. At 128 humans it needs 128 x 28 KB/s = 3.6 MB/s =
   29 Mbit/s, and `ser_iRememberBehind` should come down to ~400 ticks (20 s) to keep the stream
   memory at 128 x 400 x 2.2 KB = 113 MB.

2. **One stream for everyone, fanned out by the switch** (1-2 weeks, a protocol change for web
   clients only). Make the all-actions block identical for every client: the owner's time tag
   (only used by the owner's prediction buffer, PlayerTarget.cpp) goes in a tiny per-client
   message instead (8 B x that client's players). The host packs one message per tick (~15 µs
   instead of 255 x 15 µs) and sends it once to the switch's broadcast address (the switch
   already forwards `dst == 255`); resends stay unicast. Host uplink at 256 players: 48 KB/s
   instead of 12 MB/s. Host memory: one block store, 3000 x 2.4 KB = 7 MB instead of 3.2 GB.
   Switch egress stays 98 Mbit/s per 256-player room, which is what a data-centre link is for;
   moving the switch to async I/O (one thread per connection today) is part of this step.

3. **The server off the player's machine** (days, mostly packaging): run the host as a headless
   browser (or the native DedicatedServer from `src/`) next to the switch, so no player pays the
   host's CPU (simulation + per-client sends, ~90 ms per second of one core at 256 now, ~5 ms
   after step 2) or uplink.

4. **Not recommended now: server-authoritative snapshots with interest management.** The server
   simulates, each client gets the entities near it (say 64 entities x ~16 B x 20 Hz = 20 KB/s)
   and runs no full simulation. It is the only way past "every client simulates every player and
   every monster", but it is a new netcode (SE1 has no per-entity delta serialization; its only
   state transfer is the full session state of hundreds of KB), it drops demo playback and the
   bit-identical check, and the measured client cost of 256 players doesn't call for it yet.
   Thousands of monsters are a CPU question for every client in lockstep: the monster tracks
   (collision F, rays/AI G, models H/I, threading L) decide that, not the network.

Interest management inside lockstep would only skip work that doesn't change the simulation:
rendering (already culled by visibility), sounds, and the HUD's player list.

## Files

- `src/SamTFE/Sources/Engine/Network/`: Network.h, CommunicationInterface.h, NetworkMessage.h,
  CPacket.h, ClientInterface.cpp, Server.cpp (O(N) encoding, `ser_bNetStats`), PlayerBuffer.*,
  PlayerTarget.cpp, SessionState.* (slot high-water, saved-game slot count), Network.cpp (cvars);
  `Engine/Entities/Entity.cpp` (`GetMaxPlayers`).
- `port/common/NetLan.c`, `port/web/net.js`, `rust/se1-server/src/main.rs`: frame size, peers.
- `rust/se1-mod/src/bots/runtime.rs`, `port/web/pre.js`: 255 bots.
- `tools/perfbench.mjs`: `botsN[mM]` scenario. `tools/crashcatch.mjs`: open a URL in headless
  Chrome and print uncaught exceptions from every worker with their stack.
