# Prior art: rewriting and reimplementing classic game engines (Rust/Bevy and beyond)

Research date: 2026-11-24. Every data point carries its own date where the source gave one. Items marked **[unverified this session]** come from background knowledge and were not re-fetched; the report writer should treat them as lower confidence or drop them.

Target for comparison: Serious Engine 1 (SE1), with about 230k lines of C++ engine and about 170k lines of entity code, so about 400k lines. GPL-2 source is available (Croteam released it in 2016).

---

## 1. Rust reimplementations of classic engines (Quake, Doom, GoldSrc, SE1), Bevy-based ones in particular

### Takeaway
No Rust or Bevy engine rewrite has reached full parity with a classic 3D shooter, even Quake 1, which is several times smaller than SE1. Richter (Quake, Rust) stalled pre-alpha, its server barely started. Its Bevy successor Seismon boots and plays but has never been played through to the end. The only Rust Quake port with near-exact parity (Quake-SRP, October 2026) was an LLM-assisted **translation** of the original C source with a pixel-diff harness, not a redesign on an ECS engine. No Rust, Bevy, Godot, Unity or Unreal reimplementation of Serious Engine 1 was found.

### Cited Findings
- **Richter** (cormac-obrien/richter): Quake engine in Rust, MIT licence. README says "pre-alpha", the client "nearly alpha-ready", the server "still in its early stages". It needs nightly rustc (feature gates and compiler plugins). Stats when fetched on 2026-11-24: 522 commits on `devel`, 572 stars, 37 forks. — [GitHub: richter](https://github.com/cormac-obrien/richter)
- Richter's successor describes it as "now-abandoned". — [search snippet for Seismon / dependabot mirror](https://github-redirect.dependabot.com/eira-fransham/seismon)
- **Seismon** (eira-fransham/seismon): Quake 1 engine on **Bevy**, forked from Richter and built as ECS-style plugins. It uses bevy_seedling (audio), bevy_hanabi (particles), bevy_ui, Bevy rendering, bevy_mod_scripting (QuakeC/Lua) and matchbox (rollback netcode). README: "The game boots and can be played normally". Demos, single-player, level transitions and intermissions work, but the author has **not completed a full playthrough**. 853 commits, 124 stars, 25 open issues; footer © 2026. — [GitHub: seismon](https://github.com/eira-fransham/seismon)
- **Quake-SRP** (2026): a solo developer ported WinQuake from C to **safe Rust** with Claude Code. It keeps the CPU software renderer, runs single-player in the browser and is GPL-2.0-or-later. Its test harness compares behaviour with the original WinQuake. — [RuntimeWire search snippet](https://runtimewire.com/article/quake-srp-rust-port-claude-browser) (the article body could not be fetched)
- Per the same secondary coverage, Quake-SRP's README reports pixel comparisons "across hundreds of frames, all nine maps and two sizes". It records known differences rather than claiming identical behaviour. — [RuntimeWire snippet](https://runtimewire.com/article/quake-srp-rust-port-claude-browser)
- Quake-SRP was discussed on HN on 2026-10-09 (236 points, 178 comments). It includes the shareware episode and both mission packs, and users can load their own data files in the browser. Its "visual diff harness" was cited as proof of pixel parity. One critic: the original C code "was already more or less bug-free". — [zeli.app HN mirror](https://zeli.app/story/50016312)
- **Bevy + Quake map tooling.** `bevy_trenchbroom` loads Quake .map/.bsp files into Bevy. `qbsp` parses BSP29/BSP2/BSP30/BSP38. The bevy_trenchbroom README says the crate is "on low maintenance/life support". Version pairing: Bevy 0.18 ↔ bevy_trenchbroom 0.14. — [lib.rs bevy_trenchbroom](https://lib.rs/crates/bevy_trenchbroom); [GitHub readme](https://raw.githubusercontent.com/Noxmore/bevy_trenchbroom/main/readme.md); [lib.rs qbsp](https://lib.rs/crates/qbsp)
- **Doom in Rust/Bevy.** The closest Bevy project is `sector` (dtcristo), a 2.5D sector/portal renderer on Bevy with a Doom WAD importer. It is a renderer, not a game reimplementation. Other Rust Doom projects (rust-doom, neurodoom, idchoppers WAD library) are not Bevy-based. — [search results incl. gh mirror of dtcristo/sector](https://gh.r-mj.com/dtcristo/sector); [eevee/idchoppers](https://github.com/eevee/idchoppers); [zsabay/rust-doom](https://github.com/zsabay/rust-doom)
- **Bevy itself** still describes itself as early in development. Breaking releases come roughly every few months (it was at 0.18 when bevy_trenchbroom's table was written), which caused churn for the plugins above. — [docs.rs bevy](https://docs.rs/crate/bevy/0.20.0); [lib.rs bevy_trenchbroom](https://lib.rs/crates/bevy_trenchbroom)
- **Veloren** is the largest Rust 3D game, but it is not a remake. It started in 2018 and is about 96% Rust. It had about 100 contributors (2020 interview) and later "well over 200 unique contributors". Open Hub for the 12 months to October 2026: 985 commits (down 36%), 65 contributors (down 26%). — [GamingOnLinux interview 2020](https://www.gamingonlinux.com/2020/06/interviewed-veloren-an-upcoming-foss-multiplayer-voxel-rpg/page=1/); [Open Hub](https://openhub.net/p/veloren)
- **Serious Engine 1 in other engines:** searches turned up no Rust, Bevy, Godot, Unity or Unreal reimplementation. Every live SE1 project is a C++ fork of Croteam's source. — [search results summarised; e.g. Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine)

### Inferences
- Richter (Quake, clean-room Rust) and Seismon (Quake on Bevy) both had the full Quake source, plus decades of Quake format documentation, to work from. Neither has reached a verified full playthrough. SE1 is roughly 400k lines; Quake 1 is far smaller, though no Quake LOC figure was verified here. A Bevy redesign of SE1 is well outside what any comparable project has delivered.
- The one Rust success that shipped near parity (Quake-SRP) kept the **original architecture** (software renderer, same structure) and verified against the original binary. That is a translation strategy, not an "idiomatic Bevy ECS" strategy.
- Bevy's ecosystem for retro-FPS assets is thin and partly unmaintained (bevy_trenchbroom on "life support"). An SE1-on-Bevy project would need to build its own loaders for every SE1 format (.wld, .mdl, .ska, .tex, .ecl).

### Gaps
- Richter's start date and the date of its last commit were not shown on the fetched page. Seismon's contributor count and start date are also unknown.
- Quake-SRP's repo URL (probably github.com/terrapapagalli1516/quake-srp, truncated in the source), line count, elapsed time and model version are unverified.
- No "bevy_quake" project by that name was found. No Rust GoldSrc/Half-Life viewer was found in this pass. A Rust OpenMW attempt (e.g. "openmw-rs") was not searched separately.
- No Rust crate for Serious Sam formats was found. Absence in a search is weak evidence.

---

## 2. Non-Rust engine reimplementations and source ports: time to parity, which stalled and why

### Takeaway
Clean-room reimplementations of 3D games take 5 to 18+ years and often never reach a "1.0". OpenMW was started in 2008 and is still at 0.51 in 2026; OpenRW is dormant. Projects that **started from source code**, whether official (ioquake3, Arx Libertatis, OpenJK, the SE1 forks) or reverse-engineered/decompiled (re3, reVC, DevilutionX), reached a playable state in months to a couple of years. The hard part is the long tail of game logic, not loaders or rendering.

### Cited Findings
- **OpenMW** (Morrowind, C++). 0.1.0 released 2008-06-03 on Ogre3D. The renderer was swapped to OpenSceneGraph in 0.37.0 (around Dec 2015). All Morrowind quests were "fully playable" since 2016, yet the project stayed in extended beta. 0.49.0 (July 2025) was the first release "beyond Morrowind". The latest is **0.51.0 (2026-06-19); there is no 1.0 after 18 years**. Leadership changed twice (founder Nicolay Korslund to Marc Zinnschlag; Bret Curtis announced in 2020). — [Wikipedia: OpenMW](https://en.wikipedia.org/wiki/OpenMW) (edited 2026-11-20)
- **TES3MP** (OpenMW multiplayer): first playable mid-2017; 0.7 alpha (2018-10-09) "mostly feature-complete". — [Wikipedia: OpenMW](https://en.wikipedia.org/wiki/OpenMW)
- **OpenRW** (GTA III clean-room, C++): 2,016 commits, 2.3k stars, 107 open issues. Mission completion is tracked in issue #52, and the README gives no completeness claim. A fork (darkf/openrw) was archived on 2020-11-03. A 2021 forum comment said "Perhaps now someone can pick up OpenRW again", suggesting it was already dormant. No primary source gives the reason it stalled. — [GitHub rwengine/openrw](https://github.com/rwengine/openrw); [darkf fork](https://github.com/darkf/openrw); [GamingOnLinux 2021 thread](https://www.gamingonlinux.com/2021/02/take-two-interactive-hit-the-dmca-nuke-on-gta-iii-and-vice-city-reverse-engineered-effor)
- **re3/reVC** (GTA III/VC, reverse-engineered). reVC started in May 2020 on top of re3's code and was finished by December 2020. Take-Two's DMCA takedown came in February 2021, followed by a lawsuit in September 2021. — [PC Gamer](https://pcgamer.com/reverse-engineered-gta-iii-source-code-is-back-online); [VGC lawsuit](https://videogameschronicle.com/news/take-two-is-suing-the-creators-of-a-gta-3-and-vice-city-reverse-engineering-projects)
- **Devilution/DevilutionX** (Diablo). GalaXyHaXz released reverse-engineered source in June 2018 after about **1,200 hours**, helped by a debug build found in game data. DevilutionX 1.0 came out in January 2020, so about 1.5 years from code to a polished cross-platform engine. — [PC Gamer](https://www.pcgamer.com/a-coder-spent-1200-hours-reverse-engineering-diablos-source-code); [GamingOnLinux Jan 2020](https://gamingonlinux.com/2020/01/devilutionx-an-open-source-game-engine-for-the-original-diablo-sees-a-big-release)
- **OpenRA** (C&C, Red Alert, Dune 2000; C#). It uses date-stamped releases and never versioned a "1.0". Release 20250303 came about 2 years after release 20230225. A 2017 post said the single-engine design meant each release "would unavoidably break community mods". — [OpenRA release 20250303](https://www.openra.net/news/release-202500303/); [OpenRA release 20230225](https://www.openra.net/news/release-20230225/); [Launchpad](https://launchpad.net/openra/release)
- **Status overview** (Wikipedia list, fetched 2026-11-24): Active are OpenRA, OpenTTD, Arx Libertatis, OpenLara, Augustus, fheroes2, CorsixTH, DevilutionX, Xash3D FWGS, OpenJK, re3 and OpenMW. Listed "Completed" are Julius (Caesar III) and OpenXcom. doukutsu-rs (Cave Story) is the visible Rust entry, listed Active. — [Wikipedia: List of game engine recreations](https://en.wikipedia.org/wiki/List_of_game_engine_recreations)
- **[unverified this session]** OpenTTD started in 2004 from a disassembly of TTD and reached 1.0 in April 2010 (~6 years). ioquake3 started in 2005 right after id released the Q3 source. Arx Libertatis started after Arkane's GPL source release in January 2011 and shipped 1.0 in 2012. OpenXcom (clean-room, C++) took about 5 years to 1.0 (2014). OpenRA began in 2007. OpenRW began around 2013. Xash3D began around 2007, with the FWGS fork in 2015. — [Wikipedia: OpenTTD](https://en.wikipedia.org/wiki/OpenTTD); [Wikipedia: ioquake3](https://en.wikipedia.org/wiki/Ioquake3); [Wikipedia: Arx Fatalis](https://en.wikipedia.org/wiki/Arx_Fatalis); [Wikipedia: OpenXcom](https://en.wikipedia.org/wiki/OpenXcom)
- **AI-assisted decompilations (2026).** The ai-rebuilds tracker lists 8 game projects. Super Smash Bros. Melee finished matching in 2026 (project began 2020; AI proposed candidates). Snowboard Kids 2 reached 100% matching with one person running Claude unattended, one function at a time. DX-Ball was reconstructed with differential tests against the original x86 binary. Klonoa started in March 2026 with Claude Code credited. The tracker records almost no line counts, durations or team sizes. — [GitHub a-barzanti/ai-rebuilds](https://github.com/a-barzanti/ai-rebuilds)

### Inferences
- Projects fall into three groups by speed:
  - **Fastest:** official source plus a port, the SE1 forks among them. ioquake3, Arx Libertatis and OpenJK reached playability almost at once.
  - **Next:** reverse-engineered or decompiled code that keeps the original structure. re3/reVC took months; DevilutionX took about 1.5 years to 1.0.
  - **Slowest:** clean-room or architectural rewrites. OpenMW, OpenRA and OpenXcom took 5 to 18+ years, and OpenRW stalled.
- A Bevy rewrite of SE1 is effectively a clean-room re-architecture (ECS instead of CEntity class hierarchy and ES entity scripts), even with the source as reference. It therefore belongs in the slow group despite having source.
- Even "complete" clean-room projects (OpenMW) spend years on the long tail (scripting quirks, physics edge cases, mod compatibility), not on loaders or renderers.

### Gaps
- No primary postmortem explains why OpenRW stalled.
- Precise start-to-1.0 timelines for OpenLara, fheroes2, Julius/Augustus, CorsixTH, GZDoom and Daemon were not verified.
- Contributor counts for most projects were not collected.

---

## 3. Serious Sam / Serious Engine 1: community forks, platform ports, cross-engine attempts

### Takeaway
All SE1 activity since Croteam's 2016 GPL release has been C++ forks of the original source: Linux/macOS (icculus), Vulkan (SeriousSamClassic-VK), the multi-platform SeriousSamClassic, Serious Sam Evolution, SE1 ModSDK/GameShell, plus a hobby Switch port, a halted Android port and an earlier Emscripten web build. **No reimplementation on Bevy, Godot, Unity or Unreal was found.** A working Emscripten port follows the path every successful SE1 project has taken.

### Cited Findings
- Croteam released Serious Engine 1.10 under GPL v2 (2016). Ryan "icculus" Gordon had it running on Linux and macOS by April 2016. "3D Exploration" support is disabled in the open-source version for copyright reasons. — [GamingOnLinux Apr 2016](https://www.gamingonlinux.com/2016/04/serious-engine-1-now-working-on-linux-and-mac-thanks-to-ryan-icculus-gordon); [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine)
- **SeriousSamClassic-VK** (tx00100xt) is based on sultim-t/Serious-Engine-Vk and icculus's port. Vulkan is the default renderer with OpenGL fallback (`sam_iGfxAPI`). It targets Windows, Linux, FreeBSD, OpenBSD, macOS and Raspberry Pi OS; CI covers x86, x64, armv7l, aarch64, mipsel, loongarch64 and e2k. Packaging: Flatpak, Snap, AppImage, PPA, Gentoo, AUR. It supports the XPLUS HD mod. Stats: 311 commits, 165 stars, version tag 1.10.7. — [GitHub SeriousSamClassic-VK](https://github.com/tx00100xt/SeriousSamClassic-VK)
- **SeriousSamClassic** (tx00100xt) is the main maintained source port, with Flathub packaging. Platforms: Windows, Linux, FreeBSD, OpenBSD, NetBSD, macOS, Raspberry Pi OS. Android, Switch and web are not listed. — [GitHub tx00100xt/SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic); [Flathub](https://flathub.org/apps/io.itch.tx00100xt.SeriousSamClassic)
- **Serious Sam Evolution** is a source port based on SE1.10. It reimplements some 1.50-era features (the version behind Serious Sam Revolution) through reverse engineering and datamining of game formats. — [itch.io: Serious Sam Evolution](https://twsdev.itch.io/sse)
- Other C++ community work on SE1 source: DreamyCecil's SE1-ModSDK and Serious-Engine fork, SE1-Community GameShell, fgsfdsfgs and EXL forks, and ptitSeb's fork for Pandora/ARM. — [SE1-ModSDK](https://www.github.com/DreamyCecil/SE1-ModSDK); [SE1-GameShell](https://github.com/SE1-Community/SE1-GameShell); [fgsfdsfgs/Serious-Engine](https://github.com/fgsfdsfgs/Serious-Engine); [EXL/Serious-Engine](https://github.com/EXL/Serious-Engine)
- **Switch port**, based on icculus's fork: initial release in late 2019, described as "very early stage and barebones" and "very janky". — [GameBrew: Serious Engine Switch](https://gamebrew.org/wiki/Serious_Engine_Switch)
- **Android port** (Serious-Sam-Android, TSE) is marked "development halted". — [OSGameClones](https://osgameclones.com/serious-sam-the-second-encounter)
- **Prior web port:** Martin Mullins compiled SE1 to wasm/JS with Emscripten, using gl4es to map OpenGL to GLES. Multiplayer and split-screen did not work, and audio had a small delay. — [search snippet of martinmullins.github.io/blog, now redirects to possiblenull.com](https://martinmullins.github.io/blog)
- **Serious Sam Revolution** appears in SeriousSamClassic-VK only as a Steam bundle link for buying the games. It is Croteam's official (closed) 1.50-era update, not a community fork. — [GitHub SeriousSamClassic-VK](https://github.com/tx00100xt/SeriousSamClassic-VK)

### Inferences
- About ten years of SE1 community work produced many ports and **zero** re-architectures. Maintainers consistently judged re-implementing the entity code (~170k lines including generated ES code) not worth it compared with porting.
- The earlier Emscripten web port had multiplayer and audio problems, so those are known problem areas for a browser target whichever engine is used. They are not, by themselves, evidence that the C++ path is a dead end.

### Gaps
- No date or effort estimate for the Martin Mullins web port; the redirected page possiblenull.com was not fetched.
- Current status of the Android and Switch ports is unknown.
- No attempt to load SE1 assets in Godot/Unity/Unreal was found. Small hobby importers may exist that the search missed.

---

## 4. Automated and LLM-assisted C/C++ to Rust translation at scale (2025-2026)

### Takeaway
By 2026, LLM-assisted ports are proven at the scale of **tens of thousands of lines** when there is a strong oracle. Ladybird ported about 25k lines of LibJS in about 2 weeks with byte-identical AST and bytecode checks and test262. Quake-SRP used pixel diffs against WinQuake. Hand ports at this scale took about 14 months for 57k lines (fish). Mechanical transpilation (c2rust) gets a game running in days but produces unsafe, C-shaped Rust. DARPA TRACTOR is still in evaluation, with no published "solved" result. Microsoft's "1 engineer, 1 month, 1 million lines" was walked back to a research goal. No 400k-line, game-engine-scale LLM port with published metrics exists.

### Cited Findings
- **fish shell** (C++ to Rust, by hand, incremental). The first PR opened 2023-01-28 with an estimate of about half a year. The last C++ code was removed in January 2024 (about 14 months), and the 4.0 beta came on 2024-12-17. About **57k lines of C++ became about 75k lines of Rust**, plus about 400 lines of C. There were 2,604 commits and 498 issues by over 200 authors, but about **7 people did most of the work**. The approach was a "Ship of Theseus" port: a working shell at every step, the original structure kept for side-by-side review, FFI via a forked autocxx. Pain points: autocxx was slow and limited, C++ asserts turned into `.unwrap()` panics, Cygwin support was lost, and CMake stayed. — [fish blog "rustport"](https://fishshell.com/blog/rustport/) (2024-12-28)
- Fish 4.0 shipped in February 2025. — [LWN](https://lwn.net/Articles/1012269)
- An independent study found the Rust fish codebase 16-21% larger than C++ 3.7.1, but it sampled under 2% of the code. — [kiyomoon reverse-rewrite study](https://kiyomoon.github.io/reverse-rewrite/articles/04-fish-shell.md)
- **Ladybird LibJS** (C++ to Rust, Feb 2026): about **25,000 lines** of Rust in **about two weeks** (lexer, parser, AST, bytecode generator), done with Claude Code and Codex. Kling estimates "multiple months" by hand. The process was "human-directed, not autonomous", through "hundreds of small prompts". Requirement: byte-for-byte identical output; every AST and all bytecode matched the C++ versions. Result: **zero regressions** on test262. — [Simon Willison, 2026-02-23](https://simonwillison.net/2026/Feb/23/ladybird-adopts-rust/); original: [ladybird.org/posts/adopting-rust](https://ladybird.org/posts/adopting-rust/)
- **c2rust on Quake 3** (Immunant, 2020-01-05): transpiled ioquake3's UI, game, client, OpenGL1 renderer and main binary. They were "playing the game in Rust after a couple of days". The OpenGL2 renderer, the dedicated server and QVM were skipped. Manual fixes were needed for one-past-end pointers, pre-C99 flexible arrays, tied inline-asm operands and aligned globals. The output is unsafe, C-shaped Rust (a separate "refactored" branch exists). — [Immunant blog](https://immunant.com/blog/2020/01/quake3/)
- **DARPA TRACTOR.** MIT Lincoln Lab is the independent evaluator and releases benchmarks every 6 months. A public battery of 150 C programs exists, with an aggregated evaluation report across 6 performers. Intel (performer) posted on 2026-08-24 about an LLM-plus-C-compatible-wrapper approach that advances when the hybrid passes all tests. DARPA's goal is quality "that a skilled Rust developer would produce". — [MIT LL TRACTOR](https://www.ll.mit.edu/tractor); [DARPA program page](https://www.darpa.mil/research/programs/translating-all-c-to-rust); [Intel "IDEAS for TRACTOR"](https://www.intel.com/content/www/us/en/security/security-practices/blogs/ideas-for-tractor.html); [ORBIT paper, arXiv 2604.12048](https://arxiv.org/pdf/2604.12048)
- **Microsoft.** Galen Hunt's LinkedIn post (around 2025-12-20) set "1 engineer, 1 month, 1 million lines" as a north star to remove C/C++ by 2030. Within days he clarified that Windows is *not* being rewritten in Rust with AI and that this is a research project. — [The New Stack](https://thenewstack.io/microsofts-bold-goal-replace-1b-lines-of-c-c-with-rust/); [InfoWorld](https://www.infoworld.com/article/4111553/microsoft-is-not-rewriting-windows-in-rust.html); [The Register forum](https://forums.theregister.com/forum/all/2025/12/24/microsoft_rust_codebase_migration/)
- **Academic project-level C/C++ to Rust agents (2026)** include His2Trans (arXiv 2603.02617), ORBIT (2604.12048), Translator vs. Challenger (2609.15381), Req2Rust for **C++** (2611.07442), CodeMeepo (2610.34633) and a multi-model study on security-critical C libraries (Future Internet 18(9):471). Their productivity and defect numbers were not extracted in this pass. — [His2Trans](https://arxiv.org/pdf/2603.02617); [Req2Rust](https://arxiv.org/pdf/2611.07442); [Future Internet study](https://doi.org/10.3390/fi18090471)
- **Large agent-built experiments:** FastRender (a browser engine reimplemented by many parallel agents, Cursor research) and solidcore (safe-Rust port of a CAD kernel, many agents under a shared AGENTS.md), both labelled experimental. — [ai-rebuilds tracker](https://github.com/a-barzanti/ai-rebuilds)

### Inferences
- **Throughput benchmarks:**
  - **fish, by hand:** about 57k lines in about 14 months with about 7 core contributors, roughly 4k C++ lines per calendar month.
  - **Ladybird, LLM-assisted with a byte-exact oracle:** about 25k lines in about 14 days, roughly 1.8k lines per calendar day. This is my own arithmetic, not a figure from the source.
  - **Naive scaling to SE1's ~400k lines:** about 8 years at the fish pace, or about 7-8 months at the Ladybird pace. The Ladybird rate assumes a deterministic oracle and a conformance suite, and SE1 has neither out of the box.
- Every fast LLM port used a **translation that preserves structure**, checked by **differential testing against the original binary**: Ladybird (AST/bytecode equality), Quake-SRP (pixel diffs), DX-Ball and the decomps (byte-matching). A Bevy redesign throws that oracle away. Once the architecture changes (CEntity/ES classes become ECS systems), outputs can no longer be compared step by step, and verification falls back to playtesting.
- SE1 has a possible oracle: its demo recording and playback (.dem) plus a deterministic simulation. A structure-preserving C++→Rust translation could be checked by demo replay, as Quake-SRP did with frames. That is a different project from "rewrite on Bevy".
- c2rust shows that mechanical transpilation of id-tech-scale code runs within days, but the result is unsafe Rust with no Bevy benefit. It is a stepping stone, not an end state.

### Gaps
- No published lines-per-day or defect-rate figures for an LLM port above about 100k lines were found.
- TRACTOR's actual 2026 aggregate numbers were not retrieved; they sit in the LL evaluation report.
- Quake-SRP's elapsed time and LOC are unknown, so it cannot calibrate game-specific LLM throughput.

---

## 5. Lessons: what made rewrites succeed or fail

### Takeaway
Rewrites succeed when they **(a) start from source or a faithful decompilation, (b) keep the original structure, (c) stay runnable at every step, and (d) have an automated oracle** (an original binary, a test suite, byte- or pixel-exact diffs). Rewrites stall when they redesign the architecture, rely on volunteers with no oracle, chase 100% fidelity in the game-logic long tail, or face legal or ecosystem churn.

### Cited Findings
- **Keep it working at each step; keep the structure:** fish's explicit lessons were to keep a working program at every step, preserve the original structure so differences are easy to spot, port self-contained parts first, and be careful turning asserts into panics. — [fish blog](https://fishshell.com/blog/rustport/)
- **An oracle makes AI porting safe:** Ladybird required byte-identical AST and bytecode and leaned on test262. Willison notes that a strong conformance suite plus a trusted reference implementation make agentic porting "a safe bet". — [Simon Willison](https://simonwillison.net/2026/Feb/23/ladybird-adopts-rust/)
- **Differential testing against the original:** Quake-SRP (pixel diffs over all maps) [RuntimeWire snippet](https://runtimewire.com/article/quake-srp-rust-port-claude-browser); DX-Ball (differential tests against the original x86), Snowboard Kids 2 (100% match via an unattended per-function loop) [ai-rebuilds](https://github.com/a-barzanti/ai-rebuilds).
- **The long tail kills clean-room projects:** OpenMW had quests "fully playable" by 2016 but is still 0.x in 2026 [Wikipedia: OpenMW](https://en.wikipedia.org/wiki/OpenMW). Seismon plays but has had no full playthrough [GitHub seismon](https://github.com/eira-fransham/seismon). Richter was abandoned pre-alpha with its server unfinished [GitHub richter](https://github.com/cormac-obrien/richter).
- **Re-architecture costs compatibility:** OpenRA's single-engine/multi-mod design broke community mods with every release and stretched gaps between stable releases to about 2 years. — [OpenRA 20230225](https://www.openra.net/news/release-20230225/); [Launchpad](https://launchpad.net/openra/release)
- **Legal risk is low for SE1:** re3/reVC were DMCA'd and sued by Take-Two (2021) because they were reverse-engineered without a licence. SE1 is GPL-2 from Croteam. — [VGC](https://videogameschronicle.com/news/take-two-is-suing-the-creators-of-a-gta-3-and-vice-city-reverse-engineering-projects); [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine)
- **Dependency churn:** bevy_trenchbroom moved to "low maintenance/life support" while tracking Bevy's breaking releases. — [lib.rs bevy_trenchbroom](https://lib.rs/crates/bevy_trenchbroom)
- **Toolchain friction on unusual targets:** fish lost Cygwin because Rust had no target for it. Platform-specific code needed `#[cfg]` hand-listing. — [fish blog](https://fishshell.com/blog/rustport/)

### Inferences (for the SE1 decision)
- The evidence favours **continuing the working Emscripten port**. It sits in the fastest-delivering group (source plus port), keeps 100% fidelity by construction, and matches what every SE1 community project has done for 10 years.
- If Rust is the goal, the best-supported route is **not** a Bevy rewrite. It is a **structure-preserving, LLM-assisted C++→Rust translation, verified by demo replay or frame diffs against the C++ build**, done module by module behind FFI as fish did. Even then, no published precedent exists at 400k lines.
- A Bevy ECS re-architecture of SE1 would be the largest clean-room-style 3D shooter rewrite on record. It would have no oracle, would depend on a pre-1.0 engine with breaking releases, and has no Rust/Bevy precedent that reached parity even for Quake.

### Gaps
- No postmortem from an abandoned Rust engine rewrite (Richter) giving the reasons it stalled.
- No quantitative study comparing clean-room and source-port timelines across projects; the classification above is my synthesis.
