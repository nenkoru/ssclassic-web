# Popular fan rewrites, reimplementations, decompilations and static recompilations (state as of 2026-11-24)

Method note: GitHub numbers (stars / forks / license / language / created / last push) come from `api.github.com/repos/...` queried on 2026-11-24 (rows marked "API"), or from the `stargazerCount` field of the github.com HTML page when the API rate limit ran out (rows marked "HTML"). "Last push" is the repo's `pushed_at`, which tracks activity better than release dates. Licenses shown as NOASSERTION mean GitHub could not classify a custom or multi-license file. Facts marked "(pre-2026 knowledge, not re-verified)" come from background knowledge and were not re-checked this session; treat them as hypotheses.

## Q1. Which projects gained the most attention in 2025–2026? (catalog grouped by technique)

### Takeaway
Static recompilation is now the hottest technique. recompsoftware.com counts 464 recomps on 2026-11-23, 140 of them for Xbox 360. N64Recomp (8.4k stars) and XenonRecomp (6.7k) proved the method. ReXGlue (Jan 2026) and PS2Recomp (Apr 2025) then turned it into general SDKs. The 2026 standouts are Banjo: Recompiled (Jan), Dusklight, a Twilight Princess decomp port (May; 6.5k stars), and a September–October flood of browser ports. Classic engine reimplementations (OpenRA 17.8k, OpenRCT2 16.6k, DevilutionX 10.0k, OpenTTD 8.5k, OpenMW 6.8k) remain the largest and steadiest projects. All of them were pushed to within the last few days.

### Cited Findings

#### A. Static recompilation: tools and flagship games

| Project | Repo | Original game | Lang / license | Platforms | Stars / activity | Own data? | Notes |
|---|---|---|---|---|---|---|---|
| N64Recomp (tool) | github.com/N64Recomp/N64Recomp | any N64 (MIPS→C) | C++ / MIT | host tool | 8,438★, 482 forks, created 2022-11-16, last push 2026-11-03 (API) | n/a | The basis of the N64 recomp scene. |
| Zelda64Recomp | github.com/Zelda64Recomp/Zelda64Recomp | Majora's Mask (OoT "soon") | C / GPL-3.0 | Win/Linux/Mac | 7,764★, last push 2026-09-25 (API); latest release v1.2.2 on 2025-08-27 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes (ROM) | Built on N64Recomp and the RT64 renderer. Mod support (pre-2026 knowledge, not re-verified). |
| Banjo: Recompiled | (GitHub; exact URL not captured) | Banjo-Kazooie | — | Win/Linux/Mac | 2.2k★, v1.0.2 on 2026-07-31 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes, NA 1.0 ROM ([search summary of Time Extension/PC Gamer coverage](https://www.timeextension.com/news/2026/01/banjo-recompiled-adds-better-frame-rates-widescreen-support-and-more-to-rares-n64-classic-and-you-can-play-it-on-steam-deck)) | Shadow-dropped around 2026-01-26. Led by Mr-Wiseguy with DarioSamo. Over 120 fps, ultrawide, mod support, RT64. States a "very clear No AI" policy ([VGC](https://www.videogameschronicle.com/news/banjo-kazooie-pc-port-decomp-developer-says-ai-generated-pc-ports-are-a-race-to-the-bottom-and-disrespectful/), seen via search snippet only; the fetch returned 403). |
| XenonRecomp (tool) | github.com/hedge-dev/XenonRecomp | any Xbox 360 (PPC→C++) | C++ / MIT | host tool | 6,745★, last push 2025-08-04 (API) | n/a | Activity has moved to ReXGlue (below). |
| Unleashed Recompiled | github.com/hedge-dev/UnleashedRecomp | Sonic Unleashed (X360) | C++ / GPL-3.0 | Win/Linux | 5,412★, last push 2026-11-18 (API); v1.0.3 2025-04-03 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes | The flagship XenonRecomp game. |
| ReXGlue SDK | github.com/rexglue/rexglue-sdk | any Xbox 360 | C++ / NOASSERTION | Win D3D12, Linux Vulkan, x64 ([search summary of docs](https://www.mintlify.com/rexglue/rexglue-sdk)) | 1,320★, 309 forks, created 2026-01-22, last push 2026-11-22 (API) | n/a | "Heavily based" on Xenia, XenonRecomp and Unleashed Recompiled: Xenia's JIT is replaced by AOT, and Xenia's Xenos GPU backend and kernel layer are kept. Its creator goes by "Tom". Described as "in early development" ([Read Only Memo interview, 2026-03-29](https://readonlymemo.com/rexglue-xbox-360-recompilation-interview/)). |
| re:Blue | github.com/zolaware/reblue | Blue Dragon (X360) | C++ / BSD-3-Clause | PC | 943★, created 2026-02-07, last push 2026-11-22 (API) | yes | The first notable ReXGlue game ([Notebookcheck](https://www.notebookcheck.net/ReXGlue-SDK-debut-sparks-Xbox-360-to-PC-ports-for-Blue-Dragon-more.1231442.0.html)). Other ReXGlue targets include Lost Odyssey, Banjo N&B, Ninja Gaiden 2, the Halo 3 beta, Crackdown 2 and Viva Piñata ([Read Only Memo](https://readonlymemo.com/rexglue-xbox-360-recompilation-interview/)). |
| PS2Recomp (tool) | github.com/ran-j/PS2Recomp | any PS2 (R5900→C++) | C++ / GPL-3.0 | host tool | 3,900★, created 2025-04-12, last push 2026-10-23 (API) | n/a | Released PS2 ports built on it include TimeSplitters and KillzoneRecomp. KillzoneRecomp was archived in Nov 2026, and work continues in the "-Extended" fork ([search summary of allrecomps/recompsoftware](https://allrecomps.com/updates/)). |
| xboxrecomp (tool) | github.com/sp00nznet/xboxrecomp | original Xbox (x86→C) | — | Windows | 436★ (HTML) | n/a | Bills itself as able to "turn any Xbox game binary into a native Windows executable" ([repo](https://github.com/sp00nznet/xboxrecomp)). |
| NFSU2Recomp | github.com/TalhaMudo/NFSU2Recomp | NFS Underground 2 PC (x86, D3D9) | C; MIT version of 2026-10-16 | Apple Silicon macOS (ARM64 + Metal) | 299★ (HTML) | yes (v1.2 NA `SPEED2.EXE`) | Its README claims 119 fps and no Wine or emulator ([repo description](https://github.com/TalhaMudo/NFSU2Recomp)). It is the upstream of nfsu2-web and of NFSU2-Revived-Android. |
| Skate 3 native recomp | (recomp.site/p/skate3recomp) | Skate 3 (PS3) | — | PC | 1.8k★, v2.0.2 2026-07-24 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes | The most-starred PS3 recomp. |
| TotK Recomp / LAS Recomp / NX2navi / mkw-recomp | recomp.site pages | Switch / Switch 2 titles (TotK, Link's Awakening, OoT, Mario Kart World) | — | PC | TotK 8.1k★ (v0.5.0 2026-11-22); NX2navi 4.4k★; LAS 2.6k★; mkw-recomp 1.7k★ ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes | Recomps of *current-generation* Nintendo games. They are legally the riskiest category, and their stars rival N64Recomp's. |
| Marathon Recompiled | recomp.site | Sonic 06 / "Marathon" (X360) | — | PC | 985★, v1.0.0 2026-11-14 ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)) | yes | — |

- Scene size: there are 464 recomps in total, broken down as Xbox 360 140, N64 59, original Xbox 47, Switch 35, PS2 28, PS1 23, Windows 22, PS3 16 and Switch 2 14. The site was last updated 2026-11-23 — [recompsoftware.com](https://recompsoftware.com/recompiled-games-list/)
- Another aggregator dates the ReXGlue SDK release to February 2026 and says 33 Xbox 360 games now have Android builds. The search summary flagged these counts as approximate — [allrecomps.com](https://allrecomps.com/updates/), [heldgames list](https://heldgames.com/guides/recompiled-games-list)

#### B. Decompilations and decomp-based source ports

| Project | Repo | Game | Lang / license | Stars / activity | Own data? | Notes |
|---|---|---|---|---|---|---|
| SM64 decomp | github.com/n64decomp/sm64 | Super Mario 64 | C / CC0-1.0 | 8,991★, 1,692 forks; last push 2024-02-04 (API) | yes | Finished. Ports and co-op continue in forks (sm64ex, sm64coopdx; pre-2026 knowledge, not re-verified). |
| Ship of Harkinian | github.com/HarbourMasters/Shipwright | Zelda: Ocarina of Time | C / NOASSERTION | 6,161★, last push 2026-11-23 (API) | yes (ROM → .otr) | Built on the Libultraship runtime. Has a randomizer and mod/texture packs ([Wikipedia](https://en.wikipedia.org/wiki/Ship_of_Harkinian)). |
| 2 Ship 2 Harkinian | github.com/2ship2harkinian/2ship2harkinian (moved from HarbourMasters) | Majora's Mask | C / CC0-1.0 | 2,519★, last push 2026-11-23 (API) | yes | — |
| SpaghettiKart | github.com/HarbourMasters/SpaghettiKart | Mario Kart 64 | C / none | 2,511★, last push 2026-10-22 (API) | yes | MK64 decomp port. |
| Starship | github.com/HarbourMasters/Starship | Star Fox 64 | C / CC0-1.0 | 2,157★, last push 2026-09-15 (API) | yes | — |
| Perfect Dark PC port | github.com/perfect-dark-pc-port/perfect_dark (moved from fgsfdsfgs) | Perfect Dark (N64 FPS) | C / MIT | 2,122★, last push 2026-10-27 (API) | yes | A 2000 FPS. Mouse aim and modern platforms. |
| Twilight Princess decomp | github.com/zeldaret/tp | Zelda: TP (GameCube) | C++ / CC0-1.0 | 2,146★, last push 2026-06-23 (API) | yes | Decompilation completed in 2026 ([GamesRadar](https://www.gamesradar.com/games/the-legend-of-zelda/the-legend-of-zelda-twilight-princess-fans-finally-complete-years-long-mission-to-fully-decompile-the-gamecube-version-of-the-iconic-rpg-and-we-can-only-guess-a-pc-port-isnt-far-off)). |
| Dusklight ("Dusk") | github.com/TwilitRealm/dusklight (redirect from TakaRikka/dusk) | Zelda: TP | — | 6,526★ (HTML) | yes; the SHA-1 of the user's dump is verified | Released May 2026 for Windows, macOS, Linux, iOS and Android. Features include high frame rates, gyro/mouse aim, texture packs and Wii U mirror mode. The decomp effort began in Aug 2020 ([Time Extension](https://timeextension.com/news/2026/05/the-legend-of-zelda-twilight-princess-has-unofficially-been-ported-to-the-pc), [GamingOnLinux](https://gamingonlinux.com/2026/05/dusk-is-a-reverse-engineered-reimplementation-of-the-legend-of-zelda-twilight-princess), [PC Gamer](https://www.pcgamer.com/games/action/an-unofficial-pc-port-of-the-legend-of-zelda-twilight-princess-just-released/)). |
| SSB Melee decomp | github.com/doldecomp/melee | Smash Bros. Melee | C | 2,476★, last push 2026-11-05 (API) | yes | Reached 100% after six years; reportedly "GPT-6 Astra" handled the final stretch (reported 2026-09-09) ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). |
| Halo CE decomp (halo-re) and forks | github.com/halo-re/halo; bnunu/halo-ce-universal; thelinkin3000/SlipstreamCE | Halo: CE (original Xbox) | — | SlipstreamCE 95★ (HTML) | yes (Xbox disc image) | The upstream calls itself a WIP "99.5% byte matching" decomp ([search summary](https://news.cocoloop.cn/en/2026/10/vibe-decompiled-browser-ports/)). SlipstreamCE targets Android Vulkan, Switch deko3d and PS5 ([repo description](https://github.com/thelinkin3000/halo-ce-universal)). |
| Silent Hill 1 PC port | github.com/SlickAmogus/silent-hill-decomp | Silent Hill (PS1) | C / GPL-3.0 | 896★, created 2026-03-06, last push 2026-11-23 (API) | yes | Its description says it was "made with Claude and Psycross" ([repo](https://github.com/SlickAmogus/silent-hill-decomp)). |
| NFS Most Wanted decomp | github.com/dbalatoni13/nfsmw | NFS: Most Wanted (2005) | C++ / CC0-1.0 | 264★, last push 2026-11-15 (API) | yes | A WIP 1:1 decomp of multiple versions. |
| gta-reversed | github.com/gta-reversed/gta-reversed | GTA: San Andreas 1.0 US | C++ / none | 1,350★, last push 2026-11-23 (API) | yes | An incremental reimplementation as a DLL hook. No takedown found. |
| re3 / reVC | github.com/GTAmodding/re3 | GTA III / Vice City | C++ | GitHub returns **HTTP 451** "Unavailable for Legal Reasons" (curl, 2026-11-24) | yes | Take-Two filed a DMCA in Feb 2021 and sued in Sep 2021. Reports of the 2023 outcome conflict (dismissal vs. settlement) ([search summary incl. Wikipedia](https://www.gtaboom.com/take-two-just-killed-the-vice-city-browser-port-3955)). |
| DevilutionX | github.com/diasurgical/DevilutionX | Diablo (1996) | C++ / NOASSERTION | 10,041★, last push 2026-11-23 (API) | yes (DIABDAT.MPQ; shareware is free) | Multiplayer over TCP/ZeroTier (pre-2026 knowledge, not re-verified). |

#### C. Engine reimplementations and source ports of released code

| Project | Repo | Game | Lang / license | Stars / activity | MP / scripting | Notes |
|---|---|---|---|---|---|---|
| OpenRA | github.com/OpenRA/OpenRA | C&C, Red Alert, Dune 2000 | C# / GPL-3.0 | 17,830★, 3,124 forks, last push 2026-11-22 (API) | Lockstep online MP; Lua mission scripting (pre-2026 knowledge, not re-verified) | Ships freeware data downloads. |
| OpenRCT2 | github.com/OpenRCT2/OpenRCT2 | RollerCoaster Tycoon 2 | C++ / GPL-3.0 | 16,603★, last push 2026-11-23 (API) | Client-server MP; JS plugin API (pre-2026 knowledge, not re-verified) | Requires the original data. |
| OpenTTD | github.com/OpenTTD/OpenTTD | Transport Tycoon Deluxe | C++ / GPL-2.0 (NOASSERTION in API) | 8,528★, last push 2026-11-23 (API) | MP; Squirrel GameScript/AI (pre-2026 knowledge, not re-verified) | Free replacement data (OpenGFX), so no purchase is needed. |
| OpenMW | github.com/OpenMW/openmw (main on gitlab.com/OpenMW/openmw) | Morrowind | C++ / GPL-3.0 | 6,779★, last push 2026-11-23 (API) | Lua scripting expanded in 0.50 | 0.50.0 came out 2025-11-07 with gamepad UI and Lua. 0.51.0 followed 2026-05-30 with a new save format, and a 0.52 RC is out ([AlternativeTo](https://alternativeto.net/news/2025/11/openmw-0-50-0-updates-gamepad-controls-expands-lua-scripting-and-adds-polish-support), [GamingOnLinux](https://www.gamingonlinux.com/2026/06/morrowind-game-engine-openmw-0-51-released-with-modding-and-gamepad-improvements/comment_id=296903)). |
| TES3MP | github.com/TES3MP/TES3MP | Morrowind MP | C++ / GPL-3.0 | 878★, **last push 2024-05-14** (API) | Server-authoritative, RakNet, Lua server scripts (pre-2026 knowledge, not re-verified) | Stalled, and no 2026 news was found ([search](https://alternativeto.net/news/2025/11/openmw-0-50-0-updates-gamepad-controls-expands-lua-scripting-and-adds-polish-support)). |
| fheroes2 | github.com/ihhub/fheroes2 | Heroes of M&M II | C++ / GPL-2.0 | 3,735★, last push 2026-11-22 (API) | Hot-seat | Requires the original data (demo data is enough). |
| Augustus | github.com/Keriew/augustus | Caesar III | C / AGPL-3.0 | 2,160★, last push 2026-11-23 (API) | — | A Julius fork with gameplay changes. |
| OpenLara | github.com/XProger/OpenLara | Tomb Raider 1 | C / BSD-2-Clause | 5,161★, last push 2026-07-26 (API) | — | Long-standing WebGL/Emscripten web build (pre-2026 knowledge, not re-verified). |
| Xash3D FWGS | github.com/FWGS/xash3d-fwgs | Half-Life / GoldSrc | C / (none detected) | 2,965★, last push 2026-11-22 (API) | GoldSrc-compatible netcode | The old FWGS/xash3d repo was archived Feb 2026; work continues here ([search summary](https://github.com/FWGS/xash3d-fwgs)). |
| ioquake3 | github.com/ioquake/ioq3 | Quake III Arena | C / GPL-2.0 | 2,877★, last push 2026-11-04 (API) | Q3 client-server | — |
| Ironwail | github.com/andrei-drexler/ironwail | Quake | C / GPL-2.0 | 1,165★, last push 2026-11-17 (API) | — | A high-performance QuakeSpasm fork. |
| UZDoom | github.com/UZDoom/UZDoom | Doom-engine games | C++ / NOASSERTION | 2,357★, created 2025-10-14, last push 2026-11-22 (API) | ZScript/ACS | The GZDoom successor, renamed after a 2025 community split. Its description says "based on GZDoom". |
| dsda-doom | github.com/dsda-org/dsda-doom | Doom | C | 529★, last push 2026-11-23 (API) | demos | A PrBoom+ successor aimed at speedrunning. |
| OldUnreal UT99 patches | github.com/OldUnreal/UnrealTournamentPatches | Unreal Tournament 99 | (binary patches; NOASSERTION) | 1,514★, last push 2026-11-19 (API) | Original UT netcode, UnrealScript | Officially sanctioned by Epic. v469e released Nov 2025 ([GamingOnLinux](https://www.gamingonlinux.com/2025/11/the-classic-unreal-tournament-gets-a-big-upgrade-with-the-v469e-patch-from-oldunreal)). Source is not public. |
| Serious Sam Classic | github.com/tx00100xt/SeriousSamClassic | Serious Sam TFE/TSE | C++ / GPL-2 (Croteam release) | 197★ (HTML) | Original SE1 netcode | Builds for Win/Linux/BSD/macOS/RPi. Based on Croteam's official source ([repo description](https://github.com/tx00100xt/SeriousSamClassic)). |
| OpenUG2 | github.com/whoismept/OpenUG2 | NFS Underground 2 | C | 146★, created 2026-07-09, last push 2026-11-18 (API) | — | Describes itself as "from-scratch reimplementation". |

#### D. Rust / Bevy and other modern-engine rewrites
- **iw4L** (github.com/vladtrc/iw4L): MW2 (2009) runtime in Rust on Bevy and wgpu, licensed Apache-2.0. 1,216★ and 156 forks; created 2026-09-13, last push 2026-11-10 (API) ([repo](https://github.com/vladtrc/iw4L)).
  - Data: needs the user's own MW2 MP install and ships no assets.
  - Rendering: native FastFile readers, and D3D9 SM3 shader bytecode translated to WGSL.
  - Simulation: one simulation step on Bevy ECS shared by server authority, client prediction and replay.
  - Networking: custom UDP plus a QUIC master for browsing and relay; the host simulates the match.
  - Modding: a GSC runtime and bot AI as mod entry points. Asset readers also cover MW3 and Black Ops.
  - The README states "This whole project is written by an LLM". It credits OpenAssetTools, IW4x and KisakCOD as references and Ghidra for inspecting the binaries ([README](https://github.com/vladtrc/iw4L)).
- No other notable Bevy reimplementation of a classic commercial game turned up in search; results were generic Bevy material. Bevy 0.20 shipped in Oct 2026 ([AlternativeTo](https://alternativeto.net/news/2026/10/bevy-0-20-brings-major-rendering-shading-and-ui-enhancements-to-open-source-game-engine/)).
- The Simpsons: Hit & Run browser port was rebuilt in Three.js and ships converted game data ([heise, 2026-10-13](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)).

### Inferences
- In 2026, attention concentrates where a reusable toolchain exists (N64Recomp, XenonRecomp→ReXGlue, PS2Recomp, Libultraship). One tool spawns dozens of per-game repos.
- The largest classic reimplementations (OpenRA, OpenRCT2, OpenTTD, DevilutionX, OpenMW) are mature, steadily active and free of legal trouble. They are lower-risk anchors for a "multiverse" than recomps of current Nintendo titles.
- TES3MP's push date (2024-05) suggests the main OpenMW multiplayer fork is dormant.

### Gaps
- Exact GitHub URLs and licenses for Banjo: Recompiled, Skate 3 recomp, TotK Recomp and Marathon Recompiled were not captured; the aggregator links only to recomp.site.
- Release-tag dates were not collected for most repos because the API rate limit ran out; "last push" is used instead.
- GoldenEye 007 decomp completion is mentioned by [heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html) with no repo or date captured.
- Plutonium (IW5/T6/T4 clients) and AlterWare: no 2026 information found; searches returned only Modern Warfare 4 news.

## Q2. Which run in the browser (wasm), and how?

### Takeaway
The 2026 browser wave runs on two stacks. The newer one is ahead-of-time recompiled C → WebAssembly with WebGPU, as in nfsu2-web (wasi-sdk, WebGPU, Web Audio, worker threads sharing one memory). The older one is Emscripten + WebGL, used by DOS.Zone, Xash3D and the Quake/Doom ports. The most-covered ports host the game data themselves despite "bring your own copy" wording, and these are the ones drawing DMCAs.

### Cited Findings
- **nfsu2-web** (github.com/th0mk/nfsu2-web) is an MIT fork of NFSU2Recomp's 2026-10-16 version. 1,212★, 290 forks; created 2026-10-19 and **archived 2026-11-09**, with development continuing privately (API, [README](https://github.com/th0mk/nfsu2-web)).
  - Pipeline: a Python + Capstone lifter turns every function of `SPEED2.EXE` into C; that C is compiled with **wasi-sdk 34** to `nfsu2.wasm`.
  - Runtime: Win32, D3D9, DirectSound and DirectInput are reimplemented. D3D9 runs on **WebGPU**, sound on an AudioWorklet, and the game's threads run as workers on one shared memory.
  - Server: a Rust server serves the page and the module, plus the *user's* game folder, and connects players for free-roam multiplayer.
  - Requirements: an exact `SPEED2.EXE` v1.2 NA (SHA-256 given in the README); Chrome, or Firefox with WebGPU.
  - The archive notice cites people "present[ing] this work... as their own" as the reason for going private.
- The hosted site nfsu2.xyz offers online races and shared free roam at up to 120 fps. Funding is donations, and a legal contact is listed ([TechBytes, 2026-11-07](https://techbytes.app/posts/need-for-speed-underground-2-online-in-the-browser/)). On HN (1,181 points, 293 comments), commenters said the site hosts assets the operators may not own, and Linux Chromium users needed the "unsafe WebGPU" flag ([HN](https://news.ycombinator.com/item?id=50403052)). This conflicts with the README's "you bring your own copy", which describes the self-hosted build.
- **NFSU2-Revived-Android** (github.com/mininxd/NFSU2-Revived-Android): 83★, created 2026-10-25 (API). A native ARM64 port with Vulkan; 27,742 x86 functions were recompiled to C99. Needs the user's own PC copy ([README via search](https://raw.githubusercontent.com/mininxd/nfsu2-revived-android/HEAD/README.md)).
- **Halo: CE browser port** by Mitchell Hynes appeared at mitchellhynes.com/halo in late Sep 2026.
  - Built on the Halo CE decomp and compiled to WebAssembly; runs in desktop Chrome, not on mobile.
  - Split-screen co-op; online rooms advertised at 128 players, a scale Hynes says is untested ([search summary of PC Gamer / TechPowerUp, 2026-09-30](https://www.pcgamer.com/hardware/you-can-now-play-halo-combat-evolved-in-a-web-browser-and-it-even-has-multiplayer/)).
  - Requires selecting the user's own Xbox disc image ([heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)).
- **Serious Sam TFE/TSE browser multiplayer by DOS.Zone** (dos.zone/mp/index.html?lobby=ssam), reported 2026-10-14: co-op for up to 16 players plus Scorematch and Fragmatch; players host public or private servers ([3DNews](https://3dnews.ru/1149935)). The toolchain was not stated. DOS.Zone's earlier ports (revcDOS) used Emscripten. An older single-player SE1 web port by Martin Mullins exists, without MP ([blog](https://martinmullins.github.io/blog)).
- **Vice City / GTA III in the browser:** DOS.Zone's revcDOS is reVC compiled to wasm. It was taken down in Dec 2025 after a notice from Ebrand acting for Take-Two, then relaunched in 2026 by "Quenq". One report mentions 64-player MP ([gtaboom](https://www.gtaboom.com/take-two-just-killed-the-vice-city-browser-port-3955), [libertycity.net](https://libertycity.net/news/gta-vice-city/10429-vice-city-is-back-in-the-browser-this.html)).
- **Xash3D in the browser:** yohimik/webxash3d-fwgs builds FWGS to wasm with Emscripten and ships Docker images for HL and CS 1.6 web servers. The npm packages are `xash3d-fwgs`, `hlsdk-portable` and `cs16-client`. webXash requires your own files ([search summary](https://github.com/yohimik/webxash3d-fwgs/wiki)).
- **Quake/Doom:** GMH-Code Quake-WASM and Quake2-WASM (WebGL 1/2 plus a software renderer), wasm-doom (Chocolate/Crispy based), d3wasm (Doom 3, Emscripten + WebGL). No 2026 WebGPU Quake or Doom source port was found ([search summary](https://www.github.com/GMH-Code/Quake-WASM)).
- A Half-Life 2 browser port runs at "over 100 FPS" with WebGL 2, save states and a console ([Tom's Hardware headline](https://www.tomshardware.com/video-games/pc-gaming/you-can-now-play-half-life-2-right-inside-your-browser-at-over-100-fps-with-save-states-and-console-support-ingenious-port-recreates-the-entire-game-campaign-using-webgl-2)). The body was not retrievable, so technique and data model are unknown.
- **Other browser recomps** listed by recompsoftware: NCAA 10 PSP Web Recomp (player-20261020), IsaacRecomp (Flash, v1.7.0 2026-11-16), and Cricket 07 in the browser (WIP) ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)).

### Inferences
- nfsu2-web is the clearest reference architecture for a browser static recompilation. It lifts x86 to C, compiles with wasi-sdk rather than Emscripten, and runs on WebGPU with a Rust relay server. A Serious Sam web port has source code, so it would compile SE1 directly with Emscripten or wasi-sdk rather than recompile a binary.
- Persistent MP lobbies (DOS.Zone hub, nfsu2.xyz, Halo rooms) are now expected features of browser ports. The relay/lobby server is the shared infrastructure a multiverse could centralize.

### Gaps
- Whether nfsu2.xyz streams EA assets from its own servers or only from the user's folder is disputed: HN commenters vs. the README.
- The DOS.Zone Serious Sam toolchain, whether it requires game data, and its netcode are unknown.

## Q3. Active rewrites of 1998–2012 shooters and racing games

### Takeaway
Shooters: Quake, Doom, HL, UT99 and Serious Sam have stable, licensed source-port ecosystems. The CoD and Halo projects are the hot and legally exposed ones. Activision issued DMCAs against browser CoD ports (Oct 2026), and the community clients (X Labs, BOIII) were already taken down earlier. Racing: NFSU2 is the center of activity (NFSU2Recomp → nfsu2-web, Android, OpenUG2), and NFS MW has a decomp. GTA III and VC (re3) remain blocked, while GTA SA's gta-reversed is active. No Max Payne rewrite was found.

### Cited Findings
- **CoD MW2 (2009):**
  - IW4x client (github.com/iw4x/iw4x-client): GPL-3.0, 365★, last push 2026-11-22 (API).
  - iw4L (Rust/Bevy; see Q1-D).
  - Maurice Heumann (momo5502) posted on 2026-09-30 a "GenAI-assisted" MW2 decompilation using "17 agents working in parallel" and claiming it was "fully playable". Activision had the clip disabled, and the hosting became unreachable ([Kotaku, 2026-10-03](https://kotaku.com/activision-and-bethesda-crackdown-on-genai-mw2-and-fallout-projects-2000739580)).
  - "Open Victor Zulu", a browser MW2 MP recreation, was reportedly removed by DMCA on 2026-10-17 ([search summary](https://www.gamebrief.net/blog/call-of-duty-browser-game-takedowns-2026)).
- **CoD Black Ops / BO2:** Luckey Faraday's AI-built browser ports ("Claude of Duty: Vibe Slops II", BO2 MP; "Kino der Toten", Zombies) were hit by Activision DMCAs around 2026-10-10 ([TweakTown](https://www.tweaktown.com/news/114029/activision-takes-down-ai-made-black-ops-2-browser-ports/index.html), [gameriv](https://gameriv.com/activision-reportedly-takes-down-call-of-duty-browser-projects-with-dmca-notice/)). Earlier takedowns of X Labs and BOIII are referenced by [Gameranx](https://gameranx.com/updates/id/466701/article/activision-takes-down-call-of-duty-fan-clients-x-labs-boiii-and-more/) (date not captured).
- **Halo CE:** the decomp, browser port, and native Android/Switch/PS5 forks (Q1-B, Q2). No DMCA from Microsoft was found in GitHub's DMCA repo as of Sep–Oct 2026 ([search summary](https://www.digitalcitizen.life/halo-combat-evolved-browser-port-no-game-data/); [PCGuide](https://www.pcguide.com/news/halo-ce-in-your-browser-with-splitscreen-co-op-and-128-player-multiplayer-gets-taken-down-but-its-still-playable/) reports the site itself was taken down while mirrors work).
- **Half-Life:** Xash3D FWGS plus web builds (Q1-C, Q2). **Quake:** ioq3, Ironwail, and wasm ports. **Doom:** UZDoom and dsda-doom. **UT99:** OldUnreal 469e. **Serious Sam:** SeriousSamClassic and the DOS.Zone browser MP. **Perfect Dark:** PC port, 2,122★.
- **NFS:**
  - NFSU2Recomp (macOS ARM64) → nfsu2-web (browser, archived and private since 2026-11-09) and NFSU2-Revived-Android.
  - OpenUG2 (from-scratch, 146★).
  - dbalatoni13/nfsmw decomp (264★) and an nfsug decomp ([search](https://raw.githubusercontent.com/dbalatoni13/nfsug/HEAD/README.md)).
  - motor-dev/nfs-recompiled (NFS II SE / NFS III recomp, 95★, last push 2026-03-04; its README calls itself largely AI-generated) ([search summary](https://raw.githubusercontent.com/motor-dev/nfs-recompiled/HEAD/README.md)).
  - PS2 NFS Hot Pursuit 2 and NFS Carbon native ports ([GameGPU](https://en.gamegpu.com/news/igry/need-for-speed-hot-pursuit-2-s-playstation-2-poluchila-nativnyj-port-dlya-pk)).
- **Other racing:** Forza Motorsport 4 has an experimental X360 recomp that compiles from your own Disc 1 ([search summary](https://allrecomps.com/recently-added/)). MK64 has SpaghettiKart.
- **GTA:** re3 shows HTTP 451 on GitHub (verified 2026-11-24). gta-reversed (SA) is active with 1,350★. Vice City Online, a multiplayer project, has appeared; its survival is uncertain ([search summary](https://libertycity.net/news/gta-vice-city/10429-vice-city-is-back-in-the-browser-this.html)).

### Inferences
- Activision is the most aggressive rights holder against CoD fan projects. Using real CoD assets in a hosted browser build is the highest-risk pattern. iw4L's "bring your own install, no assets" model is the defensive pattern, but MW2-adjacent hosting still drew takedowns.

### Gaps
- No Max Payne decomp, recomp or reimplementation was found; the searches did not cover it specifically.
- Plutonium and IW4x 2026 status beyond repo activity is unknown.
- No Unreal (UE1/UE2) open-source reimplementation beyond OldUnreal's closed patches was searched for.

## Q4. Is there an LLM-assisted wave of rewrites, and how good are they?

### Takeaway
Yes, and it is the 2026 story. A community tracker listed 273 AI-assisted game RE projects on 2026-10-30, 226 crediting Claude. Mass media covered "vibe-coded" browser ports of Halo, Vice City, Black Ops, Skate 3 and Simpsons: Hit & Run after Claude Opus 5.5 launched on 2026-09-22. Quality ranges from "borderline flawless" (Kotaku, anecdotal) to explicitly incomplete (iw4L: "expect missing behavior, bugs and desyncs"). Most are built on human-made decomps or recomp toolchains, which has caused friction with those authors. They also drew a wave of DMCAs and, around 2026-10-27, a Claude Code rule against recreating specific games.

### Cited Findings
- Kotaku's 2026-10-09 article says hundreds of browser ports appeared "in the past couple of weeks". It credits Claude Opus 5.5 and calls some "borderline flawless", e.g. Simpsons at 240 fps and Halo online with low ping. No repos were named ([Kotaku](https://kotaku.com/we-might-be-cooked-as-these-vibe-coded-web-browser-ports-of-halo-the-simpsons-hit-and-run-and-gta-vice-city-seem-to-work-perfectly-2000743300)).
- heise (2026-10-13) says it is "often unclear how much AI was involved". The Halo port builds on prior human decomp work ([heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)).
- Tracker counts (2026-10-30): 273 projects, of which 226 credit Claude and 5 use open or local models ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)).
- Benchmark: Opus 5.5 reportedly scored a 98.4% mean byte match across five N64 targets (three perfect) in Sep 2026, but only ~18.5% on behavioral reconstruction ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). The primary benchmark source was not found.
- In a Fable 2 recomp, an open local model got the game running in about an hour, followed by "much human trial and error" ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)).
- Self-declared AI projects:
  - iw4L ("whole project is written by an LLM").
  - Silent Hill PC port ("made with Claude"; the README credits Opus 4.6/4.7 and says changes are human-reviewed).
  - A Wave Race 64 recomp ("every line... written by Claude through Claude Code").
  - nfs-recompiled ("largely AI-generated").
  - An AI Banjo-Tooie recomp.
  - Sources: [iw4L](https://github.com/vladtrc/iw4L), [silent-hill-decomp](https://github.com/SlickAmogus/silent-hill-decomp), [search summary](https://pasqualepillitteri.it/en/news/22405/claude-opus-5-5-decompiles-games-browser-ports), [heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html).
- Pushback from human authors: DarioSamo (Banjo: Recompiled) called the AI Banjo-Tooie port disrespectful and "a race to the bottom" ([VGC headline](https://www.videogameschronicle.com/news/banjo-kazooie-pc-port-decomp-developer-says-ai-generated-pc-ports-are-a-race-to-the-bottom-and-disrespectful/)). Zelda64Recomp and Banjo: Recompiled hold no-AI policies. mGBA, SDL and QEMU restrict AI contributions; shadPS4 allows disclosed AI help ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)). nfsu2-web went private, citing copycats ([README](https://github.com/th0mk/nfsu2-web)).
- Policy: around 2026-10-27, Claude Code began receiving server-delivered text: "Don't build a recreation of a specific existing game." As of 2026-10-30, no decomp or recomp project had reported a refusal under it ([heldgames](https://heldgames.com/guides/ai-game-recreation-rule-decomp-scene)).
- Takedowns tied to AI projects:
  - Bethesda sent a C&D over *Fallout: New York*; the author abandoned it on 2026-10-01 ([Kotaku](https://kotaku.com/activision-and-bethesda-crackdown-on-genai-mw2-and-fallout-projects-2000739580)).
  - Activision acted against the MW2 decomp clip (Oct 2026) and the BO/BO2 browser ports (~2026-10-10) ([TweakTown](https://www.tweaktown.com/news/114029/activision-takes-down-ai-made-black-ops-2-browser-ports/index.html)).
  - Oliver Sauter's Claude-coded multiplayer SM64 port was partly disabled after a copyright-owner report ([Kotaku via search](https://kotaku.com/the-vibe-coders-have-come-for-nintendo-and-obviously-this-wont-end-well-2000745258)).

### Inferences
- LLMs are strongest where a matching target exists (byte-exact decomp, recomp glue, API reimplementation) and weakest at behavioral fidelity. That fits iw4L's self-reported desyncs and the 18.5% behavioral score.
- For a multiverse, AI-written ports are viable, but provenance notes (like iw4L's docs/provenance) and BYO-data loading are what distinguish projects that survive from those taken down.

### Gaps
- No independent, systematic quality evaluation of AI ports exists beyond anecdotes and the one secondhand benchmark.
- Two pages were unavailable: the TechSpot "Decompilation on Steroids" article (403) and the digitalcitizen Halo article (403).

## Q5. What trends stand out?

### Takeaway
There are five trends. (1) Recompilation has become general-purpose SDKs and launchers. (2) The target generation is moving up: Xbox 360, PS3 and even Switch/Switch 2 now lead. (3) Browser ports have shifted to wasm + WebGPU with built-in online lobbies. (4) AI-written ports flood in, followed by DMCAs and AI-use policies. (5) "Bring your own data" with hash-checked loaders is now the standard legal posture.

### Cited Findings
- Recomp tools are becoming general: N64Recomp → XenonRecomp → ReXGlue (an SDK built on Xenia) → PS2Recomp → xboxrecomp ("any Xbox game binary"). N64RecompLauncher lists ReXGlue games as "custom games" ([Read Only Memo](https://readonlymemo.com/rexglue-xbox-360-recompilation-interview/), [xboxrecomp](https://github.com/sp00nznet/xboxrecomp)).
- Xbox 360 now leads recomp counts at 140 of 464. Switch plus Switch 2 add 49. TotK Recomp (8.1k★) is the most-starred recomp on the list ([recompsoftware](https://recompsoftware.com/recompiled-games-list/)).
- x86 PC games are now recomp targets too (NFSU2 → ARM64/Metal, wasm and Android), with the method explicitly credited to N64Recomp and XenonRecomp ([nfsu2-web README](https://github.com/th0mk/nfsu2-web)).
- BYO-data loaders:
  - Dusklight checks the dump's SHA-1 ([search summary](https://timeextension.com/news/2026/05/the-legend-of-zelda-twilight-princess-has-unofficially-been-ported-to-the-pc)).
  - nfsu2-web requires an exact SHA-256 of `SPEED2.EXE` ([README](https://github.com/th0mk/nfsu2-web)).
  - iw4L auto-finds the user's Steam MW2 install ([README](https://github.com/vladtrc/iw4L)).
  - The Halo web port asks for an Xbox ISO ([heise](https://www.heise.de/en/news/Halo-Vice-City-Black-Ops-AI-ports-of-games-run-in-the-browser-11485764.html)).
- Projects going closed or archived after copycats or legal pressure: nfsu2-web went private on 2026-11-09 and KillzoneRecomp was archived in Nov 2026 ([README](https://github.com/th0mk/nfsu2-web), [search summary](https://allrecomps.com/updates/)). re3 is still under HTTP 451.

### Inferences
- A multiverse built on these ports should copy the BYO-data + hash-check pattern and keep shared infrastructure (lobby/relay, identity) separate from any game assets. Hosted asset streaming is the factor most correlated with takedowns.
- iw4L (Rust/Bevy/wgpu) and nfsu2-web (C→wasm/WebGPU) already share WebGPU-class rendering: wgpu targets WebGPU. That is a plausible common denominator for a browser-first multiverse.

### Gaps
- No primary statistics exist on how many browser ports were taken down versus how many survive.
