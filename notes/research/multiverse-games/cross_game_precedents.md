# Cross-game precedents and architectures for a "multiverse" meta-game (as of 2026-11-24)

Scope: precedents for linking separately built games, possibly on different engines, into one shared experience. The intended use is a persistent war campaign, with each game acting as a front. The games in view are a browser port of Serious Sam TFE (GPL Serious Engine 1), iw4L (Rust/Bevy MW2 runtime), an NFSU2 browser recompilation, and possibly later Serious Sam games with Lua modding.
Research budget: about 15 web calls. Several sub-questions could not be sourced in that budget and are listed under Gaps rather than filled in from memory.

## Q1. Archipelago: architecture, protocol, game hooking, scale, and license

### Takeaway
Archipelago is the strongest direct precedent. One authoritative Python server talks to many different game adapters over WebSocket and JSON. Each game publishes a per-game "data package" that maps item and location names to IDs. Each adapter only has to report "location checked" events and apply "item received" events, so it never needs to understand the other games. The project is MIT-licensed and lists about 80 games. Users supply their own ROMs and game files.

### Cited Findings
**Transport and framing**
- Archipelago uses WebSocket with JSON. Each message is a JSON list of command objects keyed by `"cmd"`, and an object can carry a `"class"` key for typed objects such as `"Version"`. Per-message compression is expected, and uncompressed connections are deprecated. — [Archipelago network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Handshake**
- The handshake runs in this order:
  1. The client opens the socket.
  2. The server sends `RoomInfo`.
  3. Optionally, the client sends `GetDataPackage` and the server replies with `DataPackage`.
  4. The client sends `Connect`.
  5. The server replies with `Connected` or `ConnectionRefused`.
  6. Queued `ReceivedItems` follow.

  After a refusal the socket stays open so the client can retry. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Connect, refusals and RoomInfo**
- `Connect` carries:
  - `name` (the slot)
  - `game`
  - `password`
  - `uuid`
  - `version` (a NetworkVersion with major, minor and build)
  - `items_handling` (bit flags: 0b001 items from other worlds, 0b010 items from the client's own world, 0b100 starting inventory)
  - `tags`
  - `slot_data` (a boolean)

  — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)
- `ConnectionRefused` error codes are `InvalidSlot`, `InvalidGame`, `IncompatibleVersion`, `InvalidPassword` and `InvalidItemsHandling`. The server compares NetworkVersion to decide incompatibility. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)
- `RoomInfo` fields:
  - `version`
  - `generator_version`
  - `tags`
  - `password` (a boolean)
  - `permissions` (release, collect and remaining)
  - `hint_cost`
  - `location_check_points`
  - `games`
  - `datapackage_checksums`
  - `seed_name`
  - `time`

  — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Core gameplay packets**
- The core gameplay packets are small:
  - Client to server: `LocationChecks {locations:[ids]}` (duplicates are harmless, which makes the message idempotent), `LocationScouts`, `StatusUpdate` (ClientStatus 0 unknown, 5 connected, 10 ready, 20 playing, 30 goal), `Say` and `Sync`.
  - Server to client: `ReceivedItems {index, items:[NetworkItem]}`, `RoomUpdate` (only the changed fields) and `PrintJSON` (rich text, where clients must display unknown types as plain text).

  — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Ordering and resync**
- Clients persist the last processed `ReceivedItems.index`. On a gap they send `Sync` and then re-send `LocationChecks`. `index == 0` means "this is the full inventory, replace yours". — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Item, player and ID model**
- A NetworkItem is `{item, location, player, flags}`, with flags 0b001 advancement, 0b010 useful and 0b100 trap. NetworkPlayer has `team` (from 0), `slot` (from 1, where slot 0 is the server), `alias` and `name`. Item and location IDs fall within ±(2^53−1), which is JS-safe, and IDs ≤ 0 are reserved. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Data package**
- The data package is `games → {item_name_to_id, location_name_to_id, checksum}`. Clients cache it on disk and re-fetch when `datapackage_checksums` in RoomInfo changes. Names and IDs are unique only per game, so a client must resolve a player's game through `slot_info` before decoding an ID. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Cross-game broadcast (Bounce and DeathLink)**
- `Bounce` and `Bounced` are a generic pub/sub broadcast. Targets are chosen by `teams`, `games`, `slots` and `tags`, combined with an `operator` (or, and, legacy).
- DeathLink is built on top of Bounce with the `DeathLink` tag. Its payload is `{time, source, cause?}`, and when one player dies, every opted-in player in every game dies.

— [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Shared data storage**
- `Get`, `Set` and `SetNotify` act on a server key-value store. `Set` applies ordered atomic operations: replace, default, add, mul, pow, mod, floor, ceil, max, min, bitwise operations, remove, pop and update. Read-only computed keys start with `_read_` (for example `hints_{team}_{slot}` and `client_status_{team}_{slot}`). — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**Capability tags and client libraries**
- Capability tags are `AP`, `DeathLink`, `HintGame`, `Tracker`, `TextOnly` and `NoText`. Tracker, TextOnly and HintGame clients may connect with an empty `game`, which skips game and version validation. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)
- Community client libraries exist for Python, Java, .NET, C++, JS/TS, Haxe, Rust, Lua and GameMaker. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)

**How games are hooked in**
- Emulated games go through BizHawk. A Python `BizHawkClient` talks over a socket to a Lua script loaded inside the emulator (`connector_bizhawk_generic.lua`), which reads and writes memory by address, length and memory domain (for example "System Bus").
- Each game's client subclasses `BizHawkClient` and implements `validate_rom` and `game_watcher`. Some games ship their own connector Lua instead, such as `connector_mmbn3.lua`.

— [Archipelago _bizhawk README (mirror)](https://git.hollymcfarland.com/monorail/Archipelago/raw/branch/main/worlds/_bizhawk/README.md); [MMBN3 setup guide](https://archipelago.gg/tutorial/MegaMan%20Battle%20Network%203/setup_en)
- PC games are hooked through game mods. Examples include an Outer Wilds mod ([outerwildsmods.com](https://outerwildsmods.com/mods/archipelagorandomizer)), a Thunderstore mod for ULTRAKILL ([Thunderstore](https://thunderstore.io/c/ultrakill/p/TRPG/Archipelago/v/1.2.0/)), and a Stardew Valley entry credited to "Witchybun (Mod Support)" ([archipelago.gg/games](https://archipelago.gg/games)).
- The repo also contains `SNIClient.py` and `CommonClient.py` (the SNES route and the generic text client). — [GitHub repo](https://github.com/ArchipelagoMW/Archipelago)

**Scale, license and activity**
- The supported games page listed 81 games when fetched on 2026-11-24, and the repo README lists 80. Shooters are limited to DOOM 1993, DOOM II and Heretic; Quake, Serious Sam and Half-Life are not listed. — [archipelago.gg/games](https://archipelago.gg/games); [GitHub README](https://github.com/ArchipelagoMW/Archipelago)
- The repo had about 1.8k stars, 2.3k forks, 8,592 commits, 199 open issues and 446 open PRs when fetched on 2026-11-24. The fork count exceeds the star count because game "worlds" are developed in forks. — [GitHub repo](https://github.com/ArchipelagoMW/Archipelago)
- The license is MIT: "Copyright (c) 2017 LLCoolDave", with later holders Berserker66, CaitSith2 and LegendaryLinux. — [LICENSE](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/LICENSE)
- Copyrighted data is user-supplied. The setup guide says some games require you to own their ROM files, and the generator asks you to locate the base ROM to build patch files. — [Archipelago setup guide](https://archipelago.gg/tutorial/Archipelago/setup/en); [SMW setup guide](https://archipelago.gg/tutorial/Super%20Mario%20World/setup_en)
- The project is active as of 2026: release 0.6.7 was tagged around April 2026, and an Archipelago game jam on itch.io ran from 2026-05-22 to 2026-06-14. — [gitlab mirror tags](https://gitlab.com/delicious.gummies/ArchipelagoAILimit/-/tags); [itch.io jam](https://itch.io/jam/archipelago-game-jam)

### Inferences
- The minimal adapter contract carries over directly to a war meta-game: emit idempotent "I did X" events (like LocationChecks) and consume an indexed, resyncable stream of "apply Y" events (like ReceivedItems with index and Sync). A Serious Sam level-clear, an iw4L match result and an NFSU2 race win can each be a "check", and war effects such as reinforcements, modifiers or unlocked fronts can be "items".
- A per-game data package with a checksum, plus versioned handshakes with typed refusal codes, lets heterogeneous clients evolve independently. Keeping IDs within ±2^53 avoids JS number loss, which matters for a browser port.
- Bounce with tags (like DeathLink) is a cheap pattern for cross-front "events" without hard coupling, for example "artillery strike from front A hits front B".
- The `Set` operations are effectively a CRDT-lite for shared counters, so war-score contributions could use `add` or `max` on server keys.
- Archipelago has no anti-cheat. It trusts clients, which is acceptable for cooperative or casual play. A competitive war map needs more (see Q4).

### Gaps
- The exact current count of APWorlds, including unofficial ones, the monthly player count, and the 2026 release cadence were not found from primary sources.
- SNI internals were not researched.
- No 2025–2026 Archipelago postmortem or talk on protocol design was found.
- Similar projects were not researched in this budget: the older SMZ3, Multiworld randomizers and OoT-MM.

## Q2. Persistent shared-war meta-games: Helldivers 2, Foxhole, EVE and Dust 514

### Takeaway
The working pattern is that many short matches feed one slow strategic map, and a human "game master" steers the narrative. Helldivers 2 shows that a hand-tuned server with a public JSON war state builds a large community layer around itself. EVE and Dust 514 show that a cross-game link is fragile when it is mechanically thin and tied to a dying platform. Foxhole shows that wars need an end condition: open-ended wars stalled for 50 to 71 days.

### Cited Findings
**Helldivers 2 (Arrowhead, launched February 2024)**
- Every mission contributes liberation percentage to a planet. At 100% the planet locks, and liberation spreads along supply lines to linked planets. A defeated faction is removed until the next cycle. — [The Nerd Stash](https://thenerdstash.com/how-the-galactic-war-works-in-helldivers-2)
- A human "Game Master", Joel, issues Major Orders and steers the war. An Arrowhead developer said many systems "don't have the functionality yet, and so a lot of it has to be done manually by Joel, which can be inconsistent". — [PC Gamer](https://pcgamer.com/we-have-an-actual-person-with-the-title-of-game-master-a-single-helldivers-2-dev-named-joel-is-pulling-the-strings-on-its-galactic-war-like-an-all-powerful-dandd-dungeon-master-war-will-become-more-and-more-sophisticated-over-time); [GamesRadar](https://gamesradar.com/helldivers-2-game-master-joel-works-to-fix-inconsistent-liberation-results-but-lacking-in-game-communication-tools-is-the-bigger-problem)
- Joel later became a team. Arrowhead said "Joel is now a team of people working together". — [PC Gamer](https://www.pcgamer.com/games/third-person-shooter/joel-is-now-a-team-of-people-working-together-helldivers-2s-game-master-has-evolved-into-a-hivemind)
- The GM is used to avoid a purely "calendar with automated events" live service. — [PC Gamer](https://pcgamer.com/games/third-person-shooter/helldivers-2-uses-its-game-master-to-stop-its-live-service-side-from-being-just-a-calendar-with-automated-events-tied-to-major-holidays)
- In 2026 Arrowhead said it is making the war "more reactive", with multi-week campaigns and better rewards, and is evolving Major Orders into Galactic War campaigns with changes to mission distribution. — [GamesRadar (2026)](https://www.gamesradar.com/games/third-person-shooter/helldivers-2-will-receive-core-improvements-by-summer-as-arrowhead-works-on-making-the-galactic-war-more-reactive-with-multi-week-campaigns-and-better-rewards/); [PC Gamer](https://pcgamer.com/games/action/helldivers-2-will-evolve-major-orders-into-galactic-war-campaigns-later-this-month-with-huge-changes-to-mission-distribution-and-super-destroyers-also-in-the-works/)
- The war state comes from an unofficial but public JSON endpoint. The community project helldivers-2/api re-serves it and is "not affiliated with ArrowHead". Training Manual documents `/api/v1/war/status` (planet status and player counts) and `/api/v1/war/info` (static planet data), with no auth or rate limit, and warns it "is not an officially open API". A .NET wrapper caches responses about 5 minutes per endpoint. — [helldivers-2/api](https://github.com/helldivers-2/api); [Training Manual API](https://helldiverstrainingmanual.pages.dev/api); [helldivers2api-net](https://awesome.ecosyste.ms/projects/github.com%2Ftravis-stanley%2Fhelldivers2api-net)
- Fans built live maps on that data. — [Windows Central](https://www.windowscentral.com/gaming/helldivers-2-galactic-war-live-map-track-status-and-progress-with-this-liberty-approved-web-app)
- Operational fragility: in February 2025 Arrowhead took the Galactic War offline because a bug was making liberation too easy. A separate backend error also forced it offline. — [Windows Central](https://www.windowscentral.com/gaming/helldivers-2-says-the-galactic-war-is-on-hold-because-a-bug-was-making-it-too-easy); [GamingBolt](https://gamingbolt.com/helldivers-2s-galactic-war-feature-has-been-taken-offline-to-fix-a-backend-error)

**Foxhole (Siege Camp, formerly Clapfoot)**
- A war ends when one side reaches a victory-point threshold by controlling map areas. — [Wikipedia](https://www.Wikipedia.org/wiki/Foxhole_(video_game))
- Typical length is about 20–30 days, but that is a player estimate, not an official figure. — [Steam forum](https://steamcommunity.com/app/505460/discussions/0/4701287093716962357)
- War 100 ran just under 55 days and was the previous record. — [PCGamesN](https://www.pcgamesn.com/foxhole/longest-deadliest-war)
- The "Forever War" on the Charlie server ran about 70–71 days with about 9 million deaths. The developer lowered the victory-point threshold to force an end. — [GamesRadar](https://www.gamesradar.com/games/mmo/a-battle-in-this-ww2-mmo-went-on-for-over-2-months-and-killed-9-million-players-so-devs-stepped-in-to-end-it-early-only-for-one-last-hurrah-to-win-it-anyway); [Gamepressure](https://www.gamepressure.com/newsroom/70-days-and-9-million-deaths-dev-had-to-stop-mmo-game-war-on-stea/zc78d9)

**EVE Online and Dust 514 (CCP; Dust was PS3, live roughly May 2013 to 2016-05-30)**
- Both games shared one backend: EVE's Tranquility cluster. — [Red Bull](https://www.redbull.com/gb-en/dust-514-and-epic-game-inside-a-game); [Softpedia](https://games.softpedia.com/blog/EVE-Online-Integrates-Dust-514-Severs-Tomorrow-319805.shtml)
- The pre-launch 2011 design put FPS matches on regional battle clusters. A managing server talked to Tranquility, and EVE logic told a cluster to spawn a battle when both sides reached the minimum player count. This was a pre-launch plan; the final implementation was not confirmed. — [PlayStation Blog (2011)](https://blog.playstation.com/2011/10/28/scaling-the-universe-of-dust-514/)
- The headline cross-game feature was orbital bombardment: a Dust player could call in a strike from an EVE player's ship. — [Digital Trends](https://digitaltrends.com/gaming/ccp-games-to-shut-servers-for-ps3-fps-dust-514)
- Planetary Conquest split planets into districts fought over in scheduled, instanced 24v24 battles. Critics said owning districts had "very little effect" on EVE Online. — [Engadget (2013)](https://www.engadget.com/2013-11-03-eve-evolved-what-dust-514-should-have-been.html)
- Shutdown was announced in February 2016, and servers went off on 2016-05-30 after about 3 years. CCP's statement: "the years have caught up with us." The team moved to a PC-only UE4 shooter (after cancelling Project Legion), because PC is "where all the EVE Online players are anyway". — [GameSpot](https://www.gamespot.com/articles/playstation-exclusive-shooter-dust-514-is-shutting/1100-6434460); [Game Developer](https://gamedeveloper.com/business/ccp-to-pull-the-plug-on-i-eve-online-i-spin-off-i-dust-514-i-); [TweakTown](https://www.tweaktown.com/news/50142/dust-514-shutting-servers-down-working-new-pc-fps-project/index.html)

### Inferences
- The proven pattern is many short instanced sessions, each emitting a result, aggregated server-side into a slow strategic map with a cadence of days to weeks. A human or scripted GM adds events so the war does not feel like a calendar. The design should ship a war-end condition and a GM override from day one, since Foxhole and Helldivers needed both.
- Dust 514's lesson is that a cross-game link needs meaningful bidirectional stakes. Its link was asymmetric and abstract (districts had little EVE effect), and its players sat on a platform the main audience did not own. For the multiverse, each front's result should visibly move the shared map, and all fronts should be reachable on the same device class. A browser plus a native Bevy build needs a shared web identity and map.
- Helldivers shows that a read-only public JSON war state invites community tools (maps, bots) for free.

### Gaps
- PlanetSide 2 (continent locks, alerts), World of Tanks / Warships Clan Wars (Global Map), Destiny community events and Splatfests were not researched within budget. No sourced facts on their server design or cadence are included.
- No sourced detail was found on how Helldivers 2 validates mission results (anti-cheat) or on its backend tech stack.

## Q3. Cross-game and cross-engine interop experiments (avatars, assets, streams)

### Takeaway
Asset-interop standards (OMI glTF extensions, Ready Player Me avatars) have had limited success. Ready Player Me, the best-known cross-game avatar service, was bought by Netflix in December 2025 and shut its public services from 2026-01-31. Interop that works in practice is event-level: Crowd Control-style "external event → in-game effect" adapters, built by reverse engineering or per-engine plugins across 100+ games.

### Cited Findings
**Ready Player Me**
- Netflix acquired Ready Player Me in December 2025 for an undisclosed price. About 20 staff joined Netflix, and of the founders only CTO Rainer Selvet moved. — [TechCrunch (2025-12-19)](https://techcrunch.com/2025/12/19/netflix-acquires-gaming-avatar-maker-ready-player-me/); [Road to VR](https://roadtovr.com/netflix-acquires-xr-avatar-startup-ready-player-me/)
- Ready Player Me announced its avatar services, including the PlayerZero creator, would go offline starting 2026-01-31. VRChat had pointed beginners to it. — [Road to VR](https://roadtovr.com/netflix-acquires-xr-avatar-startup-ready-player-me/); [PocketGamer.biz](https://www.pocketgamer.biz/netflix-acquires-avatar-creation-platform-ready-player-me)

**OMI glTF extensions**
- OMI develops vendor glTF extensions through the W3C Metaverse Interoperability Community Group process and may propose common ones to Khronos. The listed extensions include KHR_audio_emitter, OMI_audio_ogg_vorbis, OMI_audio_opus, OMI_link, OMI_personality, OMI physics extensions, OMI_seat and OMI_spawn_point. — [OMI glTF Extensions docs](https://omigroup.github.io/gltf-extensions); [github.com/omigroup](https://github.com/omigroup)
- The repo's last push was on 2025-04-10, with a September 2025 sync, according to an aggregator. — [ecosyste.ms](https://opencollective.ecosyste.ms/projects/6855)
- Khronos and the VRM Consortium announced a collaboration in October 2024 on interoperable avatars. — [MSF SIGGRAPH deck](https://metaverse-standards.org/wp-content/uploads/MSF-3D-Assets-BOF-SIGGRAPH-Jul26.pdf)

**Crowd Control (Warp World)**
- Viewers spend coins to trigger in-game effects. Integrations are built by reverse engineering games, and the service supports 100+ games with 70,000+ creators (2023 figures). — [TechCrunch (2023-05-01)](https://techcrunch.com/2023/05/01/crowd-control-interactive-stream/amp/)
- Three integration types exist:
  - built-in effect packs per game
  - "disrupt"-only generic packs, plus a "Human Connector" where a human approves effects for tabletop games
  - a developer plugin for Unity, Unreal and GameMaker

  Third parties build effect packs with the SDK. — [crowdcontrol.live How We Work](https://crowdcontrol.live/how-we-work/); [Shacknews CC 2.0 interview](https://shacknews.com/article/136609/crowd-control-20-interview)
- Version 2.0 extended beyond Twitch to YouTube, TikTok, Discord and Facebook Gaming. — [Game Rant](https://gamerant.com/crowd-control-2-interview-new-features/)

### Inferences
- Do not depend on a third-party identity or avatar service (Ready Player Me's shutdown is the cautionary tale). Keep identity and cosmetics in your own meta-server.
- Crowd Control's split into a native effect pack, generic fallback effects and a manual "human connector" maps neatly onto a multiverse:
  - fronts with deep mod hooks (Serious Sam Lua, iw4L Rust) get rich effects
  - fronts with shallow hooks (the NFSU2 recompilation) get generic modifiers or result-only reporting

### Gaps
- Not researched within budget:
  - Fortnite and Epic crossovers
  - Valve's shared Steam Inventory
  - Minecraft or Twitch bridge mods
  - Skyrim–Fallout link mods
  - "Doom inside other games" crossover mods

  No sourced facts on these are included.

## Q4. Technical patterns: event bus, schemas, versioning, identity, trust, and state reading

### Takeaway
Across the precedents, the shared stack is:
- one authoritative server holding the shared state
- thin per-game adapters, either in-process mods or out-of-process bridges reading memory over a local socket
- a JSON-over-WebSocket protocol with a version handshake, typed refusal codes, idempotent event reports, indexed resyncable state streams, and a checksum-versioned per-game schema

Client self-reports are trusted in Archipelago and must be bounded or validated in a competitive war.

### Cited Findings
- Archipelago supplies the concrete schema and versioning patterns: NetworkVersion with a `"class":"Version"` handshake, `IncompatibleVersion` and `InvalidItemsHandling` refusals, data-package checksums, an `InvalidPacket {type, original_cmd, text}` error, and partial `RoomUpdate` deltas. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)
- Identity in Archipelago is weak: a slot name, an optional room password and a client `uuid`. There are no accounts. — [network protocol.md](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)
- There are three ways to read game state:
  - **Emulator memory:** a Lua script inside the emulator serves memory reads and writes over a socket to an external Python client. — [_bizhawk README](https://git.hollymcfarland.com/monorail/Archipelago/raw/branch/main/worlds/_bizhawk/README.md)
  - **In-game mods:** examples on the Thunderstore and Outer Wilds mod loaders. — [Thunderstore](https://thunderstore.io/c/ultrakill/p/TRPG/Archipelago/v/1.2.0/); [outerwildsmods.com](https://outerwildsmods.com/mods/archipelagorandomizer)
  - **Reverse-engineered hooks:** Crowd Control. — [TechCrunch](https://techcrunch.com/2023/05/01/crowd-control-interactive-stream/amp/)
- Server-authoritative orchestration across heterogeneous game servers is a precedent from Dust 514's design: EVE logic decided when and where battles spawned, and regional FPS clusters reported back. — [PlayStation Blog (2011)](https://blog.playstation.com/2011/10/28/scaling-the-universe-of-dust-514/)
- Public read-only state APIs were cached by clients (about 5-minute cache) without auth. — [helldivers2api-net](https://awesome.ecosyste.ms/projects/github.com%2Ftravis-stanley%2Fhelldivers2api-net); [Training Manual API](https://helldiverstrainingmanual.pages.dev/api)

### Inferences
- For trust, keep each front's contribution as bounded, rate-limited, aggregate-only deltas (for example a capped influence per player per hour). Where a front has its own authoritative server (iw4L dedicated servers), accept results only from that server, signed with a server key, not from players' clients. Browser single-player fronts (SS TFE, NFSU2) are inherently self-reported, so weight them lower or cap them. No sourced anti-cheat detail was found; this is a design inference.
- For identity, use one meta-account (for example OAuth or passkey on the meta-server) that issues short-lived per-session tokens to each game adapter, instead of Archipelago's slot-name model.

### Gaps
- No sourced material was gathered on:
  - RCON or log-parsing bridges (for example Quake or CoD server log tailing)
  - signed match results
  - specific anti-cheat in Helldivers, Foxhole or PlanetSide
  - GDC talks on cross-game protocols

## Q5. Legal and licensing patterns

### Takeaway
The precedents ship code and patches, never game data. Users supply their own ROMs or game files, as Archipelago does. On GPL, the FSF's own FAQ treats programs that talk over sockets, pipes or the command line as normally separate programs. A GPL engine port and a non-GPL meta-server or other ports can therefore coexist if they talk over a network protocol and do not exchange "intimate" internal data structures.

### Cited Findings
- Archipelago asks users to locate their own base ROM, which is used to build patch files. The project itself is MIT. — [Archipelago setup guide](https://archipelago.gg/tutorial/Archipelago/setup/en); [LICENSE](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/LICENSE)
- The FSF GPL FAQ (as quoted in mailing-list archives) says: "pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs. So when they are used for communication, the modules normally are separate programs." It adds that if the semantics are "intimate enough, exchanging complex internal data structures", the parts could be treated as one program. It also says simple fork and exec plug-ins are separate programs, and that "mere aggregation" on one medium does not extend the GPL. — [GPLv2 FAQ mirror](https://www.southampton.ac.uk/~qs2g22/mirror/www.gnu.org/licenses/old-licenses/gpl-2.0-faq.html); [ifrOSS analysis](https://www.ifross.org/en/when-does-independently-developed-software-have-be-licensed-under-gpl); [OSI license-discuss 2012](https://lists.opensource.org/pipermail/license-discuss_lists.opensource.org/2012-January/017512.html)
- Community APIs explicitly disclaim affiliation ("not affiliated with ArrowHead"). — [helldivers-2/api](https://github.com/helldivers-2/api)

### Inferences
- The multiverse protocol should be a documented, generic JSON message set (events, deltas) rather than serialized engine structs. That keeps the GPL Serious Engine port, iw4L (whatever its license) and the NFSU2 recompilation legally separate under the FSF's own reading, and it is also good engineering.
- Use non-trademark project names with "not affiliated with" disclaimers, and require user-supplied game data.

### Gaps
- The current gnu.org FAQ text was not fetched directly; the quotes come from mirrors and archives.
- No sourced trademark case law or takedown history for fan multiworld projects was found (for example whether Nintendo, Activision or EA ever acted against Archipelago-style projects).
- No source found on legal treatment of static recompilation projects in 2025–2026.
