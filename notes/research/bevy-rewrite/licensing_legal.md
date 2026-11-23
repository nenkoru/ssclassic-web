# Licensing and legal constraints of a Rust/Bevy rewrite of Serious Engine 1

> Background research as of 2026-11-24. **This is not legal advice.** It is a map of licenses, published positions (FSF, ASF), and what comparable projects do. Contested points are marked. Anything with real money or a takedown threat behind it needs a lawyer.

Local facts used below (checked directly in this repo):
- `src/` is vendored from tx00100xt/serioussamclassic-vk (SE 1.10, GPL-2.0), per `UPSTREAM.md`. So the code holds copyrights from Croteam **and** from fork contributors, all under GPL-2.0.
- `rust/Cargo.toml` already declares `license = "GPL-2.0-only"` for `se1-mod` and `se1-server`. `cargo metadata --locked` on that workspace (50 packages) finds **no Apache-2.0-only crate**. Every dependency is MIT-or-dual, plus `unicode-ident` under `(MIT OR Apache-2.0) AND Unicode-3.0`. So today's Rust code is clean, and the problem described below starts only when Bevy comes in.
- `data/tfe-full/license.txt` (shipped with the Steam copy) is Devolver Digital's EULA (details under Q3).

---

## Q1. Is a Rust/Bevy rewrite that translates or closely follows SE1 code a derivative work that must be GPL-2.0? What about a clean-room reimplementation from format docs?

### Takeaway
Yes. Translating SE1 C++ into Rust counts as modifying it, so the result has to be distributed under GPL-2.0, and only GPL-2.0, because SE1 has no "or later" clause. A real clean-room reimplementation, written from format specs and observed behaviour without copying SE1's expression, is not bound by the GPL and can take any license (MIT/Apache, GPL-3.0, etc.). The legal line is substantial similarity of protected expression, not which language the code is in.

### Cited Findings
- The SE1 source headers grant only **version 2**. `Sources/Engine/Engine.cpp` reads "under the terms of version 2 of the GNU General Public License as published by the Free Software Foundation", with no "or (at your option) any later version" clause. **SE1 is effectively GPL-2.0-only.** — [Croteam-official/Serious-Engine, Engine.cpp](https://raw.githubusercontent.com/Croteam-official/Serious-Engine/master/Sources/Engine/Engine.cpp)
- The README says "Serious Engine is licensed under the GNU GPL v2", and lists bundled code under other licenses: zlib (`Sources/Engine/zlib`), the NewTek LightWave SDK (`Sources/LWSkaExporter/SDK`), and Xiph libogg/libvorbis. It disables 3D Exploration and IFeel support because of "copyright issues". It ships `SE1_10.GRO` so the engine runs without other resources. Opening TFE/TSE levels requires copying the game's own `.gro` files. — [Croteam-official/Serious-Engine README](https://github.com/Croteam-official/Serious-Engine)
- FSF GPL FAQ (#TranslateCode): "Under copyright law, translation of a work is considered a kind of modification." The GPLv2 definition of a "work based on the Program" also covers the program "translated into another language". — [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#TranslateCode), [GPLv2 text](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)
- FSF GPL FAQ (#GPLStaticVsDynamic): "Linking a GPL covered work statically or dynamically with other modules is making a combined work". So a Rust crate that links or wraps SE1 code is also covered. — [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#GPLStaticVsDynamic)
- The US infringement test, as a commenter summarised it in LWN's chardet coverage, has two prongs: *access* and *substantial similarity*, judged by abstraction-filtration-comparison and case by case. LWN's editor argued that a translation into another language would still be derivative. — [LWN: The relicensing of chardet](https://lwn.net/Articles/1061534/) (commenter opinion, not a legal authority)
- Third-party code inside the SE1 tree keeps its own license: zlib, libogg/libvorbis (BSD-style), and the LightWave SDK (proprietary NewTek terms). — [Serious-Engine README](https://github.com/Croteam-official/Serious-Engine)

### Inferences
- **Options and what each implies:**
  1. **Line-by-line or "close-following" Rust translation of SE1 (including the entity `.es` logic, `ecc`-generated classes, renderer, physics, and network code).** This is a derivative work. It must be **GPL-2.0-only**, the full corresponding source must be offered for every binary (including wasm served to browsers), and it **cannot be relicensed to GPL-3.0 or MIT** without permission from every copyright holder. That means Croteam (now owned by Devolver) *and* the tx00100xt/icculus/other fork contributors whose changes you translated.
  2. **Clean-room reimplementation.** Team A writes specs from SE1 code and file formats (byte layouts, field names needed for interoperability, behavioural descriptions). Team B, which has never read SE1 code, implements from the specs. File formats, constants needed to read the data, and game mechanics/rules are generally treated as unprotectable ideas or functional elements. This route can pick its own license. It is weak for this project, because the current developers (and their LLM tools) have plainly read SE1 source in depth. Clean-room only protects you if you can *document* the separation.
  3. **Hybrid ("written fresh, but using SE1 as a reference").** This is the legally murky middle, and the chardet dispute shows it in action (see Q5). The safest course is to *treat it as derivative* and license it GPL-2.0-only. Then the question of whether it is derivative never matters.
- **Practical recommendation implied:** for a non-commercial open-source project that already vendors SE1 under GPL-2.0, the cheapest legally robust choice is to declare the Rust/Bevy rewrite **GPL-2.0-only** and accept the consequences for dependencies (Q2). An alternative is to ask Croteam/Devolver for an explicit relicensing to "GPL-2.0-or-later" or a linking exception. That would fix Q2 for Croteam's code, but not for fork contributors' code.
- Porting gameplay *rules* (weapon damage numbers, enemy AI behaviour, timings) by observation is far safer than porting code. Numbers and behaviour are facts or functional elements. Copying the `.es` source structure or comments is expression.

### Gaps
- I found no court case on a *language translation* of GPL code specifically. The "translation = modification" position rests on the FSF's reading and general copyright law (translation is a derivative-work right under 17 U.S.C. §101/§106 and the Berne Convention). Case law on clean-room and interoperability (e.g. Sega v. Accolade, Sony v. Connectix, Google v. Oracle) is relevant, but I did not fetch or verify it this session.
- I did not check whether the tx00100xt fork's own contributors added any files with different headers (e.g. "or later" or other licenses). A `grep -L "version 2 of the GNU"` over `src/` would settle it.

---

## Q2. Compatibility: Bevy (MIT OR Apache-2.0) and its dependency tree with GPL-2.0-only

### Takeaway
Bevy itself is fine: it is dual MIT OR Apache-2.0, so you take it under MIT. But **Bevy 0.20.1's default dependency tree contains roughly a dozen Apache-2.0-only crates, including `winit` (windowing) and `cpal` (audio)**. The FSF and ASF both say Apache-2.0 is *not* compatible with GPLv2, and SE1 is GPL-2.0-only. Distributing a GPL-2.0-only SE1-derived binary that statically links `winit`/`cpal` is therefore a license conflict under the mainstream (FSF) reading. GPLv3 or a clean-room permissive license would not have this problem.

### Cited Findings
- FSF license list: Apache 2.0 is **not compatible with GPLv2** (because of its patent-termination and indemnification provisions) but **is compatible with GPLv3**. Expat/MIT, zlib, BSD-2/3, ISC, BSL-1.0, CC0, Unlicense, and Unicode-3.0/Unicode-DFS are GPL-compatible, both v2 and v3 by default ("Unless otherwise specified, compatible licenses are compatible with both GPLv2 and GPLv3"). MPL-2.0 is compatible with GPL-2.0 indirectly via its §3.3 "Secondary License" mechanism. With multi-licensed code, you may choose the compatible option (FSF's example is Perl, where "you can choose either of those two licenses"). — [FSF: Various Licenses and Comments](https://www.gnu.org/licenses/license-list.en.html)
- ASF: the FSF "has never considered the Apache License to be compatible with GPL version 2", citing patent termination and indemnification. Apache-2.0 code can go into GPLv3 projects. — [Apache: GPL compatibility](https://www.apache.org/licenses/GPL-compatibility.html)
- The Linux kernel's SPDX license file states "The Apache-2.0 is not GPL2 compatible." — [Linux kernel LICENSES/dual/Apache-2.0 (mirror)](https://stuff.mit.edu/afs/sipb.mit.edu/contrib/linux/LICENSES/dual/Apache-2.0)
- A guide notes that "GPLv2 or later" projects can escape via GPLv3. GPLv2-only projects cannot. — [FOSSA: Apache-2.0 vs GPL-2.0](https://fossa.com/resources/license-compliance-tools/license-compatibility-checker/apache-2-0-vs-gpl-2-0/)
- Bevy's own `deny.toml` license allow-list: 0BSD, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, CC0-1.0, CDLA-Permissive-2.0, ISC, MIT, MIT-0, Unlicense, Zlib, Unicode-3.0, BSL-1.0. Exceptions are `unicode-ident` (Unicode-DFS-2016/Unicode-3.0) and the `symphonia*` audio decoders (**MPL-2.0**). Bevy explicitly *allows* plain Apache-2.0 dependencies, so nothing in its policy keeps its tree GPLv2-compatible. — [bevyengine/bevy deny.toml](https://raw.githubusercontent.com/bevyengine/bevy/main/deny.toml)
- **Local measurement (this session):** `cargo metadata` on a scratch crate depending on `bevy = "*"`, which resolved to **bevy 0.20.1 (MIT OR Apache-2.0)** with default features. It covers 570 packages across all targets and platforms. 14 crates are **Apache-2.0 only**: `winit 0.30.13`, `cpal 0.17.3`, `ab_glyph 0.2.32`, `ab_glyph_rasterizer`, `owned_ttf_parser 0.25.1`, `accesskit_winit 0.33.2`, `approx 0.5.1`, `ktx2 0.5.0`, `spirv 0.4.0`, `gethostname 1.1.0`, `codespan-reporting 0.13.1`, `gl_generator 0.14.0`, `khronos_api 3.1.0`, `glutin_wgl_sys 0.6.1`. In addition, `dpi 0.1.2` is `Apache-2.0 AND MIT` (also needs Apache). `bevy_mikktspace` is `Zlib AND (MIT OR Apache-2.0)` (fine via MIT). 22 ICU4X/zerovec crates are Unicode-3.0 (GPL-compatible per FSF). One crate offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later` (fine). Everything else is MIT-or-dual, Zlib, BSD, ISC, BSL, 0BSD, MIT-0, CC0, or Unlicense. — method: `cargo metadata --format-version 1` (scratch project in session scratchpad); licenses as declared in each crate's Cargo.toml, not audited per file.
- The existing `rust/` workspace (`se1-mod`, `se1-server`, GPL-2.0-only) has no Apache-only crates (local `cargo metadata --locked`).

### Inferences
- **What "dual MIT/Apache" buys you:** for crates licensed `MIT OR Apache-2.0` (the large majority, including Bevy itself), you elect MIT and they are compatible with GPL-2.0. **This does not help with the Apache-2.0-only crates above.**
- **Which Apache-only crates actually land in each build** (inferred from their roles, not measured per target):
  - `winit`, `dpi`, `accesskit_winit`: bevy_winit windowing. These are in **desktop and web** builds unless you replace Bevy's windowing/runner.
  - `cpal`: bevy_audio backend (via rodio). In desktop and web unless `bevy_audio` is disabled.
  - `ab_glyph`, `ab_glyph_rasterizer`, `owned_ttf_parser`: text/font rendering (bevy_text). Note the list above also contains crates that are probably in the tree via `cosmic-text`/`skrifa`, which are MIT/Apache.
  - `ktx2`: KTX2 texture support (bevy_image feature).
  - `spirv`, `codespan-reporting`: naga/wgpu shader stack.
  - `gl_generator`, `khronos_api`, `glutin_wgl_sys`: build-time GL bindings, Windows only. They are build tooling or platform-specific, but generated code still ends up in the binary.
  - `approx`, `gethostname`: small utilities.
- **Options for a GPL-2.0-only Bevy port:**
  1. *Strip Apache-only crates.* Use `default-features = false`. Write your own windowing/runner (on web, a canvas plus `web-sys`; on desktop, e.g. SDL2 via `sdl2` (MIT) or `miniquad`-style backends). Use your own audio (web: WebAudio via `web-sys`; desktop: an MIT backend). Avoid `bevy_text`'s ab_glyph path and `ktx2`. This is feasible but costly, and it fights Bevy's defaults. It also needs ongoing `cargo deny` enforcement with an allow-list that *omits* `Apache-2.0`.
  2. *Ask upstream crates to add MIT.* `winit` and `cpal` are both Apache-2.0-only as of this resolution. Relicensing needs all their contributors' consent, so this is unlikely in the short term.
  3. *Get Croteam/Devolver to relicense SE1 as GPL-2.0-or-later or add an exception.* That would allow GPLv3, which is Apache-compatible. It needs the fork contributors' agreement too, for any of their code you use.
  4. *Clean-room rewrite under GPL-3.0-or-later or MIT/Apache.* Bevy's full tree is then fine.
  5. *Accept the incompatibility as low enforcement risk.* Many projects ship GPLv2 plus Apache code in practice. The only party with standing to complain about the GPL side is the SE1 copyright holders (Croteam/Devolver and fork contributors), and on the Apache side the crate authors. This is a *risk acceptance*, not compliance, and it would make the project ineligible for strict distributions such as Debian or Fedora.
- MPL-2.0 `symphonia` (only if enabled for audio decoding) is GPL-2.0-compatible via MPL §3.3. You must keep MPL files' source available and under MPL.
- SE1's bundled libogg/libvorbis and zlib are fine (BSD/zlib). The **LightWave SDK** under `Sources/LWSkaExporter/SDK` is not GPL and should not be ported or redistributed in the rewrite. It is only used by an exporter tool anyway.

### Gaps
- The 570-package scan is all-target (it includes Windows/macOS/Android-only crates). I did not run a per-target `cargo tree -e normal --target wasm32-unknown-unknown` to list exactly which Apache-only crates reach the wasm build. Recommended follow-up: run `cargo deny check licenses` with `allow` lacking `Apache-2.0`, for both `wasm32-unknown-unknown` and the desktop target.
- I did not verify the license *files* of `winit`/`cpal` beyond Cargo.toml metadata (both declare `Apache-2.0`).
- I found no published FSF or Bevy statement specifically about GPLv2 projects using Bevy.

---

## Q3. Distributing original game data; demo status; how similar projects handle it; trademark and naming

### Takeaway
The game assets are proprietary, and the current Steam EULA (Devolver Digital) forbids copying, distributing, or network-hosting them. The open-source port ecosystem (DevilutionX, ioquake3, tx00100xt SeriousSamClassic) therefore ships **engine code only** and makes users supply their own data. They use *official freely distributed shareware/demo files* only where the rights holder released them as such. I found **no explicit redistribution grant** for the TFE demo, so serving the demo `.gro` files from your own host is a grey zone. "Serious Sam" is a registered or applied-for trademark of Croteam/Devolver, so the project should not be *named* "Serious Sam".

### Cited Findings
- **Steam copy EULA** (local `data/tfe-full/license.txt`, Devolver Digital): it grants a license "to use one copy of the Software for your personal non-commercial use". It says the Software "may not be copied, reproduced or distributed in any manner or medium, in whole or in part, without prior written consent". It prohibits "(d) Making a copy of this Software available on a network for use or download by multiple users" and "(h) Reverse engineer, decompile, disassemble, prepare derivative works based on or otherwise modify the Software". It points to the current version at devolverdigital.com/eula. — local file `data/tfe-full/license.txt` (Devolver EULA text shipped with the Steam release); [Devolver EULA](https://www.devolverdigital.com/eula)
- **TFE demo (local copy `data/tfe-demo-raw/Disk1`, original 2001 InstallShield demo, plus `serioussampatch105_usa.exe`):** its `ReadMe.htm` carries "Copyright (c) 2000 Croteam, Ltd. All Rights Reserved" and a 1998 Gathering of Developers copyright. A grep for "distribut", "freely", and "shareware" in the demo's text files found **no redistribution grant** (only the LGPL notice for the bundled amp11lib). — local files (grep in this session)
- tx00100xt/SeriousSamClassic: "You can buy the original games on Steam, as a part of a bundle with Serious Sam Revolution". Its demo build uses "official demo files for Windows and official patches for the game from Croteam", which "are automatically downloaded and unpacked in demo build scripts". In other words, it *fetches from third-party hosts at build time* rather than committing the files. It is packaged on Flathub, Snap, an Ubuntu PPA, the Gentoo official repo, AUR, AppImage, and OpenBSD. Its README has **no trademark disclaimer** and uses "Serious Sam Classic" as the project name. — [tx00100xt/SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic)
- Community commentary when SE1 was opened in 2016: "only the source code has been released... Art assets and the Serious Sam IP have not." — [GamingOnLinux, Croteam releases Serious Engine 1.10 (comments)](https://www.gamingonlinux.com/2016/03/croteam-releases-serious-engine-version-110-as-free-software/page=1/)
- **DevilutionX:** "You'll need access to the data from the original game". `DIABDAT.MPQ` comes from CD/GOG, and the shareware `spawn.mpq` can be used for the shareware portion. It ships no data. Its disclaimer says it is "in no way associated with or endorsed by Blizzard Entertainment®". Notably, it is **not GPL**: it uses a non-commercial "Sustainable Use License", because the code descends from a decompilation rather than a released source. — [diasurgical/devilutionX](https://github.com/diasurgical/devilutionX)
- **ioquake3:** users install `pak0.pk3` from Steam/GOG/CD. "You still need to buy Quake 3: Arena to play". Demo users can copy `demoq3/pak0.pk3` from the official demo installer. ioquake3 uses the "Quake 3" name descriptively but publishes no trademark guidance. — [ioquake3 Players' Guide](https://ioquake3.org/help/players-guide/)
- **"Serious Sam" trademark filings:** a USPTO application owned by Croteam, Ltd. (serial 76147261, downloadable computer game software). After the Devolver acquisition (October 2020), Devolver Digital, Inc. filed several SERIOUS SAM marks, e.g. serial 90650591 (filed 2021-06-03) and serial 90752201. I could not confirm current status from these aggregators. — [Justia: Croteam, Ltd. trademarks](https://trademarks.justia.com/owners/croteam-ltd-1138924), [Justia: SERIOUS SAM 90752201](https://trademark.justia.com/907/52/serious-90752201.html), [Justia: Devolver Digital trademarks](https://trademarks.justia.com/owners/devolver-digital-inc-5285337)

### Inferences
- **Must not:** commit, bundle, or serve full-game data (levels, models, textures, sounds, music, `.gro` from Steam/CD). That violates both copyright and the EULA's "(d) on a network" clause. Do not ship assets extracted or converted from the full game (e.g. pre-baked glTF/PNG conversions of TFE models). Converted assets are still derivative copies.
- **User-supplied data** in a web build is the established safe pattern: a local file picker, or drag-drop of `.gro` files kept in the browser (IndexedDB/OPFS) and never uploaded. Each user then makes their own personal-use copy. Note that EULA clause (h), "modify the Software", is in tension with *any* source port. Every port listed above (and SE1's own release) lives with this, and no enforcement against BYO-data SE1 ports has been reported.
- **Demo data:** the strongest position is to have the client **download it from an official or long-standing third-party mirror at runtime**, as tx00100xt does at build time, rather than rehosting it on your own domain. Even better is an explicit written OK from Croteam/Devolver. Rehosting the demo on GitHub Pages is the riskiest of these options, since no grant was found.
- **Naming:** use a neutral project name ("SE1-web", "Serious Engine Web Port", or something unrelated). Avoid "Serious Sam" in the product name, domain, logo, or icons. Nominative descriptive use ("plays Serious Sam: The First Encounter data, requires a copy of the game") plus a non-affiliation disclaimer, as DevilutionX does, is the common practice. Do not use Croteam/Devolver logos or the Sam character art in branding. "Serious Engine" is Croteam's product name too, but it is the name of the GPL release itself. Using it descriptively ("based on Serious Engine 1") is what forks do. Whether it is a registered mark is not verified.
- GPL-2.0 does not cover the game data. The engine can be GPL while the data stays proprietary. That is the model of every id Software source release, and of SE1 itself (the README tells you to copy the game's `.gro` files in).

### Gaps
- I could not fetch USPTO TSDR or EUIPO directly (Justia returned 403). The registration status and classes of SERIOUS SAM marks, and whether "Serious Engine" is registered, are unverified.
- I found no Croteam/Devolver statement on redistribution of the 2001 TFE demo or the 1.05 patch, or on fan ports generally. tx00100xt's packaging on Flathub/Snap and in the Gentoo repo without incident is circumstantial evidence of tolerance, not permission.
- I did not verify OpenMW, OpenRA, or Xash3D policies this session. From prior knowledge (not verified): OpenMW requires the user's Morrowind data. Xash3D FWGS has known licensing friction because it links the non-free Half-Life SDK.

---

## Q4. Hosting a playable web build publicly: takedown precedent and how projects stay safe

### Takeaway
Takedowns of browser ports have hit projects that **served copyrighted game assets** (a Super Mario 64 browser remake, an HTML5 StarCraft) or that **circumvented access controls** (Diablo II: Resurrected offline patches). A browser Diablo port running only the official shareware data, with full data optional and user-supplied, has stayed up. The safe pattern is engine-only hosting, plus demo data from official sources or user-provided data, plus no trademarked branding.

### Cited Findings
- Nintendo had a browser-playable Super Mario 64 remake (Unity, fan-made assets recreating the game) pulled via a DMCA notice to CloudFlare in 2015. — [GameSpot: Nintendo forces takedown of Super Mario 64 HD browser project](https://gamespot.com/articles/nintendo-forces-takedown-of-super-mario-64-hd-brow/1100-6426295/)
- In May 2020 Nintendo (via Wildwood Law Group) sent takedowns against the Super Mario 64 PC port built from the decompilation. They hit download hosts and YouTube videos. Prebuilt binaries contained the game's assets. — [TorrentFreak](https://torrentfreak.com/nintendo-lawyers-file-copyright-complaints-against-super-mario-64-pc-port-200508/), [PC Gamer](https://www.pcgamer.com/nintendo-takes-action-against-that-really-good-mario-64-pc-port)
- Blizzard took down a popular HTML5 StarCraft project's repository on GitHub. — [TorrentFreak: Blizzard nukes popular HTML5 version of StarCraft](https://torrentfreak.com/?p=111701)
- Blizzard's DMCA notice removed Diablo II: Resurrected offline patches from GitHub on DMCA §1201 grounds (circumventing access controls). — [TorrentFreak](https://torrentfreak.com/blizzard-dmca-notice-wipes-diablo-ii-resurrected-offline-patches-from-github-210610/)
- A browser version of the original Diablo (by RivSoft, from Devilution) runs the shareware version for free. Users can supply the full `DIABDAT.MPQ` to unlock the full game. The developers said they "aren't really sure whether it's legal". No takedown was reported. — [TechSpot](https://www.techspot.com/community/topics/diablo-is-available-to-play-for-free-in-your-web-browser.255760)
- In 2011 Mozilla removed a JavaScript port of the open-source Doom from its site while it checked the terms of use. — [Mozilla Bugzilla 662123](https://bugzilla.mozilla.org/show_bug.cgi?id=662123)

### Inferences
- **Do:** host only GPL engine code (wasm and JS) plus your own original UI. Load demo data from official or long-standing sources, or bring-your-own-data stored client-side. Offer full corresponding source (a link to the exact commit) next to the web build, because serving wasm/JS to browsers is distribution under the GPL. Add a non-affiliation disclaimer. Use a neutral name. Answer any takedown quickly and cooperatively.
- **Don't:** proxy or cache full-game `.gro` files server-side. Don't offer "play TFE full in browser" without user data. Don't circumvent Steam DRM (TFE on Steam is reportedly DRM-free, but if any build used Steam auth, bypassing it would be a §1201 issue). Don't use Sam artwork or the Serious Sam logo in the page or favicon. Don't monetise (ads or donations tied to "play Serious Sam free").
- Multiplayer servers (`se1-server`) that relay game state are fine. Any server that hosts levels for clients to download would be redistributing assets.

### Gaps
- I found no takedown involving any Serious Sam/SE1 port, and no public Croteam/Devolver statement about fan ports or web builds.
- I did not verify whether well-known browser Quake/Doom ports (which ship id's shareware `pak0.pak`/`doom1.wad`) rely on an explicit shareware redistribution license. id's shareware did carry such terms, but I did not fetch them this session.

---

## Q5. LLM-assisted translation: does machine-translated GPL code stay GPL?

### Takeaway
There is no court ruling. The 2026 chardet controversy is the main public test case. The maintainer used Claude to rewrite an LGPL library and relicensed it MIT. The original author, plus figures like Armin Ronacher and LWN's editor, regard it as still derivative, because the model and the humans had access to the original. The defenders say no copyrightable expression persists. For a *translation* that follows SE1 closely, nobody seriously argues the GPL falls away. Using an LLM does not "launder" the license, so treat LLM-translated SE1 code as GPL-2.0-only.

### Cited Findings
- chardet 7.0.0 (March 2026) was billed as a ground-up, MIT-licensed rewrite of the LGPL `chardet`, driven largely by an LLM (Claude). Original author Mark Pilgrim said the maintainers have no right to relicense, and demanded a revert to LGPL. — [Phoronix](https://phoronix.com/news/chardet-llm-rewrite-relicense), [LWN](https://lwn.net/Articles/1061534/)
- Maintainer Dan Blanchard says he worked in "an empty repository with no access to the old source tree" and told Claude not to use (L)GPL code. Pilgrim counters that the maintainers had "ample exposure to the originally licensed code". Simon Willison noted the LLM did access the LGPL source at one point, per a planning document. — [LWN](https://lwn.net/Articles/1061534/), [Simon Willison](https://simonwillison.net/2026/Mar/5/chardet), [Blanchard's blog](https://dan-blanchard.github.io/blog/chardet-rewrite-controversy/)
- LWN's editor: a translation into another language would still be derivative. Claude's training data probably included earlier chardet versions, which "muddies the picture". Similarity checkers can miss rewrites. Pilgrim: adding "a fancy code generator into the mix" grants no new rights. — [LWN](https://lwn.net/Articles/1061534/)
- Armin Ronacher considers the new implementation a derived work. Willison says no one has shown persistence of copyrightable expression in 7.0.0. — [Armin Ronacher, "Theseus"](https://lucumr.pocoo.org/2026/3/5/theseus/), [Simon Willison](https://simonwillison.net/2026/Mar/5/chardet)
- Bruce Perens argued the dispute shows AI could undermine software licensing. — [The Register](https://www.theregister.com/2026/03/06/ai_kills_software_licensing/)
- Fedora's legal list noted that putting an MIT license on code that is largely AI-generated may be questionable, since such code may not be copyrightable. LWN commenters discussed *Thaler* (human authorship requirement). — [Fedora legal list](https://lists.fedoraproject.org/archives/list/legal@lists.fedoraproject.org/thread/67RIQBACH6FN6FGOTJPAXHX4YL5Q2HPG/), [LWN](https://lwn.net/Articles/1061534/)
- None of the coverage reports a court ruling or settlement as of the latest articles found. — [LWN](https://lwn.net/Articles/1061534/), [Phoronix](https://phoronix.com/news/chardet-llm-rewrite-relicense)

### Inferences
- An LLM *translating* SE1 C++ to Rust with SE1 in its context is a mechanical translation. It is the clearest derivative-work case (GPL FAQ #TranslateCode), and the tool used doesn't change that. **The output must be GPL-2.0-only.**
- The "AI output isn't copyrightable" argument cuts the wrong way for anyone hoping to escape the GPL. If the translated code has no *new* copyright, what remains is Croteam's copyright in the original expression, which is still GPL-2.0. The new code adds no independent licensable authorship.
- If the team ever wants a permissively licensed or GPLv3 engine (to solve Q2), the only defensible route is a documented clean room: separate people, a spec-only handoff, no SE1 source in the implementer's or LLM's context, and similarity checks. chardet shows that even a documented attempt gets challenged when the same people had prior access.
- Keep a provenance log (what came from SE1 and what is new) in commit messages. It helps with GPL compliance either way.

### Gaps
- I found no FSF, OSI, or SFC formal statement specifically on LLM translation of GPL code (an SFC post on the *Thaler* cert denial was linked in LWN comments but not read).
- I found no case law in the EU (Croatia is Croteam's jurisdiction) on AI-assisted derivative works.
