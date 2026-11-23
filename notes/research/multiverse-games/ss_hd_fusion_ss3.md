# Serious Sam HD (TFE/TSE), Serious Sam Fusion, Serious Sam 3: BFE, and Serious Engine 3 / 3.5: state as of 2026-11-24

Scope: which versions are sold and maintained, what tech they run on, what can be built on top of them, for a "multiverse" design study linking a browser port of GPL Serious Engine 1 (v1.10) to later Serious Sam games. Research date: 2026-11-24. Facts carry their own dates where they are older.

## 1. Which versions are sold and maintained, with release and last-patch dates

### Takeaway
All three games are still sold on Steam as standalone apps, plus a free combined hub, **Serious Sam Fusion** (app 564310), that owners get. Fusion was a public beta from 21 Mar 2017. Its last update before this one was on 7 Jun 2019. It **left beta on 22 Nov 2026** with a large bug-fix patch for BFE's 15th anniversary and dropped "2017 (beta)" from its name. That makes Fusion the only maintained PC build. The consoles get the same three games as "Serious Sam Collection" (Stadia 2020, Switch/PS4/Xbox One 17 Nov 2020).

### Cited Findings
**Original releases**
- Serious Sam HD: The First Encounter: Windows 24 Nov 2009; Xbox 360 (XBLA) 13 Jan 2010, co-published by Majesco; a Mar 2010 patch added deathmatch. Steam "Serious Sam HD: Gold Edition" bundle from Sep 2010. PS3 was skipped for budget reasons. — [Wikipedia: Serious Sam HD: TFE](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_First_Encounter)
- Serious Sam HD: The Second Encounter: Windows 28 Apr 2010; Xbox 360 22 Sep 2010. Legend of the Beast DLC announced and released May 2012. — [Wikipedia: Serious Sam HD: TSE](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_Second_Encounter)
- Serious Sam 3: BFE: Windows 22 Nov 2011; Mac OS X 23 Apr 2012; Xbox 360 17 Oct 2012; Linux 20 Dec 2012 per the infobox, but 6 Nov 2012 (Steam Linux beta launch) per the article text and per PCGamingWiki; PS3 13 May 2014. Jewel of the Nile DLC: Windows/Mac 16 Oct 2012, Xbox 360 17 Oct 2012. — [Wikipedia: SS3 BFE](https://en.wikipedia.org/wiki/Serious_Sam_3:_BFE); [PCGamingWiki SS3 BFE (wikitext via API)](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE)
- VR remakes: Serious Sam VR: TFE early access Dec 2016 (Windows), Linux Feb 2017, full release 30 Mar 2017. SS VR: TSE 4 Apr 2017. Serious Sam 3 VR: BFE 9 Nov 2017 for Windows and Linux. — [Wikipedia TFE HD](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_First_Encounter); [Wikipedia TSE HD](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_Second_Encounter); [Wikipedia BFE](https://en.wikipedia.org/wiki/Serious_Sam_3:_BFE)

**Serious Sam Collection (consoles)**
- HD TFE, HD TSE and BFE as "Serious Sam Collection": Stadia 3 Mar 2020; Switch, PS4 and Xbox One 17 Nov 2020. An Xbox 360 physical "The Serious Sam Collection" (Mastertronic) came out Jul 2013. — [Wikipedia TFE HD](https://en.wikipedia.org/wiki/Serious_Sam_HD:_The_First_Encounter); [Wikipedia BFE](https://en.wikipedia.org/wiki/Serious_Sam_3:_BFE)
- Physical Switch edition by Special Reserve Games, announced 11 Oct 2022: HD TFE, HD TSE and BFE with both expansions; 3,000 copies; shipping planned for Nov 2022. — [Steam news API, app 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=12&maxlength=1500)

**Serious Sam Fusion (2017 → 2026)**
- Fusion is a "central hub" for HD TFE, HD TSE, BFE and the VR versions. The Steam page lists a common Workshop and cross-game mods, one launcher with switching between games without exiting, a shared TFE/TSE/SS3 server list with cross-game map voting, VR/flat crossplay, 64-bit executables, multithreaded rendering, texture streaming and Vulkan, and says "DirectX 9 is being removed". — [Steam store, app 564310](https://store.steampowered.com/app/564310/Serious_Sam_Fusion_2017/)
- Fusion is free to owners of any of the six games. The public beta started 21 Mar 2017. Its last update before 2026 was an unannounced one on 7 Jun 2019, "after which it was left unsupported for years". It left beta on 22 Nov 2026. Known gaps: BFE's Bonus Content DLC is missing; The Serious 8 DLC (TSE) is built in but lacks one character. — [PCGamingWiki: Serious Sam Fusion (wikitext via API)](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion), citing [SteamDB patchnotes 3897313](https://steamdb.info/patchnotes/3897313/)
- The 22 Nov 2026 Steam announcement "Serious Sam Fusion - Beta No More!" (by "THE LAW") was timed to BFE's 15th anniversary. It removes the "2017 (beta)" label, resets leaderboards, and fixes enemy spawners, animations, crashes, controller vibration, lighting, co-op respawning, Flat/VR crossplay crashes and Versus balance, plus updates the Russian localization. It warns that some "BFE campaign overhaul mods may crash when loading levels" (the fix is to rebake lighting and resave). It also says: "We still plan to revisit it down the road, particularly when it comes to improving modding support". No build number or renderer/API change is mentioned. — [Steam news API, app 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=2&maxlength=0); [Steam news post](https://store.steampowered.com/news/app/564310/view/674012071495467586)
- GamingOnLinux (23 Nov 2026): "has finally left Beta after years". The changelog includes "Reworked lighting across most levels in the HD games and BFE for improved shadow accuracy". The listing shows Native Linux and Steam Deck Verified. — [GamingOnLinux](https://www.gamingonlinux.com/2026/11/serious-sam-fusion-is-finally-out-of-beta-with-a-big-upgrade/)
- Conflict: SteamCharts still titles the app "Serious Sam Fusion 2017 (beta)" (stale cache), and a general web search summary also called it beta. The primary Steam announcement and PCGamingWiki confirm the exit from beta. — [SteamCharts 564310](https://steamcharts.com/app/564310)
- Before the Nov 2026 patch, the macOS build was "build 440323, last updated June 2019, x86_64, runs under Rosetta 2", according to a fan fix repo tested Oct 2026. This is community observation, not official. — [pajacloud/serious-sam-fusion-macos-fix](https://github.com/pajacloud/serious-sam-fusion-macos-fix)
- Fusion's Steam page also lists Legend of the Beast and Jewel of the Nile as Fusion DLC entitlements, all on Windows, OS X and Linux. — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)
- Reviews: Very Positive, 91% of 1,794 English reviews. Sale prices as of Nov 2026: Serious Sam HD $0.79 (-90%); HD Gold Collection $4.28. — [Steam store 564310](https://store.steampowered.com/app/564310/Serious_Sam_Fusion_2017/)

**Standalone apps**
- The standalone apps are still sold: HD TFE (41000), HD TSE (41010), BFE (41070). All need Steam DRM. BFE is also sold via Gamesplanet and Humble as Steam keys. — [PCGamingWiki BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE); [PCGamingWiki HD TFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_HD:_The_First_Encounter)
- The BFE Steam news feed's only 2020–2026 patch item is the Fusion update of 22 Nov 2026. — [Steam news API, app 41070](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=41070&count=8&maxlength=800)
- Known standalone SS3 build numbers from Croteam's in-game changelog feed (undated in the extract): 180038, 196185, 196301, 201197, 206585, 233089, 249925, 249955. — [ingame.serioussam.com SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)

### Inferences
- In practice the maintained PC target is **Fusion**: 64-bit, Vulkan/D3D11/Metal, native Linux, with one Workshop across HD TFE, HD TSE and BFE. The standalone HD/BFE builds are legacy 32-bit D3D9/OpenGL 2.0 builds kept for sale.
- The 2026 "year of 25th-anniversary updates" announcement (21 Mar 2026) plus the Fusion beta exit point to renewed but limited upkeep. It does not signal a new engine upgrade.

### Gaps
- Exact last-patch dates for the standalone HD TFE, HD TSE and BFE builds: SteamDB was not fetched, and the Croteam feed extract has no dates.
- No VR-specific "Legend" edition was found. "Legend of the Beast" is the TSE HD DLC. No current console patch dates were found.

## 2. Engine: SE3 / SE3.5 features, renderers, platforms, scripting, editor, networking

### Takeaway
HD TFE/TSE run on Serious Engine 3 (2009). BFE runs on SE3.5 (2011), which Croteam describes as a "heavily upgraded" SE3 and a midpoint toward SE4. Fusion uses an SE3.5-derived 2017 build (PCGamingWiki names it "Serious Engine 2017"). It is 64-bit only, with D3D11, D3D12 (beta), Vulkan 1.1 and Metal renderers, native Windows/macOS/Linux, Lua scripting, Serious Editor 2017 (Steam app 564380), dedicated servers, 16-player online co-op/versus and 4-player split-screen. Multiplayer goes through Steamworks.

### Cited Findings
- Croteam on SE3: "the first Serious Engine that features proper support for true HDR lighting"; games: HD TFE/TSE; platforms: PC and Xbox 360; 2009. — [Croteam: Serious Engine page](https://www.croteam.com/?p=3233)
- Croteam on SE3.5: "a heavily upgraded version from the Serious Engine 3", a midpoint between SE3 and SE4. Games: SS3 BFE, The Talos Principle, SS VR titles, Talos VR, Fusion 2017. Platforms: PC, Mac, Linux, Xbox One, PS3, PS4, Switch, iOS, Android, Vive, Oculus. Dated 2011. Croteam's page lists SE4 (2020) for SS4 and Siberian Mayhem. — [Croteam](https://www.croteam.com/?p=3233)
- Conflict on The Talos Principle: Croteam's page puts it under SE3.5, while a community save-editor repo lists it as "Serious Engine 4". — [Croteam](https://www.croteam.com/?p=3233); [widberg/SeriousSaveEditor](https://github.com/widberg/SeriousSaveEditor)
- ModDB: as with SE3, "Serious Engine 3.5 cannot be licensed for use by other developers". — [ModDB Serious Engine](https://www.moddb.com/engines/serious-engine/features) (via search summary)

**Renderers and bitness**
- Fusion: Direct3D 11 and 12 ("D3D12 renderer is in beta and not fully tested"), Vulkan 1.1, Metal (macOS). Executables are 64-bit only on Windows, macOS Intel and Linux; the 32-bit flag is false everywhere. Audio is OpenAL; multiplayer middleware is Steamworks. — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)
- Standalone BFE: "Direct3D 9 is the default and most complete renderer on Windows. Direct3D 11 is buggy." OpenGL 2.0 is the default on OS X and Linux. 32-bit executables on Windows, macOS and Linux. — [PCGamingWiki BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE)
- Croteam's SS3 changelog added "experimental support for Direct3D11" via `gfx_strAPI` and `gfxRestart()`. — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- Standalone HD TFE: Direct3D 9.0c, 32-bit Windows exe only, shader model 3. — [PCGamingWiki HD TFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_HD:_The_First_Encounter)
- Fusion's Steam requirements still show stale Mac text ("OS X Lion 10.7") and Linux text ("Ubuntu 14.04"). Windows minimum is Win7 64-bit with a DX11 GPU. — [Steam store 564310](https://store.steampowered.com/app/564310/Serious_Sam_Fusion_2017/)

**Lua scripting**
- SS3 changelog: "All lua scripts located in Content/SeriousSam3/Scripts/Startup/ will be executed upon project boot". After `WorldScripts.lua`, "all custom Lua scripts from Content/SeriousSam3/Scripts/CustomWorldScripts/ are enumerated and executed" (editor and moddable version only). Lua can also "define new input controls". — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- A Steam scripting guide for SS4 notes the same CustomWorldScripts mechanism with HD folder names `SeriousSamHD` and `SeriousSamHD_TSE`. Script entities in levels hold Lua world scripts. — [Steam guide 2244897713](https://steamcommunity.com/sharedfiles/filedetails/?id=2244897713) (via search summary)
- Fusion config is Lua-like (`UserCfg.lua`, `SeriousSam2017.ini` with cvars like `gfx_bFullScreen = 0;`). — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)
- A community MCP server (Oct 2026) drives Serious Editor 2017 / Fusion (Steam app 564380) through a Lua bridge run via "Script > Run script from file...". — [thingolus/serious-editor-mcp](https://github.com/thingolus/serious-editor-mcp)

**Serious Editor and Workshop**
- SS3 changelog: "All official content including levels is now editable and can be saved. So custom versions of official levels can be created." The editor download grew about 700 MB to include edit data for meshes, animations and mechanisms. DLC content keeps its DLC license when resaved, and Workshop subscribers need the DLC. Serious Editor imports and exports .fbx (FBX SDK 2014.1) and can edit .xml files. — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- Standalone BFE: mods run only in a separate "moddable version", which disables achievements and leaderboards. — [PCGamingWiki BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE)
- Fusion: the Steam page lists a level editor and Steam Workshop. To host a server with mods, clients must have all required mods installed locally, or they get stuck in a boot loop. — [Steam store 564310](https://store.steampowered.com/app/564310/Serious_Sam_Fusion_2017/); [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)

**Multiplayer and netcode**
- BFE: local split-screen for 4 players (co-op and versus); LAN and online up to 16 (co-op and versus); P2P, matchmaking and dedicated servers all supported. "Dedicated Server software is available under Tools in the Steam client." Ports TCP/UDP 27015. Direct IP via `gam_strConnectToIP`. — [PCGamingWiki BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE)
- Fusion: local 4, online 16, co-op and versus, dedicated servers and self-hosting supported, no LAN, Steamworks middleware. — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)
- HD TFE: online 16 players (co-op, versus), dedicated servers, no LAN. — [PCGamingWiki HD TFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_HD:_The_First_Encounter)
- SS3 changelog: "Dedicated server no longer requires Steam client running in the background"; it also fixed Linux dedicated server freezes. — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- Community dedicated-server tooling exists: codecat/ServerGUIHD (2014, HD TSE dedicated server runner), jimbo8098/docker-ss3 (2020, Docker for SS3 server), hypercephalickitten/sam3-xml-event-admin (2015). — GitHub: [ServerGUIHD](https://github.com/codecat/ServerGUIHD), [docker-ss3](https://github.com/jimbo8098/docker-ss3), [sam3-xml-event-admin](https://github.com/hypercephalickitten/sam3-xml-event-admin)
- Adiru3/SS-Fusion-Multiplayer (pushed Feb 2026, MIT, Windows/.NET) claims a custom master server, relay/STUN NAT traversal and a server-browser launcher for Fusion. These are the project's own claims and were not verified. — [GitHub](https://github.com/Adiru3/SS-Fusion-Multiplayer)

### Inferences
- The netcode model (client-server vs. lockstep, tick rate) is not documented in what I found. The 16-player cap, Steamworks matchmaking and the Steam-distributed dedicated-server tool suggest a client-server model over Steam networking. That is an inference, not a sourced fact.
- For a multiverse "bridge", the realistic hook into Fusion is its Lua layer: startup scripts, CustomWorldScripts and console cvars. Fusion has no exposed C++ API.

### Gaps
- Official SE3/SE3.5 netcode documentation, tick rate and protocol details.
- Whether the Nov 2026 patch changed renderers (the announcement does not say).
- A Croteam developer wiki (serioussam.com/wiki, cited in the changelog for Lua docs) was not checked for current availability.

## 3. Source code, leaks, reverse engineering, community tools, Proton, ports

### Takeaway
No SE2, SE3, SE3.5 or SE4 source code is public, and I found no reports of a leak. Only SE1 v1.10 is open (GPLv2, Mar 2016), and its assets stay proprietary. Community work on HD-era games covers mod managers, launchers, save/format tools, Blender add-ons for Serious Editor ASCII formats, macOS fixes and dedicated-server wrappers. I found no browser port and no full engine reimplementation of SE3/SE3.5. Proton ratings are Gold to Platinum, and native Linux builds exist anyway.

### Cited Findings
- Croteam's official GitHub repo holds Serious Engine v1.10 source under GPLv2. Game assets remain proprietary. — [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine); [PC Gamer](https://www.pcgamer.com/croteam-releases-source-code-to-serious-sam-engine)
- Searches found no public SE3.5 repo and no SE2/SE3 leak reports. The only public code is v1.10 and its forks (tx00100xt/SeriousSamClassic, icculus Linux port, fgsfdsfgs, EXL). — [GitHub search results](https://github.com/tx00100xt/SeriousSamClassic); [GamingOnLinux 2016 comments](https://www.gamingonlinux.com/2016/03/croteam-releases-serious-engine-version-110-as-free-software/comment_id=56135)
- A GitHub API search on 2026-11-24 found these Fusion-related repos:
  - Bluscream/Serious-Sam-Fusion-Mod-Manager (2023)
  - bencs-zoltan/SeriousSamFusionArchipelago (Jan 2026; an Archipelago randomizer integration)
  - pajacloud/serious-sam-fusion-macos-fix (Oct 2026)
  - purifetchi/FusionRPCBridge (Discord RPC, 2021)
  - Adiru3/SS-Fusion-Multiplayer (Feb 2026)
  - flashintv/SamCollection_ModAchievementsEx (21 Nov 2026; "Sam2017_ModAchievements with Serious Sam 4 support … A launcher")
  - DenWhAI/serious-sam-tournaments-ranking (22 Nov 2026; TSE and BFE rankings)
  - Source: [GitHub repo search API](https://api.github.com/search/repositories?q=serious+sam+fusion)
- Format tools:
  - purifetchi/io_sedASCII is a "Serious Editor ASCII format toolset for Blender" (2020). It exports AMF (mesh), ASF (skeleton) and AAF (animation).
  - widberg/SeriousSaveEditor (Dec 2025) handles the Serious Engine signed save/stream format, but only for The Talos Principle so far. Its table maps HD TFE/TSE → SE3 and BFE → SE3.5.
  - Birthday-2020/Serious-Sam-3-Editor (2024) is a Russian-language resource editor; its claims were not verified.
  - Sources: [io_sedASCII](https://github.com/purifetchi/io_sedASCII); [SeriousSaveEditor](https://github.com/widberg/SeriousSaveEditor); [Serious-Sam-3-Editor](https://github.com/Birthday-2020/Serious-Sam-3-Editor)
- A Polycount thread on SE3 skeletal data describes the pipeline as weighting in a DCC tool, then exporting AMF to import into the editor. — [Polycount](https://polycount.com/discussion/91646/seriousengine3-skeletal-reproduction)
- ProtonDB summaries as of 2026-11-24:

  | Game (app ID) | Tier | Best reported | Reports |
  |---|---|---|---|
  | Fusion (564310) | Gold | Platinum | 33 |
  | HD TFE (41000) | Silver | Platinum | 81 |
  | HD TSE (41010) | Gold | Platinum | 18 |
  | BFE (41070) | Gold | Platinum | 28 |

  Source: [ProtonDB API 564310](https://www.protondb.com/api/v1/reports/summaries/564310.json) and the same endpoint for 41000, 41010 and 41070.
- Fusion is Native Linux and Steam Deck Verified. — [GamingOnLinux](https://www.gamingonlinux.com/2026/11/serious-sam-fusion-is-finally-out-of-beta-with-a-big-upgrade/)
- macOS Apple Silicon: Fusion crashes in fullscreen. The documented workaround is windowed mode via `SeriousSam2017.ini`. A fan repo adds a shell wrapper that strips the Steam-overlay `DYLD_INSERT_LIBRARIES` injection and a fullscreen fix. — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion); [pajacloud repo](https://github.com/pajacloud/serious-sam-fusion-macos-fix)
- Cross-game content ports inside Fusion (Workshop):
  - "Serious Sam 2 Fusion Deathmatch" (featured 17 Oct 2024) recreates SS2 versus deathmatch in Fusion. It has the 4 original SS2 maps, 9 from the 2.090 update, 3 scrapped CTF maps and 2 custom ones, by Ryason.
  - "Green Planet" (featured 19 Aug 2026) is a TSE-continuation campaign with enemy cameos from SS4 and Siberian Mayhem.
  - Source: [Steam news API 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=12&maxlength=1500)
- Graphics mods listed on PCGamingWiki include "A Seriously Stupid HD Remaster" (Workshop 1577945842), "High Definition Textures (First Encounter)" and "BFE Destructions for HD". — [PCGamingWiki Fusion](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion)
- Repo "Sameh230/Serious-Sam-3-" (Sep 2025) has the description "Native port" with 0 stars. It is unverified and treated as noise. — [GitHub](https://github.com/Sameh230/Serious-Sam-3-)

### Inferences
- Any multiverse link to the HD/BFE games has to go **through Fusion's own modding surface**: Lua, Workshop packages and the Serious Editor FBX/ASCII pipelines. Engine code is not an option.
- To get HD/BFE content into a browser engine, the practical route is to export from Serious Editor (FBX/AMF) on a machine that owns the game. Shipping that content would still be blocked by the asset licence (see section 5).

### Gaps
- No browser ports, WebGL viewers or third-party engine ports of HD/BFE content were found. Absence is not proof; Discord-only projects would not show up.
- Did not check SteamDB depots or branch lists (no fetch).

## 4. Data formats: .gro, world/mesh/texture formats, and SE1 ↔ SE3.5 interchange

### Takeaway
SE1 and SE3/3.5 both use **.gro, which is a renamed ZIP**. The editor packs levels into .gro via its File menu. Inside, the formats are entirely different engine generations. SE1 uses .wld/.mdl/.tex/.ecl. SE3.5 uses binary resources edited in Serious Editor, with interchange via FBX and Serious Editor ASCII (AMF/ASF/AAF). No sourced SE1→SE3.5 importer exists. The HD remakes were rebuilt levels, and Croteam has not published how they were made.

### Cited Findings
- SE1 v1.10 source reads .gro through its own ZIP reader: `SIGNATURE_LFH 0x04034b50`, `SIGNATURE_EOD 0x06054b50` and `CZipEntry` in `Sources/Engine/Base/Unzip.cpp`. — [Croteam-official/Serious-Engine Unzip.cpp](https://github.com/Croteam-official/Serious-Engine/blob/master/Sources/Engine/Base/Unzip.cpp)
- HD TSE Workshop discussion: the editor can pack a level into a .gro through the File menu. A .gro is "essentially a zip archive renamed", though a standard archiver may not produce a file the game accepts. — [Steam Workshop discussion (app 41010)](https://steamcommunity.com/workshop/discussions/-1/558749824845342368/?appid=41010) (via search summary)
- Advice from an HD TSE thread: extract official .gro files rather than editing them in place. — [Steam discussion 41010](https://steamcommunity.com/app/41010/discussions/0/810938810910375563/) (via search summary)
- Third-party extraction: users report Dragon UnPACKer works on .gro. Interchange runs through AMF via Serious Editor. — [file-extensions.org .gro](https://www.file-extensions.org/extension/gro); [Polycount](https://polycount.com/discussion/91646/seriousengine3-skeletal-reproduction) (via search summary)
- SE3.5 editor interchange: FBX import/export (FBX SDK 2014.1). All official levels became editable and savable. — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- Serious Editor ASCII formats in Blender: AMF/ASF/AAF export. — [io_sedASCII](https://github.com/purifetchi/io_sedASCII)
- Config and paths: BFE content lives under `Content/SeriousSam3/` (for example `Content/SeriousSam3/Config/SeriousSam3.ini`), and the HD TFE profile is `SeriousSamHD.ini`. — [PCGamingWiki BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_3:_BFE); [PCGamingWiki HD TFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_HD:_The_First_Encounter)
- The SE1 Classic open-source builds run with .gro files copied from the original game; assets are not included. — [tx00100xt/SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic)

### Inferences
- The shared .gro=ZIP container makes a common package/VFS layer trivial for a multiverse launcher. The payload formats do not interoperate, so there is no direct .wld→SE3.5 world or .mdl→SE3.5 mesh path.
- Reverse direction (SE3.5 → SE1 or a web engine): the only sourced route is Serious Editor FBX export, done by an owner locally.
- SE1 brush worlds would have to be converted to meshes, for example via the SE1 editor or a custom tool built on the GPL code, then FBX-imported into Serious Editor 2017. This is plausible but no example was found.

### Gaps
- No public spec found for SE3/3.5 binary formats (meshes, textures, worlds) or the HD-era signed resource format. widberg's tool covers only the outer "signature stream" for Talos saves and `All.dat`/`DLC.dat`.
- No Croteam statement found on how HD TFE/TSE levels were rebuilt (from SE1 geometry or from scratch).

## 5. Legal and community: policies, EULA, player counts, notable mods

### Takeaway
Croteam encourages modding through official editors and the Workshop. It features mods in Fusion's Steam news and has said it plans more Fusion modding work. However, SE3/3.5 assets and code are proprietary. The only open-source grant is SE1 v1.10 code, not assets. Croteam's Talos Reawakened terms forbid reverse engineering except as authorised or allowed by law. No Serious Sam-specific EULA was retrievable from Steam. Player counts are small: Fusion averaged about 74 concurrent over the last 30 days, with a 486 all-time peak.

### Cited Findings
- Fusion's Steam news has run a "Featured Mod" series since 2022 (Operation FrostBite, Blood Sugar, Winter Wonderland, Jingle Bombs 2022, 7Smoke Tennis, Crystal Impact, SS2 Fusion Deathmatch, Green Planet). The Nov 2026 announcement says Croteam will revisit "modding support" and Workshop creator freedom. — [Steam news API 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=12&maxlength=1500)
- The Croteam Steam group says user content "has been the backbone of our games for a long time". — [Croteam Steam group](https://steamcommunity.com/groups/croteamofficial) (via search summary)
- The Talos Principle: Reawakened EULA, section 4.3: "You may not reverse engineer or attempt to extract or otherwise use source code or other data from Croteam or Devolver Digital, unless expressly authorized … or permitted by law." This is a different game, used here only as an indicator of Croteam/Devolver's standard terms. — [Steam EULA 2806640](https://store.steampowered.com//eula/2806640_eula_0)
- The SE1 v1.10 release covers code only; art assets and the Serious Sam IP were not released. — [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine); [GamingOnLinux comment](https://www.gamingonlinux.com/2016/03/croteam-releases-serious-engine-version-110-as-free-software/comment_id=56135)
- DLC content edited in Serious Editor keeps its DLC licence, and Workshop subscribers need the DLC. This is an engine-enforced asset licence. — [SS3 newsfeed](http://ingame.serioussam.com/newsfeed/SeriousSam3.xml)
- Steam concurrent players, from SteamCharts on 2026-11-24:

  | Game (app ID) | Now | 24h peak | 30-day avg | 30-day peak | All-time peak | Sep 2026 avg |
  |---|---|---|---|---|---|---|
  | Fusion (564310) | 194 | 277 | 73.6 | 277 | 486 | 78.0 |
  | HD TFE (41000) | 58 | 99 | 36.0 | — | 578 | — |
  | HD TSE (41010) | 22 | — | 39.5 | — | 5,992 | — |
  | BFE (41070) | 89 | — | 68.8 | 185 | 2,085 | — |
  | SE1 Classic TFE (41050) | — | — | 14.0 | — | — | — |
  | SE1 Classic TSE (41060) | — | — | 14.7 | — | — | — |

  The Fusion 24h peak of 277 likely reflects the beta-exit patch and sale. Source: [SteamCharts 564310](https://steamcharts.com/app/564310), [41000](https://steamcharts.com/app/41000), [41010](https://steamcharts.com/app/41010), [41070](https://steamcharts.com/app/41070), [41050](https://steamcharts.com/app/41050), [41060](https://steamcharts.com/app/41060)
- Community hubs: the official Croteam Discord (#workshop-chat, #serious-bugs), Serious Zone forums (mods and maps for BFE), SeriousSite.ru (runs the Jingle Bombs contests) and the Slavic "Khreth" community. — [PCGamingWiki Fusion/BFE](https://www.pcgamingwiki.com/wiki/Serious_Sam_Fusion); [Steam news API 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=2&maxlength=0)
- Notable mods:
  - Blade Runner: Cells Interlinked 2021, an SS3 total conversion (PCGamesN, 29 Nov 2020) — [Steam news API 41070](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=41070&count=8&maxlength=800)
  - Crystal Impact (17 mappers, 10 worlds, 50+ custom enemies from the "T&C co-op pack") — [Steam news API 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=12&maxlength=1500)
  - Serious Sam HD: Extended (ModDB, listed release 11 Apr 2026) — [ModDB](https://www.moddb.com/mods/serious-sam-hd-extended)
- Siberian Mayhem (SS4 standalone expansion, announced 11 Jan 2022) was made by members of the modding community. It is a precedent for Croteam commercialising community work. — [Steam news API 41070](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=41070&count=8&maxlength=800)

### Inferences
- A browser multiverse can legally **reference** HD/Fusion content only by (a) requiring a user-owned install and reading assets locally, or (b) using Workshop/Lua mods that run inside Fusion. Redistributing HD/BFE assets or decompiled formats would conflict with Croteam/Devolver's standard terms.
- Croteam's Featured Mod programme and its stated intent to improve Fusion modding make an officially blessed in-Fusion "portal" mod the lowest-friction integration point.

### Gaps
- Steam serves no app-specific EULA for 564310, 41070 or 41000: the pages returned empty templates, so Steam's Subscriber Agreement presumably applies. No Croteam fan-content or IP policy page was found.
- Workshop item counts for Fusion were not retrieved.

## 6. 2025–2026 news: remasters, ports, re-releases, engine upgrades, anniversaries

### Takeaway
2026 is the series' 25th anniversary year. Croteam released anniversary items for TFE/TSE in March, took Fusion out of beta on 22 Nov 2026, and announced a new mainline game, Serious Sam: The Third Encounter (Oct 2026, PC, no date, engine not stated). Devolver published Shatterverse, a Behaviour Interactive co-op roguelite (31 Aug 2026). No official HD remaster, new HD port or SE3.5 engine upgrade was announced.

### Cited Findings
- 21 Mar 2026, "25 YEARS OF SERIOUS SAM!": a retrospective, promised year-long updates, a hidden "Serious Sam Sketchbook" added to the TFE and TSE install folders, and new TFE/TSE Steam trading cards, avatar frames and backgrounds. — [Steam news API 564310](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=564310&count=12&maxlength=1500)
- 26 Mar 2026: Shatterverse announced at the Xbox Partner Preview. It is developed by Behaviour Interactive "with the blessing of Croteam" and published by Devolver; Croteam "continues work on The Talos Principle and a new IP". It released 31 Aug 2026 on PS5, Windows and Xbox Series X/S, with up to 5-player co-op. No engine is named. — [Wikipedia: Shatterverse](https://en.wikipedia.org/wiki/Serious_Sam:_Shatterverse); [Steam news API 41070](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=41070&count=8&maxlength=800)
- Oct 2026 (about 21 Oct): Croteam and Devolver announced Serious Sam: The Third Encounter for PC/Steam with a teaser and no release date. It continues directly from The Second Encounter, and people who worked on Siberian Mayhem are involved. One outlet notes Timelock Studio is not listed among the developers. — [Gematsu](https://www.gematsu.com/2026/10/serious-sam-the-third-encounter-announced-for-pc); [GamingOnLinux](https://www.gamingonlinux.com/2026/10/serious-sam-the-third-encounter-gets-teased-by-croteam-and-devolver-digital/); [80.lv](https://80.lv/articles/croteam-is-officially-working-on-serious-sam-the-third-encounter); [iXBT](https://ixbt.games/en/news/2026/10/21/pervyi-vzgliad-na-serious-sam-the-third-encounter-croteam-anonsirovala-novyi-suter.html)
- 22 Nov 2026: Fusion "Beta No More!" (see section 1). It does not mention a new renderer or engine version. — [Steam news post](https://store.steampowered.com/news/app/564310/view/674012071495467586)
- The Workshop item "Serious Sam Remastered ~2026~" is an old fan item (about 2,081 days old); "2026" is part of its title, not a release date. — [Steam Workshop 2423638243](https://steamcommunity.com/sharedfiles/filedetails/?id=2423638243) (via search summary)

### Inferences
- The Third Encounter continues TSE's story, which gives a narrative hook for a TFE/TSE-centred multiverse. Its engine (likely SE4 or a successor) is unannounced, so no tech coupling can be planned yet.
- Croteam's continued Fusion investment ("revisit … modding support") may widen the Lua/Workshop surface in 2027. Watch the Fusion Steam news feed.

### Gaps
- Engine for The Third Encounter and for Shatterverse: not stated in the sources checked.
- No 2025 items were found for these specific games. The 2025–2026 feed shows nothing between Oct 2024 and Mar 2026.
