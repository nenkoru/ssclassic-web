# Serious Sam 4, Siberian Mayhem and every Serious Sam game since 2020 (state as of 2026-11-24)

Research date: 2026-11-24. Facts carry their date where it matters. A "search snippet" tag means the claim came from a search-result summary and the page itself was not opened. Treat those as lower confidence.

Quick map of post-2020 titles:

| Title | Release | Developer | Engine | Platforms | Multiplayer |
|---|---|---|---|---|---|
| Serious Sam 4 | 2020-09-24 (PC, Stadia); 2021-12-07 (PS5, XSX) | Croteam | Serious Engine 4 (in-house) | Win, Stadia, PS5, XSX | 4-player online co-op |
| Serious Sam: Siberian Mayhem | 2022-01-25 (PC); 2022-10-06 (PS5, XSX) | Timelock Studio, supervised by Croteam | Serious Engine 4 (search snippet: "4.5") | Win, PS5, XSX | Single-player only per Wikipedia |
| Serious Sam: Tormental | EA 2019-04-02; 1.0 2022-04-08 | Gungrounds | Unity | Win | n/a |
| Serious Sam: Shatterverse | 2026-08-31 | Behaviour Interactive | Unreal Engine | Win, PS5, XSX, Xbox Cloud | 1–5 co-op, cross-platform, P2P |
| Serious Sam: The Third Encounter | TBA, announced 2026-10-22, "early development" | Croteam | Not stated | Windows (Steam) | Online co-op and split screen |

## 1. Serious Sam 4 (2020) and Siberian Mayhem (2022): platforms, patches, engine, modding, multiplayer

### Takeaway
SS4 is Croteam's last in-house Serious Engine game. It has DX11, DX12 and Vulkan renderers, "Legion System" hordes, 4-player co-op, and official Lua modding through Serious Editor 2021 with Steam Workshop. It has no official versus mode and no released dedicated server. Siberian Mayhem is a standalone expansion on the same tech. Wikipedia lists it as single-player only, and it was built by ex-modders under Croteam's supervision.

### Cited Findings
**Releases and platforms**
- SS4 came out on Windows and Stadia on 24 Sep 2020, delayed from an August 2020 window. PS5 and Xbox Series X/S followed on 7 Dec 2021, and the Xbox version shipped on Game Pass. Development began in Oct 2012. The game was announced in Apr 2018 as "Planet Badass", a subtitle dropped in May 2020. Croteam said PS4 and Xbox One versions were never planned. — [Wikipedia: Serious Sam 4](https://en.wikipedia.org/wiki/Serious_Sam_4)
- SS4 reception: Metacritic 68 (PC), 65 (PS5) and 57 (XSX). OpenCritic shows 38% of critics recommend it. — [Wikipedia: Serious Sam 4](https://en.wikipedia.org/wiki/Serious_Sam_4)
- Steam page snapshot (Nov 2026): developer Croteam, publisher Devolver Digital. Features: Single-player, Online Co-op (up to 4 players), Steam Workshop, Steam Cloud, Achievements and Trading Cards. PvP and cross-platform play are not listed. User reviews: 82% of 5,142 English reviews positive ("Very Positive"), and 89% of the 68 reviews in the last 30 days. Requirements: Win10 64-bit, DirectX 11 listed, 42 GB, minimum 4-core 2.5 GHz, 8 GB RAM, GTX 780/970/1050 or Radeon 7950/280/470 with 3 GB VRAM. — [Steam: Serious Sam 4](https://store.steampowered.com/app/257420/Serious_Sam_4/)
- The Steam store markets the "Legion System" as bringing "battlefields teeming with thousands of enemies" but gives no exact number. Pre-release coverage (Kotaku and PC Gamer, 2018 and 2020) cited a target of 100,000 enemies on screen. Wikipedia does not confirm the shipped game reached it. — [Steam](https://store.steampowered.com/app/257420/Serious_Sam_4/); [Wikipedia](https://en.wikipedia.org/wiki/Serious_Sam_4)

**Engine and graphics APIs**
- SS4 offers DirectX 11, DirectX 12 and Vulkan, and OpenGL is no longer offered (ComputerBase, Oct 2020). DSOGaming found no performance difference between DX12 and Vulkan. PC Games Hardware found Vulkan the most even of the three, DX12 the slowest, and DX11 the best frametimes. The game uses no API-specific features such as ray tracing. — search snippets: [ComputerBase 2020-10](https://www.computerbase.de/2020-10/serious-sam-4-benchmark-test/), [DSOGaming perf analysis](https://www.dsogaming.com/pc-performance-analyses/serious-sam-4-pc-performance-analysis), [PCGH](https://www.pcgameshardware.de/Serious-Sam-4-Spiel-32391/Specials/Release-Test-Review-CPU-GPU-Benchmark-1358330/)
- Croteam announced Vulkan for SS4 as early as Jan 2016 and said OpenGL would also stay. The later ComputerBase test shows OpenGL was in fact dropped. — search snippet: [GamingOnLinux 2016-01](https://www.gamingonlinux.com/2016/01/talos-principle-serious-sam-3-getting-vulkan-updates-serious-sam-4-will-be-on-a-much-improved-engine/page=2)
- Siberian Mayhem runs on Serious Engine 4, which gamegpu calls version 4.5, with DX11 and Vulkan as the main APIs. The Fandom wiki says it "may be the last game powered by the engine". — search snippets: [gamegpu](https://en.gamegpu.com/test-gpu/action-fps-tps/serious-sam-siberian-mayhem-test-gpu-cpu), [DSOGaming](https://dsogaming.com/?p=161506), [Serious Sam Wiki](https://serioussam.fandom.com/wiki/Serious_Engine)

**Modding: Serious Editor, Workshop and Lua**
- In 2021, for the series' 20th anniversary, Croteam released "Serious Editor 2021", a suite of official modding tools with full Steam Workshop integration. It adds a new terrain editor, improved battle systems, vehicle support and "upgraded scripting tools". The editor is free to SS4 owners and is the same toolkit Croteam used to build the game. — [EGM](https://egmnow.com/serious-sam-4-gets-official-modding-tools-and-steam-workshop-support/); search snippets: [PC Gamer](https://www.pcgamer.com/serious-sam-4-dual-wields-official-modding-and-steam-workshop-support/), [TechRaptor](https://techraptor.net/gaming/news/serious-sam-4-modding-launches-to-celebrate-20th-anniversary)
- Lua scripting model, from NSKuber's "SS4 Scripting Guide" (posted 2 Apr 2021, updated 30 Jun 2021; as of Nov 2026 the page says it was removed for violating Community guidelines and is visible only to its author):
  - **World scripts** run either from a script entity in a level or from `.lua` files in `Content/SeriousSamX/Scripts/CustomWorldScripts/`, which run on every level, including menu levels.
  - **Console scripts** run outside levels, even while the game is paused; the guide calls the console "a big Lua interpreter". Startup scripts go in `Content/SeriousSam4/Scripts/Startup/`.
  - **Coroutines and events:** `RunAsync`, `Wait`, `SignalEvent` and `CustomEvent`, plus the built-in `OnStep` and `EntitySpawned` events. There is a per-frame command limit, and scripts effectively use one CPU core.
  - **Networking (game-internal only):** `worldGlobals.CreateRPC(side, reliability, name, fn)` creates RPCs. Arguments are limited to entity handles, strings, numbers and vectors/quaternions, with no tables. `RegisterNetworkDescriptor` provides synced state, and `worldInfo:NetIsHost()` checks the host.
  - **Persistence:** session values via `GetGameInfo():SetSessionValue`, and `plpSet/GetProfile*` (SS4 only), which persists across launches.
  - **File I/O:** console-only functions include `strLoadText_unsigned` and `strSaveText` for text files, `dofile`, `gamStart`, and reading and writing cvars. World scripts cannot load or save text files.
  - **Not documented:** the guide mentions no `io`, `os`, `socket` or `http` library.
  - Source: [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)
- Community Workshop content includes a "16 player co-op" mod (linked Mar 2021) and a "Versus Restored" mod that brings Fusion's versus modes back. The Versus Restored author notes that "Sam 4 comes without a lot of the VS groundwork that was in Fusion". — [Steam discussion](https://steamcommunity.com/app/257420/discussions/0/2840039920169084552/); search snippet on Versus Restored, no URL opened

**Dedicated servers and versus**
- Croteam staff on 24–25 Sep 2020 wrote: "No current plans or ETA". They added, "We do have a repository for dedicated servers, but they haven't been worked on since forever". The reason given was that the 4-player limit made dedicated servers less relevant at launch. The thread's last post is dated 9 Apr 2021, and nobody in it mentions RCON. — [Steam discussion "Dedicated Server Files"](https://steamcommunity.com/app/257420/discussions/0/2840039920169084552/)
- No search (Nov 2026) turned up an official SS4 versus mode or dedicated-server release. — [search results summary; Steam discussion above](https://steamcommunity.com/app/257420/discussions/0/2840039920169084552/)

**Siberian Mayhem**
- Developed by Timelock Studio with Croteam supervising and published by Devolver Digital. Timelock was a Russian group of long-time Serious Sam modders who met as SS4 testers. In Sep 2020 they pitched Croteam an 80-page design document, which was greenlit as a 3-level DLC and grew into a standalone expansion; the studio was founded in 2021. Releases: Windows (Steam and GOG) on 25 Jan 2022, PS5 and XSX on 6 Oct 2022. Wikipedia's infobox lists it as single-player only. Metacritic 70 from 25 critics. — [Wikipedia: Siberian Mayhem](https://en.wikipedia.org/wiki/Serious_Sam:_Siberian_Mayhem)

### Inferences
- SS4's Lua is a sandbox that reaches outside the game only through console-script text-file read/write (`strSaveText`/`strLoadText_unsigned`). An external bridge would therefore most plausibly use file polling: the game writes a state file and a sidecar process reads it and writes commands back. That is unverified in practice.
- Siberian Mayhem shows the official route from fan project to product: modders, then testers, then a supervised standalone release on Croteam tech.
- SS4 has no dedicated server, so there is no RCON surface. Any "server" for SS4 co-op is a listen host running the game client.

### Gaps
- Exact last SS4 and Siberian Mayhem patch dates: SteamDB and PCGamingWiki both returned 403. Check the SteamDB patchnotes page manually.
- Current SS4 player counts (SteamDB/SteamCharts) were not retrieved.
- Whether Siberian Mayhem supports Serious Editor, Workshop or co-op through patches: Wikipedia says single-player only, but I found no confirmation of later co-op patches or tools.
- Which standard Lua libraries are exposed: the guide doesn't list them. No source confirms sockets or HTTP are absent, though nothing suggests they exist.
- The SS4 Steam page lists only DX11 in its requirements, despite in-game DX12 and Vulkan. I found no post-2020 source on whether any API was removed by later patches.

## 2. Serious Sam: Shatterverse (2026): what it is, story, developer, engine, reception, status

### Takeaway
Shatterverse is a 1–5 player co-op roguelite FPS built in Unreal Engine by Behaviour Interactive (Dead by Daylight), published by Devolver and made with Croteam's blessing. It released on 31 Aug 2026 to poor reviews. Its premise is literally a Serious Sam multiverse: Mental has shattered the walls between universes, and Sams from many dimensions team up to repair the "Shatterverse".

### Cited Findings
- **Announcement:** revealed 26 Mar 2026 at the Xbox Partner Preview, during the series' 25th anniversary. Developer Behaviour Interactive, "with the blessing of Croteam"; publisher Devolver Digital; producer Nic Duchesne; John Dick returns as Sam's voice. Platforms: PS5, Windows, Xbox Series X/S and Xbox Cloud Gaming. Released 31 Aug 2026. Metacritic gives the PC version 50, and OpenCritic shows 21% of critics recommend it. — [Wikipedia: Shatterverse](https://en.wikipedia.org/wiki/Serious_Sam:_Shatterverse) (last edited 20 Nov 2026); [Gematsu 2026-08 launch date](https://www.gematsu.com/2026/08/serious-sam-shatterverse-launches-august-31)
- **Story, per the press release:** "Mental... has fractured the walls between universes"; "Sams from multiple dimensions must work together to repair the Shatterverse". Players "travel across shifting universes to finish battles other Sams couldn't" and fight "alongside alternate versions of themselves", with the goal of defeating Mental's five lieutenants. Quote from Davor Hunski (Croteam co-creator): "Seeing Shatterverse come to life is a really big moment for us". — [Devolver press release via GamesPress](https://www.gamespress.com/Devolver-Digital-Announces-Serious-Sam-Shatterverse-a-Co-operative-FPS)
- **Xbox Wire (Nic Duchesne, Game Director, 31 Aug 2026):**
  - Devolver went looking for a developer, and Behaviour took the project.
  - "Our first task was to recreate the feel of Serious Sam in Unreal Engine", taking The First and Second Encounter as the main inspirations.
  - The villain is "Uber Mental". Players belong to "the Serious Program, a multidimensional force"; Mental hunts Sam across realities and "in many timelines he has already won".
  - Multiplayer is peer-to-peer, not dedicated servers, and there is an offline solo mode. The game is designed not to be shut down.
  - Expansions and DLC are planned.
  - Price: $19.99 list. Xbox Play Anywhere.
  - No specific Sam variants are named.
  - Source: [Xbox Wire](https://news.xbox.com/en-us/2026/08/31/serious-sam-shatterverse/)
- **Steam page (Nov 2026 snapshot):** release 31 Aug 2026; developer Behaviour Interactive Inc.; co-op for 1–5 players; Cross-Platform Multiplayer; third-party EULA; no Workshop listed. Requirements: DX12, 10 GB, minimum GTX 1050 Ti or RX 560X. User reviews are "Mixed": 49% of 767 all-time, 50% of 36 recent. Price shown as $10.99, 20% off to $8.79 until 30 Nov. This conflicts with Xbox's $19.99 list price and may be a regional or permanent price cut; unverified. — [Steam: Shatterverse](https://store.steampowered.com/app/2067210/Serious_Sam_Shatterverse/)
- **Player counts (Nov 2026, third-party trackers):** about 54–57 concurrent players on Steam and an all-time peak of about 1,400–1,473. SteamDB showed 51% positive of 823 reviews. — search snippets: [Tracker.gg](https://tracker.gg/population/steam/2067210), [Raijin.gg](https://raijin.gg/app/2067210/Serious_Sam_Shatterverse), [SteamDB](https://steamdb.info/app/2067210/)
- **Reviews:** scores ranged from 4/10 (TheSixthAxis) to 8/10 (DayOne). Common complaints were repetition, balance and technical problems. — search snippets: [TheSixthAxis 2026-09-03](https://www.thesixthaxis.com/2026/09/03/serious-sam-shatterverse-review-sams-first-roguelite/), [OpenCritic](https://opencritic.com/game/21252/serious-sam-shatterverse), [VGTimes](https://vgtimes.com/gaming-news/166027-serious-sam-shatterverse-out-now-on-pc-and-consoles-launches-to-mixed-steam-reviews.html)

### Inferences
- Shatterverse already sets an official canon for "many Sams from many universes": Mental breaks the multiverse, and the multidimensional "Serious Program" coordinates Sams across realities. A fan multiverse linking SE1, the fan ports and the later games could frame itself as unofficial "Serious Program" dimensions without contradicting lore. Using the Shatterverse name or branding itself would be IP use.
- Its tech (Unreal, P2P, no Workshop, console parity) gives it no known modding or integration surface.
- Roughly 55 concurrent Steam players three months after launch points to a small, declining audience in Nov 2026.

### Gaps
- Post-launch patches, DLC or roadmap through Nov 2026: none found.
- Unreal Engine version (UE5 vs UE4) is not stated in sources I opened. Xbox Wire says only "Unreal Engine".
- Named Sam variants or eras (for example, whether the classic 2001 Sam appears as a distinct "dimension"): none found.
- Announcement date: 26 Mar 2026 per Wikipedia and GamesPress, 27 Mar in one search summary, probably a timezone difference.

## 3. Other Serious Sam projects 2023–2026 and Croteam's current work

### Takeaway
Croteam itself has two projects: Serious Sam: The Third Encounter (announced 22 Oct 2026, "early development", PC, no date), a direct sequel to The Second Encounter (2002), and The Talos Principle 3 (announced May 2026, aimed at 2027). Its Talos remake and sequel run on UE5. Devolver has owned Croteam since Oct 2020. The 25th anniversary in 2026 brought updates to the classic games.

### Cited Findings
- **The Third Encounter announcement:** 22 Oct 2026 by Croteam and Devolver. It is "a true continuation" of The Second Encounter, "not a prequel or side story"; Sam attacks Mental's Horde at its core. Solo and co-op, classic and new weapons. GamingOnLinux tags it Proton/Wine (no native Linux). The article does not state the engine, and a reader comment's claim of UE5 is unverified. — [GamingOnLinux 2026-10](https://www.gamingonlinux.com/2026/10/serious-sam-the-third-encounter-gets-teased-by-croteam-and-devolver-digital/); see also [PC Gamer](https://www.pcgamer.com/games/fps/holy-crap-theyre-making-serious-sam-the-third-encounter/), [TheSixthAxis 2026-10-24](https://www.thesixthaxis.com/2026/10/24/serious-sam-the-third-encounter-teased-by-croteam/)
- **The Third Encounter Steam page (app 459920):**
  - Developer Croteam, publisher Devolver; release "To be announced", "currently in early development".
  - Features: Single-player, Online Co-op, Shared/Split Screen, Steam Cloud. No Workshop is listed.
  - Minimum requirements: Win10 64-bit, 4-core 2.5 GHz, 8 GB RAM, GTX 780/970/1050 or Radeon 7950/280/470 with 3 GB, DirectX 11.
  - 18 fully voiced languages.
  - The Steam description credits it to the team behind The First Encounter and Siberian Mayhem.
  - Source: [Steam: The Third Encounter](https://store.steampowered.com/app/459920/)
- **Serious Sam: Tormental:** twin-stick roguelite by Croatian indie Gungrounds, built in Unity. Early access began 2 Apr 2019 under Croteam Incubator; 1.0 (the "Fortress Update") shipped 8 Apr 2022 under Devolver. Windows only; Metacritic 66. — [Wikipedia: Tormental](https://en.wikipedia.org/wiki/Serious_Sam:_Tormental)
- **Older spin-offs (pre-2020, context only):** Bogus Detour (2017) is a top-down shooter by Crackshell. Kamikaze Attack! is a mobile/PC runner. — search snippets: [DSOGaming](https://www.dsogaming.com/news/serious-sams-bogus-detour-is-a-top-down-action-spin-off-of-croteams-serious-sam/), [Hardcore Gaming 101](https://www.hardcoregaming101.net/serious-sam-spin-offs-after-serious-sam-3/)
- **Wikipedia's series list (edited 14 Nov 2026):** post-2020 entries are SS4 (2020), Siberian Mayhem (2022), Tormental (2022, spin-off), Shatterverse (2026, spin-off) and The Third Encounter (TBA, Windows). The list has no "Serious Sam 5", no new VR title and no new mobile title. The series is described as Sam vs Mental, "who attacks humanity at various points in time". — [Wikipedia: Serious Sam](https://en.wikipedia.org/wiki/Serious_Sam)
- **25th anniversary (22 Mar 2026):** Croteam added an "old, dusty sketchbook" of concept art to the install folders of The First Encounter and The Second Encounter, and announced Steam trading cards and collectibles for both. Croteam said celebrations would run all year. A Serious Sam 2 update reportedly added 12 previously unreleased multiplayer maps. — [iXBT.games 2026-03-22](https://ixbt.games/en/news/2026/03/22/25-let-serious-sam-otprazdnovali-vypuskom-obnovleniia-v-steam-anonsirovali-kollekcionnye-predmety.html); search snippet: [Multiplayer.it](https://multiplayer.it/notizie/serious-sam-compie-25-anni-croteam-festeggia-con-un-video.html); SS2 maps: [EGM](https://egmnow.com/serious-sam-4-gets-official-modding-tools-and-steam-workshop-support/), which may be an older SS2 update and is undated
- **Talos:**
  - The Talos Principle: Reawakened is a UE5 remake released 10 Apr 2025 on PC, PS5 and XSX at $39.99, with a puzzle editor on PC.
  - The Talos Principle 3 was announced in May 2026 for PC and PS5, "coming next year" (2027).
  - Sources: search snippets: [GamingOnLinux 2024-12](https://www.gamingonlinux.com/2024/12/the-talos-principle-reawakened-announced-that-rebuilds-and-expands-the-original-in-unreal-engine-5), [GamesPress Reawakened launch](https://gamespress.com/The-Talos-Principle-Reawakened-is-Out-Now-Bringing-Croteams-Classic-Ph), [Gematsu 2026-05](https://www.gematsu.com/2026/05/the-talos-principle-iii-announced-for-ps5-pc), [GamingBolt](https://gamingbolt.com/the-talos-principle-3-announced-for-2027-promises-one-last-journey-on-ps5-and-pc)
- **Devolver ownership:** Devolver acquired Croteam on 21 Oct 2020 for an undisclosed sum. Devolver said Croteam would "keep total creative freedom", and named Talos Principle 2, "more Serious Sam games" and Croteam Incubator projects. — search snippets: [Devolver "Croteam and Devolver got hitched"](https://devolverdigital.com/propaganda/croteam-and-devolver-got-hitched), [Gematsu 2020-10](https://gematsu.com/2020/10/devolver-digital-acquires-croteam), [PC Gamer](https://pcgamer.com/devolver-digital-acquires-serious-sam-developer-croteam)

### Inferences
- "Serious Sam 5" does not exist as a title. The next mainline Croteam game is The Third Encounter, and its story slots in between the 2001/2002 classics and later games, the era our SE1 browser port covers. That makes it a natural thematic neighbor for a multiverse hub.
- The Third Encounter's minimum specs (DX11, the same GPU list) are identical to SS4's. That could mean placeholder specs copied from SS4, or that it is built on the Serious Engine 4 codebase. The engine is unconfirmed (see section 4).

### Gaps
- Engine of The Third Encounter: not stated anywhere I could open.
- Any new VR or mobile Serious Sam in 2023–2026: none found.
- Sales figures for any post-2020 title: none found.

## 4. Serious Engine's future: Unreal migration, source releases, supported SDKs

### Takeaway
Croteam publicly says that after SS4 (2020) it retired Serious Engine and moved "permanently" to Unreal Engine (Talos 2 and Reawakened are UE5). Only Serious Engine 1.10 (2001) has ever been open-sourced, under GPLv2 in March 2016. No later Serious Engine (2, 3, 3.5, 4) source has been released, licensed or opened, and Serious Editor 2021 for SS4 is the newest official modding toolkit.

### Cited Findings
- Croteam CCO Davor Hunski (Epic developer interview about Talos Principle 2) said that after Serious Sam 4 in 2020, it was "time to retire their Serious Engine and shift all future development to Unreal Engine". Lead programmer Goran Adrinek called it "a permanent transition to Unreal Engine", after the UE5 demo with Nanite and Lumen showed this was "the final chapter of Serious Engine development". — search snippet (the page returned 403): [Unreal Engine interview](https://www.unrealengine.com/en-US/developer-interviews/inside-croteam-s-transition-from-in-house-tech-to-ue5-for-the-talos-principle-2)
- Croteam released Serious Engine v1.10 on GitHub under GNU GPL v2 in March 2016. The release includes no art assets or IP, 3D Exploration support is disabled for copyright reasons, and bundled zlib is under its own license. — search snippets: [GitHub Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine), [Geeks3D 2016-03-14](https://geeks3d.com/20160314/source-code-of-serious-engine-v-1-10-released), [PC Gamer](https://pcgamer.com/croteam-releases-source-code-to-serious-sam-engine); dated 11 Mar 2016 per [Wikipedia: Serious Sam](https://en.wikipedia.org/wiki/Serious_Sam)
- Wikipedia's engine lineage: SE1 for the original games, SE2 for Serious Sam II, SE3 for the HD remakes, and SE3.5 for BFE. Only SE1 is listed as open-source. — [Wikipedia: Serious Sam](https://en.wikipedia.org/wiki/Serious_Sam)
- Active community SE1 forks include tx00100xt/SeriousSamClassic, packaged on Flathub, and SE1-Community/SE1-GameShell. — search snippets: [GitHub tx00100xt](https://github.com/tx00100xt/SeriousSamClassic), [Flathub](https://flathub.org/apps/io.itch.tx00100xt.SeriousSamClassic), [SE1-GameShell](https://github.com/SE1-Community/SE1-GameShell)

### Inferences
- If The Third Encounter is on Unreal, consistent with Croteam's "permanent transition", then no Croteam game after Siberian Mayhem (2022) uses Serious Engine. SE1 (GPLv2) would stay the only legally open Serious codebase, so the browser port's engine base is unique.
- No later engine can be legally embedded or ported. Integrating SS4 and Shatterverse would have to happen at the level of external services or data files, not code reuse.

### Gaps
- Confirmation of The Third Encounter's engine.
- Whether Croteam still distributes or patches Serious Editor 2021, or whether it works with Siberian Mayhem.
- I could not open the Epic interview page (403) and relied on search snippets for its quotes.

## 5. Modding interop: what an SS4 mod can do, and whether an external service can read or drive game state

### Takeaway
SS4 Lua can script gameplay, spawn and track entities, sync state over the game's own RPCs, persist profile and session values, and (console scripts only) read and write text files. The researched docs show no sockets, HTTP or RCON, and there is no dedicated server. External coupling is realistically limited to file exchange, Workshop-distributed mods, and possibly log output. Shatterverse is closed: Unreal, peer-to-peer, no Workshop.

### Cited Findings
- SS4 console scripts can call `strSaveText(..)` and `strLoadText_unsigned(..)` and can read and write cvars. World scripts cannot load or save files. — [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)
- Script networking is limited to the game session: `CreateRPC` and `RegisterNetworkDescriptor`, with reliable and unreliable channels and no tables in RPC arguments. — [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)
- There is a built-in custom event `XML_Log`. The guide names it but does not say what it does. — [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)
- SS4 has no released dedicated server, and Croteam said in 2020 the repository "haven't been worked on since forever". The thread mentions no RCON. — [Steam discussion](https://steamcommunity.com/app/257420/discussions/0/2840039920169084552/)
- Shatterverse uses peer-to-peer multiplayer with no dedicated servers. — [Xbox Wire](https://news.xbox.com/en-us/2026/08/31/serious-sam-shatterverse/). Steam lists no Workshop and a third-party EULA. — [Steam](https://store.steampowered.com/app/2067210/Serious_Sam_Shatterverse/)

### Inferences
- **Feasible SS4 bridge:** a Workshop mod with a console startup script (in `Content/SeriousSam4/Scripts/Startup/`) that periodically `strSaveText`s a JSON-ish state file (current level, kills, player positions) and polls `strLoadText_unsigned` for commands. A local companion app would relay the data to a web multiverse hub. This needs a local helper process. Steam Workshop distributes Lua only, not binaries. The design is unverified, and the writable path scope is unknown.
- Shatterverse has no supported integration path. Any link would be cosmetic or narrative (for example, a portal to its Steam page), not technical.

### Gaps
- No source confirmed whether SS4 Lua exposes `io`, `os`, `socket` or `http`, or where `strSaveText` can write (sandboxed to the game dir or user dir?).
- The SS4 log file location and format (for log-parsing integration) was not found.
- The full official Lua API reference: Serious Editor ships one in-editor per community reports, but it is not publicly hosted. I found no public URL.

## 6. Legal and community: Croteam and Devolver attitude to fan projects, mod policy, takedowns

### Takeaway
Croteam's record is fan-friendly: GPL SE1 code (2016), free official SS4 editor and Workshop (2021), turning modders into an official expansion team (Siberian Mayhem), and licensing the IP to an outside studio (Shatterverse). I found no Serious Sam takedown and no formal written mod or fan-project policy. The GPL covers SE1 code only, not assets or the Serious Sam name.

### Cited Findings
- SE1's GPL release covers engine code only. "Art assets and the Serious Sam IP have not been released." — search snippet: [GamingOnLinux 2016-03 comments](https://www.gamingonlinux.com/2016/03/croteam-releases-serious-engine-version-110-as-free-software/page=1/)
- Croteam gave the official modding tools away free to SS4 owners. — [EGM](https://egmnow.com/serious-sam-4-gets-official-modding-tools-and-steam-workshop-support/)
- Timelock Studio went from modding community and SS4 testers to the developers of Siberian Mayhem, published by Devolver. — [Wikipedia: Siberian Mayhem](https://en.wikipedia.org/wiki/Serious_Sam:_Siberian_Mayhem)
- Shatterverse was developed by Behaviour "with the blessing of Croteam". — [Wikipedia: Shatterverse](https://en.wikipedia.org/wiki/Serious_Sam:_Shatterverse)
- A search for "Serious Sam DMCA takedown fan project" returned only other publishers' cases (Valve TF: Source 2, Microsoft Halo CS2 mod), none involving Croteam or Devolver. — [search results incl. PC Gamer on TF:Source 2](https://pcgamer.com/fan-made-team-fortress-2-remake-using-the-source-2-engine-shuts-down-for-good-after-receiving-a-dmca-notice-from-valve)
- The SS4 Scripting Guide on Steam is marked as removed for violating Community guidelines (Nov 2026). This is a Steam moderation action, and its cause is unknown. — [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713)

### Inferences
- The low-risk path for a fan multiverse is to ship SE1 GPL code, require users to supply their own game data (as the existing SE1 forks do), and avoid using "Shatterverse" or Devolver/Croteam branding as product names. This is a design judgement, not legal advice.

### Gaps
- No published Croteam or Devolver fan-content or mod policy document found.
- No information on whether Croteam has objected to browser or WebAssembly ports of SE1 specifically.
