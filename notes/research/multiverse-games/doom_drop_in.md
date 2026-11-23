# Doom drop-in co-op for a Serious Sam browser portal (as of 2026-11-24)

Scope: which Doom source ports let a player join a co-op match already in progress, which ones run (or could run) in a browser, and what an adapter needs to report match state and spawn a joiner. Research budget: about 22 web calls. The GitHub REST API was rate-limited (HTTP 403 "API rate limit exceeded") and `gh` is not installed, so star counts come from fetched repo pages, not the API. doomwiki.org and wiki.zandronum.com returned HTTP 403 to the fetcher, so their pages could not be read directly.

## Q1. Client-server ports with join-in-progress co-op: netcode, licenses, activity

### Takeaway
Only the client-server ports (Odamex, Zandronum, and ZDaemon from memory) can take a new player mid-map. The lockstep ports (Chocolate, Crispy, PrBoom+/dsda, and GZDoom/UZDoom peer-to-peer) cannot. Odamex is the best fit: it is GPL-2.0, active in 2026, and has a co-op game type, rcon and ACS. Zandronum is GPL-compatible in its own code but bundles non-commercial pieces, and UZDoom is GPLv3. Neither can be linked into a GPL-2.0-only binary.

### Cited Findings
**Odamex**
- The repo describes Odamex as an "Online Multiplayer Doom port with a strong focus on the original gameplay". It is "released under the GNU General Public License v2", with 310 stars and 77 forks on the fetched page. Its features list "a Cooperative mode" and "Support for Horde, Survival, Last Man Standing…", plus DM, TDM, CTF and Attack & Defend. — [github.com/odamex/odamex](https://github.com/odamex/odamex)
- Odamex is a modification of DOOM that lets players compete over the Internet with a client/server architecture. — [GitHub repo (search summary)](https://github.com/odamex/odamex)
- Recent releases listed on the GitHub releases page: 12.3.0 (06 Aug), 12.2.1 (27 Jun), 12.2.0 (18 Apr), 12.1.0 (05 Jan), 12.0.0 "The DSDHacked Update" (26 Dec). The page shows no years. GitHub normally omits the year only for the current year, so 12.x most likely shipped between late 2025 and August 2026, but this is unconfirmed. — [odamex releases](https://github.com/odamex/odamex/releases)
- 12.3.0 adds a clientside freecam for net demos and survival modes, which players can use once they are out of lives. It also adds a `g_horde_cooldown` cvar and new ACS features: "client-side scripts and several new ACS functions". The notes do not mention Lua. — [odamex releases](https://github.com/odamex/odamex/releases)
- Gentoo packages odamex-12.2.1 and describes it as an "Online multiplayer free software engine for DOOM". — [Gentoo ebuild](https://ftp.fau.de/gentoo-portage/games-engines/odamex/odamex-12.2.1.ebuild)
- `sv_gametype` is latched and takes effect only after a map change. The values are 0 = Cooperative, 1 = DM, 2 = TDM, 3 = CTF. — [odamex.net wiki (search summary)](https://odamex.net/wiki/Sv_freelook); [sample odasrv.cfg](https://slackware.uk/sbo/15.0/games/odamex/odasrv.cfg)
- The sample server config describes max players as "Maximum players that can join the game, the rest are spectators". — [odasrv.cfg](https://slackware.uk/sbo/15.0/games/odamex/odasrv.cfg)
- A Doomworld post says that on a full server, joining "will now put you in a queue that will let you join the game at the next opportunity". This is a forum source. — [Doomworld post](https://www.doomworld.com/forum/post/2278595)

**Zandronum**
- The latest version is 3.2.1, released 2025-08-05 according to the download page and forum announcement. DoomWiki says 2025-08-04. — [zandronum.com/download](https://zandronum.com/download); [forum announcement](https://zandronum.com/forum/viewtopic.php?p=119195)
- License (via search summary of the official wiki page, which returned 403 when fetched): new Zandronum code uses a license based on the Sleepycat License plus the BSD "No Endorsement" clause. The wiki says the ZDoom/GZDoom bases include code with "varied licensing schemes", some of it non-commercial only. It says the GPL "is normally incompatible with any non-commercial license (such as the FMOD and Build ones)", and that FraggleScript is used under special permission. — [wiki.zandronum.com/License](https://wiki.zandronum.com/License) (search snippet only)
- A "GPL-compliant fork" named ZandroX appeared in search results, but its GitHub repo states "This repository is empty". — [github.com/rc4l/ZandroX](https://github.com/rc4l/ZandroX)
- In Survival co-op, joining mid-game is blocked: "All players must wait until the map is over, or all players die, to join". A developer says `sv_maxlives` takes effect only at round start. — [zandronum forum](https://zandronum.com/forum/viewtopic.php?p=116225); [tracker 1664](https://zandronum.com/tracker/view.php?id=1664)
- Mods work around this. "notsurvival" lets a spectator in each time a set number of monster kills (50 by default) or minutes is reached. "Reinforcements" puts spectators ahead of dead players in the join queue. ACS has `SkipJoinQueue`, which forces queued spectators into the game "outside of normal game mode rules", and `GetPlayerJoinQueuePosition`. — [Reinforcements thread](https://zandronum.com/forum/viewtopic.php?p=118806); [moddb Reinforcements](https://www.moddb.com/mods/reinforcements); [tracker](https://zandronum.com/tracker/view.php?id=2941)

**GZDoom / UZDoom**
- GZDoom has had no release since 4.14.2 (May 2025). Its developers forked it as UZDoom in October 2025. — [search summary citing skulltag.com](https://www.skulltag.com/doom/source-ports/gzdoom/)
- UZDoom is licensed GPLv3: a web port says "GPLv3 (inherited from UZDoom)". An earlier sibling note recorded UZDoom at 2,357 stars, last pushed 2026-11-22. — [abootnet/uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm); see also `popular_rewrites.md` in this folder
- A ZDoom forum thread says that in peer-to-peer ZDoom, newly connecting machines "will be completely unaware of what kind of state the level is in", which makes mid-game joining "inherently impossible". — [forum.zdoom.org](https://forum.zdoom.org/viewtopic.php?p=634755)

**Chocolate / Crispy (lockstep)**
- In the original protocol, "the game only advances when everyone receives the commands from all the other players". Cloudflare's port keeps that protocol and replaces only the transport. — [Cloudflare blog, 2021-05-18](https://blog.cloudflare.com/doom-multiplayer-workers/)
- Crispy Doom and the Doom-derived ports are "released under the GPL-2+". — [Daivuk/apdoom README](https://github.com/Daivuk/apdoom)

### Inferences
- Odamex is the only candidate that is GPL-2.0, client-server, co-op capable, and actively released in 2025–2026. GPL-2.0 (most Odamex files are likely "or later") can be combined with GPL-2.0-only Serious Engine code. Even so, running Doom as a separate wasm module talking over a socket keeps the two as separate programs (mere aggregation), so the license question goes away either way.
- In plain (non-survival) co-op, client-server ports send the full world state when a client connects, so a joiner spawns at a co-op start mid-map. This is how Odamex and Zandronum co-op servers behave in practice, but I found no official page that states it outright (see Gaps).
- Zandronum's non-commercial components (and the empty ZandroX) make it a poor choice for a public GPL-2.0-only deployment. UZDoom's GPLv3 cannot be linked into GPL-2.0-only code, though it can run as a separate program.
- Lockstep ports (Chocolate, Crispy, PrBoom+/dsda, vanilla) would need a new netcode to support drop-in.

### Gaps
- ZDaemon: no source fetched this session. It is commonly described as closed-source/freeware, which is unverified here, and that would rule it out.
- Doomseeker is a server browser, not a port. Its license and status were not checked.
- Eternity: its netcode status (client-server work) was not checked.
- SRB2 (GPL-2.0, client-server, supports joining mid-game) was not verified this session.
- PrBoom+/dsda-doom 2026 network status was not checked. An earlier note records dsda-doom last pushed 2026-11-23.
- Neither the Odamex nor the Zandronum wiki was readable (403), so explicit documentation of co-op join-in-progress is missing.

## Q2. Browser builds and their networking

### Takeaway
No client-server Doom port has a browser build. The existing web multiplayer Dooms are cloudflare/doom-wasm (Chocolate Doom lockstep over a WebSocket relay, up to 4 players, joining only before start) and doom-room, a 2026 "ghost" design with no shared world state. That design allows mid-match joins precisely because it gives up real co-op. The GZDoom-family wasm ports run single-player only, and the upstream UZDoom browser PR was closed.

### Cited Findings
- **cloudflare/doom-wasm** is GPL-2.0, with 421 stars and 97 forks on the fetched page. It is Chocolate Doom "with WebSockets support" via `src/net_websockets.c`, uses shareware `doom1.wad`, and builds with Emscripten + SDL2 (sdl2_net). — [github.com/cloudflare/doom-wasm](https://github.com/cloudflare/doom-wasm)
- The network module was rewritten "to use TCP and WebSockets instead of UDP". A Worker hands each WebSocket to a per-room Durable Object (`newUniqueId()`), which relays packets. Each packet carries 4-byte little-endian fake "To"/"From" addresses, and each client picks a random 32-bit fake IP. Up to four players are supported. Players join by permalink and wait for the host to start. Published 2021-05-18. — [Cloudflare blog](https://blog.cloudflare.com/doom-multiplayer-workers/)
- **kbrianps/doom-room** (2026, GPL-2.0, 1 star) uses doomgeneric compiled with clang/WASI, "no Emscripten", into a ~740 KB wasm. Multiplayer runs over a Claude artifact `room` presence channel at about 30 Hz. Each tab runs its own single-player world and others appear as "ghosts", with shooters deciding hits. Kill counts are shared, so "a player who joins mid-match sees the right scoreboard". It uses FreeDM MAP01. Doors, lifts, switches and items are not synced. — [github.com/kbrianps/doom-room](https://github.com/kbrianps/doom-room)
- **AndrewTKent/doom-lobby** (2026-03): "Instant multiplayer DOOM via Cloudflare Workers". It was not examined further. — [GitHub search API result](https://github.com/AndrewTKent/doom-lobby)
- **abootnet/uzdoom-wasm** is GPLv3 with 9 stars. It uses WebGL2 via the unmodified GLES backend, pthreads via Web Workers + SharedArrayBuffer (COOP/COEP required), and IndexedDB saves. It "Ships with Freedoom" and says "vanilla Freedoom is fully playable". Multiplayer is not mentioned. — [github.com/abootnet/uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm)
- **mungus43/tomb-engine** is GZDoom 4.11.3 in a Web Worker with OffscreenCanvas, WebGL2 and JSPI instead of Asyncify. **marbiks/GZDOOM-portable** bundles GZDoom 4.11.3/4.14.2 and UZDoom 4.14.3, and needs Chromium 137+ with JSPI. — [tomb-engine](https://github.com/mungus43/tomb-engine); [GZDOOM-portable](https://github.com/marbiks/GZDOOM-portable) (search summaries)
- **UZDoom PR #848 "Browser platform support"** was opened 2026-01-02 and closed unmerged 2026-11-07. It was a wasm32 single-threaded proof of concept with Asyncify, then JSPI, and a separate `shaders_webgl` tree. "Network." was listed as a TODO, and on WebRTC the author said "Network support will be added in the future". A maintainer closed it, saying "we cannot accept this code" and citing an LLM-involvement policy and shader maintenance. — [UZDoom PR #848](https://github.com/UZDoom/UZDoom/pull/848)
- A web search found no Odamex WebAssembly or browser build. — [search; odamex repo](https://github.com/odamex/odamex)
- The search also found no Zandronum browser port. — [search summary](https://github.com/abootnet/uzdoom-wasm)

### Inferences
- doom-room's ghost model is the cheapest way to "drop in" from Serious Sam, but the joiner could not open doors or kill monsters in the host's world, so they could not actually help struggling players. Real help needs a server-authoritative port (Odamex).
- The Cloudflare relay pattern (WebSocket envelope with fake addresses, one relay object per room) carries over directly to an Odamex port: its UDP datagrams would be wrapped the same way.

### Gaps
- dsda-doom web builds, js-dos/DOS.Zone Doom multiplayer (IPX over WebSocket), and wasm-doom were not checked this session.
- The doom-lobby internals were not read.

## Q3. What porting a client-server Doom port to Emscripten would take

### Takeaway
For Odamex: replace the UDP socket layer with a WebSocket (or WebRTC DataChannel) transport plus a relay or a native server bridge, use its software renderer through SDL2 for the client, keep the dedicated server native (or as a headless wasm), and handle the main loop with Asyncify or JSPI. The GZDoom-family ports show that the rendering and audio problems are already solved. Networking is the part nobody has done.

### Cited Findings
- Chocolate Doom needed a new network module (`net_websockets.c`) to swap UDP for TCP/WebSockets, plus a relay. — [Cloudflare blog](https://blog.cloudflare.com/doom-multiplayer-workers/)
- The UZDoom browser work had to handle Asyncify vs JSPI, a WebGL shader variant (`#version 300 es` vs desktop 330), persistence of the Emscripten FS, and the limits of Emscripten's OpenAL (loop points and stereo 3D sounds depend on OpenAL Soft). Maintainers wanted a 64-bit wasm before merging. — [UZDoom PR #848](https://github.com/UZDoom/UZDoom/pull/848)
- Threaded wasm needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without them, "pthreads will refuse to spin up". Iframes need `allow="cross-origin-isolated"`. The asmjit JIT is x86_64-only, so it is turned off. — [uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm)

### Inferences
- The Serious Sam web build already runs threaded wasm with COOP/COEP, so an embedded Doom iframe or worker on the same origin fits the existing headers.
- The Odamex client uses SDL2 with a software renderer (I have not verified that it still offers an SDL2 software path in 12.x). That is the easiest route to Emscripten, like Chocolate Doom: no WebGL shader work.
- Server side: keep `odasrv` native on a host, and add a small WebSocket↔UDP bridge per server. That avoids porting the server and keeps rcon/log access native.

### Gaps
- No primary source on Odamex's internal network abstraction (its `i_net` layer) or renderer status was read.

## Q4. Scripting, hooks, RCON and logs for state reporting and spawning

### Takeaway
Odamex gives you rcon (password-protected console commands and cvars from a client or tool), ACS (extended in 12.3.0, including client-side scripts) and a co-op game type. Zandronum adds ACS join-queue control. Spawning a joiner at a chosen spot would be done with an ACS ENTER script, or with a small C++ patch in the server, since none of these ports has Lua or ZScript multiplayer hooks.

### Cited Findings
- The Odamex rcon password lets a client "connect to and control a server through their console", executing commands and changing cvars. It is separate from the join password. — [odamex.net wiki, How to run a server](https://odamex.net/wiki/How_to_run_a_server); [Basic Server Settings](https://odamex.net/wiki/Sv_upnp)
- Odamex 12.3.0 adds ACS features, including client-side scripts and new functions. Lua is not mentioned. — [odamex releases](https://github.com/odamex/odamex/releases)
- Zandronum ACS has `SkipJoinQueue` and `GetPlayerJoinQueuePosition`. — [zandronum tracker](https://zandronum.com/tracker/view.php?id=2941)
- One forum user who set the rcon password and a spectator setinfo still got "connect: failed". The thread shows no resolution. — [DOS Game Club forum](https://www.dosgameclub.com/forums/reply/9665/)

### Inferences
- Reporting: a sidecar that tails `odasrv` stdout or its log and polls rcon (`players`/status-style commands) could report players and map. Per-player health and deaths would likely need ACS (`PlayerHealth`-style functions writing to the log via `Log`/`Print`) or a server patch.
- Spawning at a chosen place: an ACS ENTER script that teleports the activator to a tagged map spot (`SetActorPosition`/`TeleportOther`-style functions) driven by a server cvar the adapter sets through rcon. I did not verify which of these ACS functions Odamex implements.

### Gaps
- The exact Odamex rcon command list, server log format, and ACS function coverage were not retrieved. The odamex.net wiki pages were reached only through search snippets.
- Zandronum's RCON protocol (Huffman-compressed UDP) and log format were not retrieved this session.

## Q5. Freedoom

### Takeaway
Freedoom is BSD-licensed, so it can be hosted publicly. It ships two campaigns plus FreeDM, and a GZDoom-family web port already reports vanilla Freedoom fully playable. Co-op starts, version and compatibility details were not confirmed this session.

### Cited Findings
- Freedoom is "liberally licensed under the BSD license". Reuse requires keeping the copyright notice and crediting the project. It is "three entire games, with two single-player campaigns and one collection of multiplayer deathmatch arenas (FreeDM)", and is "just the content of a game and must be paired with a Doom-compatible game engine". — [freedoom.github.io/about](https://freedoom.github.io/about.html)
- FreeDM is described as "BSD-style" and used in a 2026 browser Doom. — [doom-room](https://github.com/kbrianps/doom-room)
- uzdoom-wasm bundles Freedoom and says it is "fully playable". — [uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm)

### Gaps
- The latest Freedoom version and date (I believe 0.13.0, 2024, unverified), whether every map has co-op starts, and Odamex compatibility (Odamex commonly lists freedoom1/2 as supported IWADs, unverified) were not confirmed.

## Q6. Existing runtime links between Doom and other games

### Takeaway
Archipelago's Doom client (APDOOM) is the precedent. It is a Crispy Doom fork with an embedded C++ Archipelago client (APCpp) and generated per-WAD headers. It exchanges items and locations, not players. I found no project that moves a player between Doom and another game.

### Cited Findings
- APDOOM is "forked from fabiangreffrath/crispy-doom". It includes an `APCpp` submodule (Daivuk/APCpp). `ap_gen_tool` reads the WAD and writes Python rules into Archipelago plus "C header files into AP-DOOM". It is at "Version 0.1.0 (beta)" with 19 stars. In-game hints go through chat ("!hint e1m3 map"). It supports DOOM 1993, DOOM II and Heretic, built from the Steam WADs. Shareware is not supported. — [github.com/Daivuk/apdoom](https://github.com/Daivuk/apdoom)
- The Archipelago setup runs the APDOOM executable with the server address and slot name, and recommends the Text Client because in-game messages fade quickly. — [archipelago.gg DOOM 1993 setup](https://archipelago.gg/tutorial/DOOM%201993/setup/en)
- The Archipelago protocol itself (WebSocket JSON, DeathLink tag) is covered in `cross_game_precedents.md` in this folder. — [Archipelago network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

### Inferences
- APDOOM's pattern of a C++ client library linked into the port, talking WebSocket JSON to an external hub, is the closest template for a "portal adapter" in a Doom port. DeathLink is a working cross-game event.

### Gaps
- No cross-game "portal" that carries a player between two different engines at runtime was found this session.
