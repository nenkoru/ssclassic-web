# Multiverse: games, rewrites and how they connect

Research synthesis, 2026-11-24. The sourced notes behind it are in [research/multiverse-games/](research/multiverse-games/): popular rewrites, Serious Sam HD/Fusion/BFE, SS4 and later, cross-game precedents, and Doom drop-in co-op.

**Summary.** The 2026 scene is dominated by static recompilations and a September–October flood of AI-assisted browser ports (Halo CE, Vice City, NFSU2, Black Ops), followed by a wave of DMCAs, mostly from Activision. Of the Serious Sam games, only Serious Engine 1 (TFE and TSE, our port) has open code. The HD remakes, BFE and Fusion can be reached only through Croteam's own Lua and Workshop tools. SS4 can be reached the same way, more weakly. Shatterverse and The Third Encounter offer no integration surface at all. So the multiverse has to be a **network of separate programs around one war server**, with SS1 at the center, not a single linked binary. The best template is **Archipelago's protocol**, a JSON-over-WebSocket hub that already joins about 80 unrelated games. Add the heartbeats, distress calls and portal tickets that Archipelago lacks, and you get the rescue portal. The cheapest real cross-engine front is **Doom on Odamex with Freedoom data**: GPL-2.0, client-server, with co-op and a join queue (whether it admits a joiner mid-map in plain co-op is still unverified), and free to host. Its browser client has to be written, because nobody has ported a client-server Doom's networking to the web. Live see-through portals are realistic only between games we control on both sides (TFE↔TSE first, then perhaps an nfsu2-web fork). iw4L, the Halo port, Fusion and SS4 should be handoff fronts behind a published adapter spec, maintained by their own communities.

## The 2026 rewrite landscape

Attention in 2026 goes where a reusable toolchain exists. recompsoftware.com counted **464 static recompilations** on 2026-11-23, 140 of them for Xbox 360 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)). Tools like N64Recomp, XenonRecomp, ReXGlue and PS2Recomp each spawn dozens of per-game repos. The big decomp milestones were Twilight Princess, finished and then ported as Dusklight in May ([PC Gamer](https://www.pcgamer.com/games/action/an-unofficial-pc-port-of-the-legend-of-zelda-twilight-princess-just-released/)), and Melee at 100% ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). The mature engine reimplementations are still the largest and steadiest projects: OpenRA, OpenRCT2, DevilutionX, OpenTTD and OpenMW.

The second story is AI. A community tracker counted **273 AI-assisted reverse-engineering projects on 2026-10-30, 226 of them crediting Claude** ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). Kotaku reported hundreds of browser ports appearing within weeks after Claude Opus 5.5 launched ([Kotaku](https://kotaku.com/we-might-be-cooked-as-these-vibe-coded-web-browser-ports-of-halo-the-simpsons-hit-and-run-and-gta-vice-city-seem-to-work-perfectly-2000743300)). Takedowns followed. Activision went after the Black Ops 2 browser ports around 2026-10-10 ([TweakTown](https://www.tweaktown.com/news/114029/activision-takes-down-ai-made-black-ops-2-browser-ports/index.html)) and after an AI-assisted MW2 decompilation ([Kotaku](https://kotaku.com/activision-and-bethesda-crackdown-on-genai-mw2-and-fallout-projects-2000739580)). Bethesda sent a cease-and-desist over a Fallout project (same source). Projects also go private under copycat pressure: nfsu2-web was archived on 2026-11-09 ([README](https://github.com/th0mk/nfsu2-web)).

Three patterns matter for this design. First, browser ports run on two stacks. One is C compiled to wasm with wasi-sdk and rendered with WebGPU (nfsu2-web). The other is Emscripten with WebGL (DOS.Zone, Xash3D, the Quake and Doom ports). Second, **persistent online lobbies are now expected**: nfsu2.xyz, the Halo rooms and DOS.Zone's hub all have them. Third, **"bring your own data" with a hash-checked loader is the standard legal posture.** Dusklight checks the dump's SHA-1, nfsu2-web wants an exact SHA-256 of `SPEED2.EXE`, and the Halo port asks for your own Xbox disc image ([nfsu2-web README](https://github.com/th0mk/nfsu2-web), [heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)). Projects that hosted assets drew the takedowns (inference from the cases in the notes).

One finding hits close to home. **DOS.Zone already runs Serious Sam TFE/TSE multiplayer in the browser**, with 16-player co-op plus Scorematch and Fragmatch, and players host their own servers ([3DNews, 2026-10-14](https://3dnews.ru/1149935)). Its toolchain is not public. A browser SE1 with multiplayer is therefore no longer unique. The war layer and the portals would be (inference).

The projects most relevant to this design (star counts from the GitHub API on 2026-11-24):

| Project | What it is | Runs in browser? | License | State, Nov 2026 | Role here |
|---|---|---|---|---|---|
| [nfsu2-web](https://github.com/th0mk/nfsu2-web) | NFSU2 x86 lifted to C, compiled with wasi-sdk, D3D9 on WebGPU, Rust server | Yes | MIT | 1.2k★, archived 2026-11-09, work continues privately | Candidate front; reference browser recomp |
| [iw4L](https://github.com/vladtrc/iw4L) | MW2 (2009) runtime in Rust on Bevy/wgpu, LLM-written | No web build documented | Apache-2.0 | 1.2k★, created 2026-09-13 | Candidate handoff front |
| Halo CE browser port | halo-re decomp compiled to wasm, desktop Chrome | Yes | Unknown | Late Sep 2026; site taken down, mirrors work ([PCGuide](https://www.pcguide.com/news/halo-ce-in-your-browser-with-splitscreen-co-op-and-128-player-multiplayer-gets-taken-down-but-its-still-playable/)) | Candidate handoff front |
| DOS.Zone Serious Sam MP | TFE/TSE browser multiplayer, 16-player co-op | Yes | Unknown toolchain | Oct 2026 ([3DNews](https://3dnews.ru/1149935)) | Nearest neighbor to our port |
| revcDOS / re3 | Vice City and GTA III decomps; revcDOS is reVC in wasm | Yes (revcDOS) | — | re3 returns HTTP 451; revcDOS taken down Dec 2025, relaunched 2026 ([gtaboom](https://www.gtaboom.com/take-two-just-killed-the-vice-city-browser-port-3955)) | Legal warning |
| [Odamex](https://github.com/odamex/odamex) | Client-server Doom with co-op, Horde, rcon, ACS | No | GPL-2.0 | 12.3.0, active ([releases](https://github.com/odamex/odamex/releases)) | Doom front engine |
| [cloudflare/doom-wasm](https://github.com/cloudflare/doom-wasm), [doom-room](https://github.com/kbrianps/doom-room) | Browser Doom MP: lockstep over a WebSocket relay; "ghost" players | Yes | GPL-2.0 | Working | Relay pattern; fallback |
| [UZDoom](https://github.com/UZDoom/UZDoom) + [uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm) | GZDoom successor; single-player web build | Yes (SP only) | GPLv3 | Upstream browser PR closed unmerged ([PR #848](https://github.com/UZDoom/UZDoom/pull/848)) | Not join-capable |
| [Archipelago](https://github.com/ArchipelagoMW/Archipelago) | Multiworld randomizer hub, about 80 games | Clients vary | MIT | 0.6.7 around Apr 2026 | Protocol template |
| N64Recomp / ReXGlue / PS2Recomp | Recompilation SDKs | No | MIT / NOASSERTION / GPL-3.0 | 8.4k / 1.3k / 3.9k★ | Where the attention is; not fronts |

## Serious Sam versions today

The series has one open engine and a closed tail. Croteam released **Serious Engine 1.10 under GPLv2 in March 2016, code only**. The assets and the Serious Sam IP were not released ([Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine)). No source for SE2, SE3, SE3.5 or SE4 has ever been published, and the notes found no reports of a leak. Croteam has said Serious Engine is retired and that it has moved permanently to Unreal ([Unreal Engine interview](https://www.unrealengine.com/en-US/developer-interviews/inside-croteam-s-transition-from-in-house-tech-to-ue5-for-the-talos-principle-2), seen via search snippet only). The SE1 code base is therefore likely to stay the only open Serious Sam code (inference).

Fusion matters more than its age suggests. It was a public beta from 2017, effectively abandoned after June 2019, and then **left beta on 22 Nov 2026** with a large bug-fix patch. In that announcement Croteam said it plans to revisit modding support ([Steam news](https://store.steampowered.com/news/app/564310/view/674012071495467586), [PCGamingWiki](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)). It is the only maintained PC build of the HD games and BFE. It already acts as a small multiverse: one launcher that switches games without exiting, and a shared TFE/TSE/BFE server list with cross-game map voting ([Steam store](https://store.steampowered.com/app/564310/Serious_Sam_Fusion_2017/)). Someone has also published an Archipelago integration for it, SeriousSamFusionArchipelago, in Jan 2026 ([GitHub search](https://api.github.com/search/repositories?q=serious+sam+fusion)). How it hooks the game was not checked.

Shatterverse already tells the multiverse story. It is a Behaviour Interactive co-op roguelite on Unreal, released 31 Aug 2026 to poor reviews. Its premise: Mental has broken the walls between universes, and Sams from many dimensions travel to **"finish battles other Sams couldn't"** ([Devolver press release](https://www.gamespress.com/Devolver-Digital-Announces-Serious-Sam-Shatterverse-a-Co-operative-FPS)). That is the rescue portal, written as official lore. It offers no technical integration: peer-to-peer multiplayer and no Workshop ([Xbox Wire](https://news.xbox.com/en-us/2026/08/31/serious-sam-shatterverse/), [Steam](https://store.steampowered.com/app/2067210/Serious_Sam_Shatterverse/)). Using its name would be IP use.

| Game | Year | Engine | Platforms | Source / modding | Multiplayer | How it could connect |
|---|---|---|---|---|---|---|
| **TFE / TSE (classic)** | 2001 / 2002 | SE1 | Original Windows; community forks for Win/Linux/macOS/RPi ([SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic)); our browser port; DOS.Zone browser MP | **Full GPL-2.0 code**; assets proprietary, user-supplied | Ours: 20 Hz lockstep, 16-player cap, Rust WebSocket switch | **Center.** We own both sides: adapter, bots, live portals |
| HD TFE / HD TSE | 2009 / 2010 | SE3 | Win, Xbox 360; now inside Fusion; consoles via Serious Sam Collection (2020) | Closed; Serious Editor, Lua, Workshop ([Wikipedia](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_First_Encounter)) | 16 online, dedicated servers ([PCGamingWiki](https://www.pcgamingwiki.com/wiki/Serious_Sam_HD:_The_First_Encounter)) | Through Fusion |
| Serious Sam 3: BFE | 2011 | SE3.5 | Win, Mac, Linux, X360, PS3; Collection | Closed; Lua startup and CustomWorldScripts; separate "moddable version" ([SS3 changelog](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)) | 4 split-screen, 16 online, dedicated server ([PCGamingWiki](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE)) | Through Fusion |
| **Fusion** (HD TFE, HD TSE, BFE, VR) | 2017 beta; 1.0 on 22 Nov 2026 | SE3.5-derived 2017 build | Win/Linux/macOS 64-bit; D3D11/12, Vulkan, Metal | Closed; Serious Editor 2017, Lua, one shared Workshop | 16 online, 4 split, dedicated servers, Steamworks ([PCGamingWiki](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)) | **Best official target:** a Lua/Workshop mod plus a local helper; handoff front |
| Serious Sam 4 | 2020 | SE4 | Win, Stadia, PS5, XSX | Closed; Serious Editor 2021, Lua, Workshop ([EGM](https://egmnow.com/serious-sam-4-gets-official-modding-tools-and-steam-workshop-support/)) | 4-player online co-op; no versus, no dedicated server ([Steam discussion](https://steamcommunity.com/app/257420/discussions/0/2840039920169084552/)) | Lua console script exchanging text files with a local helper (unverified); handoff |
| Siberian Mayhem | 2022 | SE4 | Win, PS5, XSX | Modding support not confirmed | Single-player only per [Wikipedia](https://en.wikipedia.org/wiki/Serious_Sam:_Siberian_Mayhem) | Result-only, if at all |
| Shatterverse | 2026 | Unreal | Win, PS5, XSX, Xbox Cloud | None; no Workshop | 1–5 co-op, peer-to-peer, cross-platform | Narrative only |
| The Third Encounter | TBA (announced 22 Oct 2026, in early development) | Not stated | Windows (Steam) | No Workshop listed ([Steam](https://store.steampowered.com/app/459920/)) | Online co-op, split screen | Watch; its story continues directly from TSE ([GamingOnLinux](https://www.gamingonlinux.com/2026/10/serious-sam-the-third-encounter-gets-teased-by-croteam-and-devolver-digital/)) |

Several titles sit outside the table. The VR remakes run inside Fusion with VR/flat crossplay. Tormental is a Unity twin-stick game. Serious Sam II runs on SE2, which was never opened ([Wikipedia](https://en.wikipedia.org/wiki/Serious_Sam)). None of them changes the design.

Population is the sobering number. Over the last 30 days Fusion averaged **74 concurrent Steam players**, BFE 69, HD TFE 36, HD TSE 40, and each SE1 Classic app about 14 ([SteamCharts](https://steamcharts.com/app/564310)). Shatterverse sat at about 55 concurrent three months after launch ([Tracker.gg](https://tracker.gg/population/steam/2067210), search snippet). No official game can staff a front by itself. The war has to be carried by our browser players and our bots. Handoff fronts in the official games exist to let their owners contribute, not to supply crowds (inference).

Croteam's track record is fan-friendly. It released the SE1 code, gave away its editors, turned modders into the Siberian Mayhem team ([Wikipedia](https://en.wikipedia.org/wiki/Serious_Sam:_Siberian_Mayhem)) and features Workshop mods in Fusion news. The notes found no Serious Sam takedown. The only limits are on assets and the name: user-supplied data, and no "Serious Sam" or "Shatterverse" in the product name.

## Candidate fronts

A front qualifies when it can report outcomes and accept orders. For the rescue portal it must also take a joiner mid-match. The table ranks the candidates against those needs.

| Front | License | Browser or native | Join-in-progress | Adapter route | Live portal or handoff | Legal risk |
|---|---|---|---|---|---|---|
| **SS1 TFE** (ours) | GPL-2.0-only code; user's data | Browser, threaded wasm, WebGL2/WebGPU | SE1 netcode is client-server and is believed to send joiners the game state; untested in our port (verify) | Our Rust mod layer via the host API, plus a JS bridge in the page | **Live portal** (we own both sides) | Low |
| **SS1 TSE** (ours) | Same | Same | Same | Same | **Live portal** | Low |
| **Doom: Odamex + Freedoom** | GPL-2.0 engine ([repo](https://github.com/odamex/odamex)); BSD data ([Freedoom](https://freedoom.github.io/about.html)) | Native today; a browser client needs a new WebSocket transport | Yes in plain co-op (inference; not documented). Zandronum-style Survival blocks it ([forum](https://zandronum.com/forum/viewtopic.php?p=116225)) | We run `odasrv`: rcon, log tail, ACS or a small server patch; WebSocket↔UDP bridge | **Rescue portal** (handoff with a live preview) | Low |
| Doom: doom-wasm / doom-room | GPL-2.0 | Browser | doom-wasm: no, lockstep start only ([Cloudflare](https://blog.cloudflare.com/doom-multiplayer-workers/)); doom-room: yes, but as "ghosts" who cannot affect the world ([repo](https://github.com/kbrianps/doom-room)) | Page-level JS | Fallback only | Low |
| **nfsu2-web** | MIT (public snapshot) | Browser (wasi-sdk wasm, WebGPU) | Free roam via its Rust server; mid-session join likely (inference) | Our fork: race results plus a camera hook; or its Rust server reports | Handoff first; live portal later via the camera hook | Medium–high (EA; nfsu2.xyz accused of hosting assets, [HN](https://news.ycombinator.com/item?id=50403052)) |
| **iw4L** (MW2) | Apache-2.0 | Native (Bevy/wgpu) | Not documented; the host simulates the match ([README](https://github.com/vladtrc/iw4L)) | Maintainer-side: its GSC runtime and bot-AI entry points; its QUIC master could publish heartbeats (inference) | Handoff | **High** (Activision) |
| **Halo CE browser port** | Unknown | Browser (desktop Chrome) | Online rooms advertised at 128 players, untested by its author ([PC Gamer](https://www.pcgamer.com/hardware/you-can-now-play-halo-combat-evolved-in-a-web-browser-and-it-even-has-multiplayer/)) | Only its maintainer can add hooks | Handoff | High (Microsoft; site already taken down) |
| SS HD / BFE via Fusion | Proprietary; official tools | Native | 16-player co-op with dedicated servers; join rules not documented | Lua/Workshop mod plus a local helper | Handoff | Low |
| SS4 | Proprietary; official tools | Native Windows | Listen host only | Lua console script writes and reads text files ([Steam guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)); a local helper relays them (unverified) | Handoff | Low |
| Shatterverse, The Third Encounter | Proprietary | Native/console | P2P / unknown | None | Narrative only | n/a |

Doom earns its place in the second stage through elimination. Among Doom ports, **only the client-server ones can take a player mid-map**. In peer-to-peer ZDoom a new machine knows nothing about the level state, which makes joining mid-game effectively impossible ([forum.zdoom.org](https://forum.zdoom.org/viewtopic.php?p=634755)). Chocolate, Crispy and PrBoom+ advance only when every player's commands have arrived. Of the client-server ports, Odamex is the only one that is GPL-2.0, co-op capable and released in 2025–2026. Zandronum bundles non-commercial pieces that the GPL cannot accommodate ([Zandronum license page](https://wiki.zandronum.com/License), search snippet). UZDoom is GPLv3 and has no network play on the web. Freedoom makes it the only cross-engine front with **free, hostable data**, so nobody needs to own anything to join a rescue.

The catch is the browser client. **No client-server Doom has a browser build**, and the upstream UZDoom browser PR listed networking as a to-do ([PR #848](https://github.com/UZDoom/UZDoom/pull/848)). The route is the one Cloudflare took with Chocolate Doom: swap the UDP socket layer for WebSockets, wrap datagrams with fake addresses, and relay them ([Cloudflare](https://blog.cloudflare.com/doom-multiplayer-workers/)). Our own switch already does the same for SE1 ([multiplayer.md](multiplayer.md)). The server, `odasrv`, can stay native behind a small WebSocket↔UDP bridge, which also keeps rcon and its logs native (inference from the Doom notes).

## Precedents and what to copy

| Precedent | What it does | Copy | Avoid |
|---|---|---|---|
| **Archipelago** | One Python server joins about 80 games over WebSocket JSON; each adapter reports "location checked" and applies "item received" ([protocol](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)) | Message shapes, handshake, resync, per-game data package, tagged broadcast | Its weak identity (slot names) and full trust in clients |
| **APDOOM** | Crispy Doom fork with an embedded C++ Archipelago client, generated per-WAD headers ([repo](https://github.com/Daivuk/apdoom)) | Template for a Doom-side adapter: a C++ client library linked into the port | It exchanges items, not players |
| **Helldivers 2** | Missions add liberation to planets; liberation spreads along supply lines; a human Game Master issues Major Orders ([PC Gamer](https://pcgamer.com/we-have-an-actual-person-with-the-title-of-game-master-a-single-helldivers-2-dev-named-joel-is-pulling-the-strings-on-its-galactic-war-like-an-all-powerful-dandd-dungeon-master-war-will-become-more-and-more-sophisticated-over-time)) | Front graph with supply lines, GM tools, a public read-only war JSON (fans built live maps on the unofficial one, [helldivers-2/api](https://github.com/helldivers-2/api)) | Shipping without a balance kill switch: a liberation bug took the war offline in Feb 2025 ([Windows Central](https://www.windowscentral.com/gaming/helldivers-2-says-the-galactic-war-is-on-hold-because-a-bug-was-making-it-too-easy)) |
| **Foxhole** | Wars end at a victory-point threshold | A hard end condition per war | Open-ended wars: the "Forever War" ran about 71 days until the developer lowered the threshold ([GamesRadar](https://www.gamesradar.com/games/mmo/a-battle-in-this-ww2-mmo-went-on-for-over-2-months-and-killed-9-million-players-so-devs-stepped-in-to-end-it-early-only-for-one-last-hurrah-to-win-it-anyway)) |
| **EVE / Dust 514** | A PS3 shooter shared EVE's backend; EVE players could bombard Dust battles ([Digital Trends](https://digitaltrends.com/gaming/ccp-games-to-shut-servers-for-ps3-fps-dust-514)) | Server-side orchestration: the strategic layer decides where battles spawn ([PlayStation Blog](https://blog.playstation.com/2011/10/28/scaling-the-universe-of-dust-514/)) | Thin stakes (owned districts had little effect on EVE, [Engadget](https://www.engadget.com/2013-11-03-eve-evolved-what-dust-514-should-have-been.html)) and fronts on a platform the main audience doesn't use; shut down in 2016 |
| **Crowd Control** | Outside events trigger in-game effects in 100+ games, via per-game packs, generic packs and a manual "human connector" ([How we work](https://crowdcontrol.live/how-we-work/)) | Tiered adapters: rich effects for deep hooks, generic modifiers or results-only for shallow ones | — |
| **DryxioGTA's GTA multiverse** (Jul 2026) | GTA III, VC and SA in one process sharing one Direct3D device, with portals you can see, walk and shoot through ([PC Gamer](https://pcgamer.com/games/grand-theft-auto/modding-wizard-creates-grand-theft-auto-multiverse-that-lets-players-travel-instantly-between-rockstars-first-three-games-we-got-inter-gta-portals-before-gta-6), [Tom's Hardware](https://www.tomshardware.com/video-games/pc-gaming/ambitious-modder-creates-grand-theft-auto-multiverse-with-real-time-portals-san-andreas-vice-city-and-gta-iii-all-run-simultaneously-with-cross-game-interactions)) | The live-portal experience | Its premise doesn't transfer: one engine family (RenderWare), decomps on both sides, one process |
| **Ready Player Me** | Cross-game avatars; bought by Netflix, services off from 2026-01-31 ([Road to VR](https://roadtovr.com/netflix-acquires-xr-avatar-startup-ready-player-me/)) | — | Depending on a third-party identity service |

Archipelago deserves the closest reading, because its contract is small enough for weak hooks and strong enough for 80 games. An adapter sends **idempotent reports** (`LocationChecks`; duplicates are harmless). It consumes an **indexed stream** (`ReceivedItems` with an index). On a gap it sends `Sync`, and index 0 means the full inventory, replacing the old one. Each game publishes a **data package** mapping names to IDs, with a checksum that clients cache. The handshake carries a version and returns **typed refusal codes**. `Bounce` is a tagged broadcast, and DeathLink (one player dies, every opted-in player dies) is built on it. A shared key-value store applies atomic `add`/`max`/`update` operations. IDs stay within ±(2^53−1), so JavaScript can hold them. Client libraries already exist in Rust, JS/TS, C++ and Lua ([protocol](https://raw.githubusercontent.com/ArchipelagoMW/Archipelago/main/docs/network%20protocol.md)). Every one of these maps onto a war meta-game. A level clear, a race win or a held position is a "check". Reinforcements, supplies and modifiers are "items". An artillery strike from one front onto another is a `Bounce`.

What Archipelago lacks is everything about *live* matches: no heartbeats, no notion of a joinable session, no way to move a player. It also lacks accounts and has no defense against cheating clients. Those are the parts we add.

## The architecture

The design is a hub-and-spoke network. The war server is the only stateful center. Each game sits behind a thin adapter, and the browser hub page runs our games side by side. Every boundary is a socket or `postMessage`, never a link. That matters because SE1 is GPL-2.0-only, iw4L is Apache-2.0 (which cannot be linked into GPLv2 code), nfsu2-web is MIT and the Halo port's license is unknown. The FSF's own FAQ treats programs that talk over sockets and pipes as normally separate programs, unless they exchange "intimate" internal data structures ([GPLv2 FAQ mirror](https://www.southampton.ac.uk/~qs2g22/mirror/www.gnu.org/licenses/old-licenses/gpl-2.0-faq.html)). Hence the rule: the protocol carries generic JSON events, never serialized engine structs.

### War server

The war server is a new Rust crate in the existing `rust/` workspace, next to the switch in [`rust/se1-server`](../rust/se1-server). It extends the roadmap's "War map (persistent front)" item ([features.md](features.md), [bots.md](bots.md)). It holds:

- the front graph, with supply lines and pressure per front (Helldivers-style);
- resources and shared counters (Archipelago `Set` semantics);
- the registry of live matches, fed by heartbeats;
- the distress queue and portal tickets;
- player accounts and per-session tokens;
- a war-end condition and Game Master overrides from day one.

It also publishes a public, read-only war-state JSON with no secrets, so a live map can be built on top.

### Protocol, modeled on Archipelago

Transport is WebSocket with JSON, one list of `{"cmd": ...}` objects per frame, and compression on, as in Archipelago.

| Message | Direction | Purpose | Archipelago analog |
|---|---|---|---|
| `RoomInfo` | server → adapter | War id, protocol version, fronts, data-package checksums | `RoomInfo` |
| `GetDataPackage` / `DataPackage` | both | Per-front tables: outcome IDs, order IDs, loadout schema, checksum | same |
| `Connect` | adapter → server | Front, adapter version, session token, capability tags (`Orders`, `Heartbeat`, `PortalSource`, `PortalTarget`, `Tracker`) | `Connect` |
| `Connected` / `ConnectionRefused` | server → adapter | Typed refusals: `InvalidToken`, `InvalidFront`, `IncompatibleVersion`, `MatchClosed` | same |
| `Outcome` | adapter → server | Idempotent events keyed by `(match_id, event_id)`: level cleared, line held, race won, match lost | `LocationChecks` |
| `Orders` | server → adapter | Indexed stream: next level, difficulty, starting supplies, modifiers. `Sync` on a gap; index 0 replaces all | `ReceivedItems` + `Sync` |
| `Heartbeat` | adapter → server | Every few seconds: match id, map, humans, bots, free slots, joinable flag, pressure | `StatusUpdate`, extended |
| `Bounce` / `Bounced` | both | Tagged broadcast: `Distress`, `Barrage`, `FrontFallen` | `Bounce`, DeathLink |
| `PortalRequest` | source → server | Player, target match, carried stats | new |
| `PortalTicket` | server → source and target | Signed: target endpoint, spawn hint, mapped loadout, expiry, return ticket | new |
| `PortalArrive` / `PortalReturn` | target / source → server | Confirm arrival; come back with a contribution summary | new |
| `Get` / `Set` / `SetNotify` | both | Shared counters with atomic `add` / `max` | same |
| `PrintJSON` | server → adapter | War news, GM messages; unknown types shown as plain text | same |

An adapter that implements only `Connect`, `Outcome` and `Orders` is a valid **handoff front**. `Heartbeat` plus `PortalTarget` makes a front **rescuable**, and `PortalSource` lets it **send rescuers**. This tiering is what lets the Halo or iw4L maintainers join at whatever depth their hooks allow (inference, after Crowd Control).

### Adapters

| Adapter | Where it runs | Hook depth |
|---|---|---|
| **SS1** | Rust mod layer (outcomes, bot possession, portal entity, spawn) through the host API, plus JS in the game page that relays to the hub | Deep: we own it |
| **Odamex** | Sidecar next to `odasrv`: tails the log and polls rcon ([odamex.net](https://odamex.net/wiki/How_to_run_a_server)); ACS ENTER script or a small server patch to place joiners; the bridge checks tickets | Deep, server-side |
| nfsu2-web fork | Its Rust server (race results, free-roam sessions) plus a camera hook in our fork | Medium |
| Fusion / SS4 | A Workshop Lua mod writing a state file and polling a command file; a local helper process relays them to the war server | Shallow, result-only |
| iw4L, Halo | Written by their maintainers against our published spec | Whatever they expose |

Odamex 12.3.0 extended ACS, including client-side scripts ([releases](https://github.com/odamex/odamex/releases)). Which teleport and health functions it implements is not verified. Placing a rescuer near the struggling players can always fall back to a small C++ server patch.

### Hub page and portals

Our web build is not a reusable Emscripten module (`port/CMakeLists.txt` has no `MODULARIZE`), so two games on one page means **one same-origin iframe per game**. The hub page owns the single WebSocket to the war server and talks to each iframe by `postMessage`. Threaded wasm needs COOP/COEP on every page, and each iframe needs `allow="cross-origin-isolated"`, or its threads will not start ([uzdoom-wasm](https://github.com/abootnet/uzdoom-wasm)). Our pages already send the headers.

A live portal is built from three parts:

- **Surface.** The near game textures the portal from the far game's canvas: `copyExternalImageToTexture` on WebGPU, `texImage2D` on WebGL2, or an `ImageBitmap` posted between frames. Our engine runs in a worker and streams GL to the page ([roadmap.md](roadmap.md)), so the far canvas is an ordinary element in a same-origin document. Whether a cross-document copy or a shared WebGPU device works is **unverified**.
- **Camera sync.** The hub converts the player's pose relative to the portal into a camera pose in the far level and sends it to the far game. That needs a camera hook. We have one in SE1, and an nfsu2-web fork would need one.
- **Cost control.** The far game renders at low resolution and low rate, perhaps a quarter of the resolution at 10–15 fps (a design target, not measured), and only while a portal is on screen.

Memory is the binding constraint. Each threaded wasm game holds its own heap, likely 1–2 GB with full data, and the 36 GB development Mac has already crashed from RAM. The proposed budget is one active game plus **at most one live far game**, and no live portals on phones (inference). This is where Doom helps: it is far smaller than SE1, so an SS1 + Doom pair costs much less than TFE + TSE.

### The rescue portal, step by step

1. **Heartbeats.** Every live match sends a `Heartbeat` every few seconds. For SS1 the host sends it, since bots and the server run there ([bots.md](bots.md)). For Doom the `odasrv` sidecar sends it. Pressure is computed from deaths per minute, lives left, objective state and the human/bot ratio.
2. **Distress.** When a match's pressure stays above a threshold, the war server emits `Bounce{tags:["Distress"]}`. It goes to matches whose fronts are linked to the one in trouble, and never to matches that are themselves in trouble.
3. **Eligibility.** The SS1 adapter shows the call only to players who are doing well: high health, no recent deaths, the current area clear. The mod spawns a portal entity at a safe spot, showing a low-rate preview of the target match.
4. **Request.** The player steps in. The adapter sends `PortalRequest` with the target match and the player's current stats.
5. **Ticket.** The war server checks that the target is still joinable and reserves a slot. It then issues a signed `PortalTicket`: endpoint (switch room or Odamex bridge), spawn hint near the struggling players, mapped loadout, an expiry of seconds, and a return ticket.
6. **Bot takeover.** The SS1 host hands the player's Sam to a bot. SE1 is lockstep, so the host's simulation must keep running, and a solo host's iframe goes to background mode (rendering off, simulation on). If the player was a client, the host substitutes a bot. Driving an existing human player entity ("possession") is new work. Today bots join as their own players.
7. **Arrival.** The hub shows or creates the Doom iframe and passes it the ticket. The Doom client connects through the bridge, which validates the ticket. The server places the player at the hint with mapped health, armor and weapons, and the target adapter sends `PortalArrive`.
8. **Help.** The Doom sidecar reports the rescuer's kills, revives and time alive. The war server watches the target's pressure.
9. **Return.** The player goes back through a return portal, or is sent back when the match ends, pressure resolves or the ticket times out. `PortalReturn` carries the contribution summary. The hub switches back, and the bot releases Sam in whatever state the bot left him.
10. **Credit.** The war server relieves the target front and rewards the rescuer and their home front.

Failure paths need equal care. A target that ended or filled up refuses the ticket and the portal closes. A crashed Doom client invalidates nothing, because the return ticket is still valid. A rescuer whose home match ended while away comes back to the lobby, not into a dead world.

**Stat mapping** goes through classes, not exact values. Health and armor map one to one: both games use roughly 100 normal and 200 maximum, but that comes from general knowledge, not the notes. Weapons map by role: melee, pistol, shotgun, double shotgun, hitscan automatic, rockets, energy, superweapon. Ammo maps as a fraction of each game's maximum. The table lives in each front's data package, so adding a front never touches the others.

### Trust and cheating

Archipelago trusts clients, which is fine for co-op randomizers and wrong for a shared war. The rules proposed here are inferences, since the notes found no sourced anti-cheat detail for Helldivers, Foxhole or similar games:

- **Bound every contribution.** Each `Outcome` moves a front by a capped, rate-limited amount per player per hour. No single report can swing the war.
- **Prefer server reports.** Where we run the server (`odasrv`), accept outcomes only from its sidecar, signed with a server key. For iw4L, accept only from its dedicated host.
- **Cross-check lockstep.** In SS1 every client runs the whole simulation, so every client's adapter can report the same outcome with a world-state hash. The war server accepts the majority. A solo host stays self-reported and is weighted lower.
- **Spot-check with demos.** SE1 demos are the recorded action stream, so a disputed result can be re-simulated.
- **Score rescues on effect.** A rescue counts only if the target server confirms arrival and the target's pressure falls.
- **Keep a kill switch.** The GM can freeze the war, as Arrowhead had to.

### Identity

One account lives on the war server: a passkey or OAuth login, with no third-party avatar service, given Ready Player Me's shutdown. The server issues short-lived per-session tokens, which adapters receive through the URL fragment or `postMessage`, never a query string. Each front maps the token to an in-game name. Third-party fronts need only validate tokens against the war server's public key.

## Staged plan

| Stage | Deliverable | Effort (estimate) | Exit test |
|---|---|---|---|
| **1. TFE ↔ TSE live portal** | Hub page, two same-origin iframes, portal surface from the far canvas, camera sync, low-res far rendering, Sam carried across with health, armor and weapons | 1–3 weeks | Walk TFE → TSE → TFE on desktop; peak RSS measured and under budget; the cross-iframe copy method settled |
| **2a. War server + SS1 adapter** | Rust crate; `Connect`/`Outcome`/`Orders`/`Heartbeat`/tickets; TFE and TSE levels as fronts; GM controls; public war JSON | ~2–3 weeks | Matches move the map; orders set level, difficulty and supplies |
| **2b. SS1 → SS1 rescue** | Distress, portal tickets, bot possession, join-in-progress into a second live SS1 match | ~1–2 weeks | A player rescues another room and returns to his own Sam |
| **2c. Doom front** | Odamex client in Emscripten with a WebSocket transport; native `odasrv` plus bridge and sidecar; Freedoom; ACS or patch spawn; stat mapping | ~3–5 weeks (the riskiest piece) | SS1 player rescues a losing Odamex co-op match and comes back |
| **3. nfsu2-web front** | Fork of the MIT snapshot; race results as "supply runs"; camera hook for a later live portal | Weeks to months | Race wins deliver supplies to an SS1 front |
| **4. Handoff fronts** | Published adapter spec and test harness; a Fusion Lua mod plus local helper as our own experiment; invitations to the iw4L and Halo maintainers | Spec: ~1 week; others: theirs | A third-party adapter passes the harness |

Stages 2a–2c together are the "~1–2 months to first playable" estimate. Stage 2b is a deliberate de-risking step. It proves heartbeats, tickets and bot possession on the engine we own before the unproven Odamex browser port, and it ships a playable rescue even if 2c slips.

## Risks and open questions

**Technical unknowns that decide the design.**

- Whether a same-origin hub can copy another iframe's WebGL2/WebGPU canvas every frame, cheaply, and whether a WebGPU device can be shared across documents. This is unverified, and Stage 1 must answer it.
- Two SE1 heaps in one browser; the 36 GB Mac has already crashed.
- Whether our SE1 build accepts a mid-game joiner cleanly. It needs a test before 2b.
- Whether Odamex co-op really admits joiners mid-map, which ACS functions it has for teleport and health, its rcon command list and log format, and whether its SDL2 software renderer still exists. All four went unverified because the Odamex wiki returned 403. Nobody has ported a client-server Doom's networking to the browser.
- Bot "possession" of a human's player entity is new code.

**Third-party fronts.**

- **nfsu2-web** went private, and the hosted nfsu2.xyz is accused of serving EA assets.
- **Halo port:** source and license are unknown, and its site is already down.
- **iw4L:** join-in-progress and a web build are undocumented. It describes itself as incomplete, with missing behavior and desyncs.
- **Fusion:** how SeriousSamFusionArchipelago hooks the game is unchecked. The netcode is undocumented.
- **SS4:** where `strSaveText` may write, and whether its Lua exposes `io` or sockets, are unknown. The main scripting guide has been pulled from Steam.
- **Siberian Mayhem:** modding is unconfirmed.
- **The Third Encounter:** its engine is unannounced.

**Legal.** Risk is highest around Activision. Its October DMCAs covered browser CoD ports and an MW2 decomp, and iw4L sits in that blast radius even with its bring-your-own-install model. Microsoft and EA come next. Risk is lowest for GPL engines with free data (Odamex + Freedoom) and for official Serious Sam games reached through Croteam's own tools. Our side should ship code, a protocol and adapters only. Game data must come from users and be hash-checked. The product name must avoid "Serious Sam" and "Shatterverse", and each third-party front should stay a separate program under its own maintainers. Whether the hub page plus GPL iframes counts as "mere aggregation" is an inference from the FSF FAQ, not legal advice. One more factor sits in the environment: since about 2026-10-27, Claude Code has carried a rule against recreating specific existing games ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). Adapters and a protocol are not recreations, but the rule argues against our building third-party ports ourselves.

**Game design.**

- Small populations mean bots carry the war.
- Every war needs an end condition (Foxhole) and a GM override (Helldivers).
- Cross-front stakes must be visible both ways, or the link feels as thin as Dust 514's.
- Fronts on a device class most players don't own (native iw4L, Windows-only SS4) will be little used. This is Dust 514's platform lesson.

## Conclusion

The research shifts the center of gravity from rendering tricks to protocol. The GTA multiverse is spectacular because one engine family and decomps on every side let it share a Direct3D device. We have that luxury only between TFE and TSE, so live portals are a showcase, not the backbone. The backbone is an Archipelago-shaped war server whose new contribution is **live-session awareness**: heartbeats, distress and signed portal tickets. With those, any game whose maintainers can report outcomes becomes a front, and any game that admits mid-match joiners becomes rescuable.

That reframes who builds what. We build the one complete front (SS1), the one cross-engine rescue target we can legally host end to end (Odamex + Freedoom), and the open spec. The riskier games join, or don't, on their maintainers' terms. Shatterverse's lore hands the project its story for free; it only has to stay unofficial while telling it.
