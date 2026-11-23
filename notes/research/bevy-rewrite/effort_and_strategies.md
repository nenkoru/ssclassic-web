# Effort estimation and migration strategies: SE1 browser port → Rust/Bevy

Research date: 2026-11-24. Numbers marked **[estimate]** are mine, not published. Local measurements
come from the repo at `/Users/cernenkoruslan/code/repos/serioussam-web` (cited as file paths).

**Codebase baseline (measured locally, `wc -l`, 2026-11-24):**
- `src/SamTFE/Sources/Engine`: 232,270 lines (.cpp/.h/.c). Largest parts: Graphics 79,827 (includes
  the GL/D3D drivers), Base 26,482, Network 17,330, Models 13,354, Math 11,876, Ska 11,552,
  Entities 8,706, Terrain 8,380, Rendering 7,456, World 7,177, Brushes 7,062, zlib 6,734, Sound 5,909.
- Entity code in Croteam's `.es` DSL: `Entities/` (TFE) 64,153 lines; `EntitiesMP/` (TSE) 81,010 lines.
- `Game*` + `SeriousSam`: 27,482 lines.
- Rust mod layer `rust/`: 9,395 lines.
- `NET_MAXGAMEPLAYERS` is 16 (`Engine/Network/Network.h:30`).
- **[estimate]** The part that a TFE-only web build actually needs, without D3D/Win32 drivers, the
  editor, terrain, zlib and TSE entities: about 200–250k lines.

## 1. Which strategies are technically feasible? (a) full Bevy rewrite, (b) strangler fig, (c) Bevy renderer plus SE1 sim in one wasm, (d) c2rust, (e) LLM-assisted translation, (f) wgpu renderer only

### Takeaway
(b), (e) and (f) are feasible today with the current Emscripten build. (c) runs into a toolchain
mismatch: Bevy supports only `wasm32-unknown-unknown`, and wgpu under Emscripten supports only the
GLES path. Emscripten/wasm-bindgen interop only reached an experimental preview in September 2026.
(d) does not apply, because c2rust translates C99, not C++. (a) is feasible, but it is the most
expensive option and the parity risk is highest.

### Cited Findings
- **Bevy's web target.** A Bevy maintainer-side comment calls `wasm32-unknown-unknown` the only wasm
  platform where Bevy supports `std`. Others "likely will need to be treated as `no_std`". —
  [bevy PR #17499](https://github.com/bevyengine/bevy/pull/17499) (search snippet; the comment's date
  is not verified).
- **Bevy on the web is single-threaded natively.** The Bevy CLI docs say the engine doesn't support
  multi-threaded web apps natively. An experimental `web-multi-threading` flag exists and needs
  cross-origin isolation. Single-threading shows especially as audio stutter. —
  [Bevy CLI: web multi-threading](https://thebevyflock.github.io/bevy_cli/cli/web/multi-threading.html)
- **Why Bevy stays single-threaded on the web.** PR #12205 let Bevy compile with `atomics`, but it
  doesn't multithread Bevy itself, because wgpu types are not Send/Sync on the web. —
  [bevy PR #12205](https://github.com/bevyengine/bevy/pull/12205); old tracking issue
  [#4078](https://github.com/bevyengine/bevy/issues/4078)
- **Bevy 0.19 (2026-06-19)** has no web, WebGPU, Emscripten or web-threading changes beyond
  cancellable tasks on wasm. Its new BSN scene system is described as having "rough edges and missing
  features". — [Bevy 0.19 release notes](https://bevy.org/news/bevy-0-19/)
- **wgpu under Emscripten** uses the GLES/WebGL path (`gles,emscripten,webgl` features), not WebGPU.
  Support is minimal: "At the moment `wgpu` has one example meant to run under Emscripten"
  (`raw-gles.rs`). — [wgpu docs: Emscripten](https://wgpu.rs/doc/wgpu/documentation/platforms/emscripten/index.html)
- **Rust's Emscripten target** `wasm32-unknown-emscripten` is Tier 2. —
  [rustc platform support](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-emscripten.html)
- **Emscripten and wasm-bindgen interop.** On 2026-09-28 Cloudflare announced the "first public
  experimental preview" of interop through Emscripten's `-sWASM_BINDGEN`:
  - C++ built with Emscripten can link static wasm-bindgen Rust code.
  - Rust apps using wasm-bindgen can build for the Emscripten target.
  - Some low-level crates needed patches; Tokio support is partial and still under upstream review.

  — [Cloudflare blog](https://blog.cloudflare.com/rust-workers-emscripten-target/)
- **c2rust:**
  - It "helps you migrate C99-compliant code to Rust". The page says nothing about C++.
  - "The output of `c2rust transpile` is unsafe and unidiomatic".
  - Its LLM postprocessor "can introduce errors", so it should be paired with a robust test suite.

  — [immunant/c2rust](https://github.com/immunant/c2rust)
- **Research on cleaning up c2rust output:**
  - C2SaferRust (c2rust plus LLM) reduces unsafe code by up to 28%. —
    [arXiv 2501.14257](https://arxiv.org/html/2501.14257v2)
  - Rustine argues that c2rust output relies heavily on unsafe and mirrors the C structure. —
    [arXiv 2511.20617](https://arxiv.org/pdf/2511.20617)
- **Fish's incremental FFI port hit friction:**
  - autocxx struggled with some C++ constructs. They forked it for wstring/wchar.
  - Wrapping `vector` and using `unique_ptr` temporarily hurt performance.
  - rust-analyzer was slow.

  — [fish blog: rustport](https://fishshell.com/blog/rustport/)
- **Strangler fig.** Martin Fowler's pattern: grow the new system around the old one and route
  functionality to it piece by piece until the old one can be retired. —
  [martinfowler.com: StranglerFigApplication](https://martinfowler.com/bliki/StranglerFigApplication.html)
  (well-known page; not re-fetched in this session)
- **The classic warning against rewrites.** Throwing away working code discards years of embedded
  bug fixes, and the rewrite freezes the shipping product. —
  [Joel Spolsky, "Things You Should Never Do, Part I"](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/)
  (not re-fetched in this session)
- **The project's own architecture already is a strangler fig:**
  - Engine edits are "thin hooks" into glue or the Rust mod.
  - The host table is append-only, with the API version bumped on each addition.

  — local `notes/features.md`, rules 1–3. The engine runs in a worker and streams GL commands to
  the page, which renders them through WebGL2 or WebGPU (`port/common/gl1shim.c`,
  `port/web/gfx.js`, `port/web/gfx-webgpu.js`; local `notes/roadmap.md`).

### Inferences
- **(c) Hybrid in the same wasm.** Linking Emscripten-compiled SE1 objects into a Bevy
  `wasm32-unknown-unknown` binary is not a supported path. SE1 depends on Emscripten's libc,
  pthreads, WASMFS, SDL and JS glue, none of which exist on `wasm32-unknown-unknown`. The inverse
  (Bevy built for `wasm32-unknown-emscripten`) has three problems:
  - Bevy does not support that target.
  - wgpu's Emscripten path is GLES-only, which loses WebGPU.
  - The wasm-bindgen interop that would make it viable is an experimental preview from September 2026.

  Treat it as a 1–2 week spike with a high chance of failure in 2026, possibly maturing in 2027.
  **[estimate]**
- **(c′) A realistic variant: two wasm modules in one page.** SE1 keeps running in its Emscripten
  worker. A separate Bevy module renders from a scene-description stream through SharedArrayBuffer,
  the same pattern as today's GL command stream. The cost is a new "render scene" boundary: the
  engine's renderer is immediate-mode, and entity code calls particle and model render functions
  directly. Bevy's renderer would then have to recreate SE1's look:
  - brush polygons with shadow-map layers;
  - vertex-animated `.mdl` models;
  - particles, lens flares, the sky (background viewer), HUD and fonts.

  That is close to rewriting the Graphics/Rendering/Models code (about 100k lines) and gains little
  over adding passes to the existing renderer. **[estimate]**
- **(d)** does not apply to SE1, which is C++ with classes, virtuals, templates and macro-heavy `.es`
  output. The only C in scope (zlib, libogg/vorbis) already has Rust crates.
- **(e) at subsystem granularity is (b) with translation instead of redesign.** The Ladybird approach
  fits: mirror the C++ structure first and make it idiomatic once the C++ is gone (see Q2).
- **(f) is mostly done.** The port already has WebGPU through `gl1shim` + `gfx-webgpu.js`. Moving
  the renderer into Rust wgpu inside the Emscripten build would *regress* it to GLES, per the wgpu
  docs. So the valuable form of (f) is "add passes in the existing JS/WGSL backends".
- **Licensing.** A translated SE1 is a derivative of GPL-2.0 code and stays GPL-2.0. Bevy's
  MIT/Apache-2.0 is compatible. (Inference; no legal source checked.)

### Gaps
- No official Bevy statement for 2026 on `wasm32-unknown-emscripten`. The newest evidence is the
  maintainer-side comment above plus the 0.19 notes, which are silent on it.
- I found no public project that links an Emscripten C++ engine with Bevy in one wasm.
- I did not verify whether Rust's `wasm32-unknown-unknown` C ABI now matches clang's well enough to
  link plain C objects. It would not help with Emscripten's runtime anyway.

## 2. What does published productivity data say for C++→Rust ports and LLM-assisted translation?

### Takeaway
- **Manual, incremental, test-backed ports run at hundreds to a few thousand lines per person-month.**
  Fish took about 57k C++ lines, seven core people and about 12 months to remove the C++.
- **AI-directed ports with very strong oracles reached 25k–100k lines in 2–4 weeks for one person.**
  Ladybird's oracle was test262 plus its regression suite; vjeux's was millions of seeded differential
  runs.
- **Academic benchmarks** show high per-function compile rates but much lower repository-level
  functional accuracy.
- **Vendor claims** of "1M lines/engineer/month" are aspirations, not results.

### Cited Findings
- **Fish shell (manual, incremental, FFI via autocxx):**
  - Timeline: PR opened 2023-01-28, merged 2023-02-19; last C++ removed January 2024; first beta
    2024-12-17. Described as "almost 2 years of work".
  - Size: about 57K lines of C++ became about 75K lines of Rust (plus about 400 lines of C).
  - Effort: 2,604 commits by more than 200 authors, but seven people with at least 10 commits to
    `.rs` files did most of the work.
  - Estimate vs actual: the initial estimate was "handwaving, half a year"; "14 months was still a
    pretty good pace".
  - Bugs: `assert` and `unwrap()` caused crashes where the C++ behaved differently.

  — [fishshell.com/blog/rustport](https://fishshell.com/blog/rustport/)
- **Ladybird LibJS frontend (Feb 2026, AI-assisted):**
  - Scope: lexer, parser, AST, scope collector and bytecode generator, about 25,000 lines of Rust in
    about two weeks, using Claude Code and Codex.
  - Human direction: Andreas Kling chose what to port, the order and the structure.
  - Verification: it passed more than 52,000 test262 tests and about 12,000 regression tests with no
    performance regression.
  - Style: deliberately non-idiomatic, "translated from C++".
  - Counterfactual: the team estimates the work would have taken several months by hand.

  — [ladybird.org: Adopting Rust](https://ladybird.org/posts/adopting-rust/);
  [The Register](https://www.theregister.com/2026/02/23/ladybird_goes_rusty/);
  [Ladybird Feb 2026 newsletter](https://ladybird.org/newsletter/2026-02-28/)
- **vjeux, Pokémon Showdown (about 100k lines TS→Rust, Claude Code):**
  - Time: about 4 weeks with the agent running around the clock; "two weeks on my own" of human time.
  - Commits: about 5,000.
  - Testing: differential testing over 2.4M seeded battles left about 80 divergences (about 0.003%).
    Fixes ran at about one issue per 20 minutes for about three weeks.
  - Failure modes:
    - "simplified" logic instead of faithful ports, and inconsistent duplicate structs;
    - the agent edited the reference source;
    - context compaction erased working state;
    - optimization attempts mostly failed.
  - Lesson: port everything, then integrate, rather than building up incrementally.

  — [blog.vjeux.com](https://blog.vjeux.com/2026/analysis/porting-100k-lines-from-typescript-to-rust-using-claude-code-in-a-month.html).
  A secondary write-up gives 99.96% agreement over 2M battles and a 3.5× speedup —
  [GeekNews](https://news.hada.io/topic?id=26295). That conflicts with the primary post, which
  gives no speedup figure and about 0.003% divergence; prefer the primary.
- **Google giflib → Rust (InfoQ, Sept 2026):**
  - Size: about 3,000 lines.
  - Method: Gemini single-shot port; human experts fixed pointer ownership and lifetimes.
  - Verification: a differential fuzzer ran for 6 days and 200M iterations without functional drift,
    and 30M+ real GIFs rendered bit-for-bit.
  - Lessons: AI translation is "not hands-off", and FFI wrappers still need human expertise.

  — [InfoQ](https://infoq.com/news/2026/09/c-rust-rewrite/)
- **Quake-SRP (2026).** A solo developer ported Quake (C) to safe Rust with Claude Code; it runs in
  the browser. A headless build of id's C source serves as the reference. Rendered pixels, UI, audio
  and game state are compared during demo playback. — search-result summary of
  [RuntimeWire](https://runtimewire.com/article/quake-srp-rust-port-claude-browser). **Unverified:**
  the fetch returned only a site manifest, and I found no line counts, timeline or repo URL.
- **Google Android (Nov 2025).** For medium and large changes, Rust changes roll back about 4× less
  often than C++, need about 20% fewer revisions and spend about 25% less time in review. —
  [Google blog, "Rust in Android: move fast and fix things"](https://blog.google/security/rust-in-android-move-fast-fix-things/)
- **Microsoft (Dec 2025).** Galen Hunt's "1 engineer, 1 month, 1 million lines of code" North Star
  for AI-assisted C/C++→Rust was later clarified: "Windows is *NOT* being rewritten in Rust with AI"
  and "My team's project is a research project". —
  [InfoWorld](https://www.infoworld.com/article/4111553/microsoft-is-not-rewriting-windows-in-rust.html);
  [The Register](https://www.theregister.com/2025/12/24/microsoft_rust_codebase_migration)
- **DARPA TRACTOR.** MIT Lincoln Laboratory is the independent evaluator and publishes benchmark
  batteries. At NDSS 2026 the PM said it is too early to declare anyone "winning". The benchmark
  paper (arXiv 2609.25121, 2026-09-20) covers correctness, safety, idiomaticity and performance
  metrics; its abstract reports no numbers. —
  [MIT LL TRACTOR](https://www.ll.mit.edu/tractor); [DARPA](https://www.darpa.mil/research/programs/translating-all-c-to-rust);
  [NDSS 2026 keynote](https://www.ndss-symposium.org/wp-content/uploads/NDSS-2026-Keynote-DWallach.pdf);
  [arXiv 2609.25121](https://arxiv.org/abs/2609.25121)
- **Academic benchmarks (C→Rust; definitions of "success" differ):**
  - SafeTrans: GPT-4o success 54%→80% with iterative repair, on 2,653 C programs. —
    [arXiv 2505.10708](https://arxiv.org/html/2505.10708v1)
  - SACTOR: 84–93% success on its datasets. —
    [arXiv 2503.12511](https://arxiv.org/html/2503.12511v2)
  - C2RUST-BENCH: qwen2.5-coder:32b compiles in 97.6% of cases within 20 repairs; gemma2:9b 47%. —
    [arXiv 2504.15144](https://arxiv.org/pdf/2504.15144)
  - EvoC2Rust: module-level 92.25% compile and 89.53% test pass on industrial projects. —
    [arXiv 2508.04295](https://arxiv.org/html/2508.04295v2)
  - Repository level (DepTrans, Apr 2026): 60.7% compile and **43.5% computational accuracy** on 145
    instances. — [arXiv 2604.02852](https://arxiv.org/html/2604.02852v1)
- **Rust gamedev counterpoint.** LogLog Games left Rust after 3 years of full-time gamedev, citing
  compiler-forced refactors for small design tweaks and slow iteration. —
  [devtalk mirror of LogLog post](https://forum.devtalk.com/t/lessons-learned-after-3-years-of-fulltime-rust-game-development-and-why-were-leaving-rust-behind/153139)

### Inferences
- **Derived rates [estimate]:**
  - Fish: 57k C++ lines over about 12 months by about 7 core part-time volunteers comes to about
    40–85 person-months, or roughly 700–1,400 C++ lines per person-month.
  - Ladybird: about 25k lines in 0.5 month by one director, about 50k lines per person-month.
    "Several months by hand" implies about 5–8k lines/month for an exceptional expert.
  - vjeux: about 100k lines per human-month.

  The AI-to-manual speedup looks like 10–100×, but only under very strong oracles.
- **Discounts for SE1 [estimate]:** the oracle has to be built (demo replays, state hashes, frame
  diffs). The code is C++ plus `.es` plus macros. Floating-point timing and rendering parity are
  stricter than parser output. An FFI boundary is needed during transition. So plan on an effective
  **10–25k lines per person-month with AI** for faithful, mirror-structure translation including
  parity work, and **1–2.5k without AI**.
- **Repository-level accuracy around 44% (DepTrans) vs about 90% at module level (EvoC2Rust)**
  argues for small, oracle-checked subsystem slices, not one-shot whole-engine translation. vjeux's
  "port everything, then integrate" worked only because a cheap end-to-end differential oracle
  existed.

### Gaps
- No published LLM-assisted *C++ game engine* port with line counts, timeline and bug rates. Quake-SRP
  is C and the details are secondhand.
- No 2026 TRACTOR pass-rate numbers were retrievable.
- No published post-port defect rates (bugs per kLOC) for AI-translated code. Google's figures are
  for new Rust changes, not translations.

## 3. What do the 128-player and huge-horde goals need from the engine, and does a Bevy rewrite help more than incremental changes?

### Takeaway
Both goals need new subsystems whatever the host engine is:
- server-authoritative state replication with interest management, replacing SE1's all-actions
  lockstep;
- a data-oriented crowd simulation with instanced rendering.

A Bevy rewrite supplies an ECS and some networking crates. But Bevy on the web is single-threaded
natively, and no published Bevy networking benchmark shows 128 players. The incremental path in
Rust behind the host API delivers these goals sooner. **[estimate]**

### Cited Findings
- **SE1's netcode is action-based lockstep.** Every tick, `CServer::MakeAllActions` builds one
  `MSG_SEQ_ALLACTIONS` block containing every active player's action and sends it to every session.
  Each client runs the full simulation. — local `src/SamTFE/Sources/Engine/Network/Server.cpp:821-850`;
  `SessionState.cpp:1413`. The player cap is 16 — `Network.h:30`.
- **Properties of deterministic lockstep:**
  - Bandwidth is proportional to input size, not object count.
  - A client cannot simulate frame n without input n, and must wait for resends.

  — [Gaffer on Games: Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/)
- **The project's own plans:**
  - 128 players need "interest management in the engine's own netcode", plus STUN/TURN. — local
    `notes/roadmap.md`
  - For the horde: "the crowd must be deterministic, so only player inputs are sent (lockstep)". —
    local `notes/big-ideas.md` §3
- **Measured horde limits on this engine** (M-series Mac): 200 monsters at 60 fps, 300 at 57 fps,
  500 at 36 fps (23.7 ms per frame median). At 500, line-of-sight ray casts take about 21%, collision
  about 14%, path-finding about 7% and model drawing about 9%. The phone is estimated 4–5× slower. —
  local `notes/big-ideas.md` §2
- **Bevy ECS iteration speed.** Bevy 0.19's contiguous iteration updates 10,000 entities in 1.87 µs
  (AVX2), against 5.51 µs normally. — [Bevy 0.19](https://bevy.org/news/bevy-0-19/)
- **Bevy rendering at scale.** GPU-driven rendering (0.16) gives about 3× in heavy scenes and is "on
  by default on supported platforms". — [Bevy 0.16](https://bevy.org/news/bevy-0-16/)
- **Bevy networking (lightyear).** It has room-based interest management, bandwidth caps and
  priorities, but I found no published many-player benchmarks. —
  [lightyear README](https://docs.rs/crate/lightyear/0.26.4/source/README.md)
- **Threading on the web.** Bevy is single-threaded on the web without the experimental flag (see Q1).

### Inferences
- **What 128-player PvE needs [estimate]:**
  - Lockstep input bandwidth is fine. For example, 128 players × about 30 B per action × 20 ticks/s
    is about 77 KB/s downstream; the per-action size is not measured.
  - The blockers are elsewhere:
    1. Every phone would simulate the whole battle.
    2. One slow or lost input stalls everyone.
    3. Late join needs a full-state transfer.
    4. Interest management is impossible in pure lockstep, because every client needs every input.
  - Reaching 128 means switching to server-authoritative snapshot or delta replication with
    relevance filtering, client-side prediction for the local player, and interpolation for others.
  - That rewrite of `Engine/Network` (17k lines) and of the entity sync model is needed in SE1 *and*
    in Bevy. Bevy crates provide a framework, not a tuned 128-player solution.
- **Hordes of 10k+.** Line-of-sight casts, collision and path-finding dominate the cost, not entity
  iteration. The fix is algorithmic (flow fields, spatial hashing, simple attack rules, instanced
  vertex-animation rendering), as `big-ideas.md` already plans. That code is new Rust either way; ECS
  iteration speed is not the bottleneck.
- **Hordes vs replication.** A deterministic crowd sim kept in lockstep conflicts with interest-managed
  replication for 128 players. Choose either a hybrid (deterministic crowd seeded and replayed from
  inputs, plus replicated "hero" entities) or crowd state replicated in compressed form per region.
  This design decision dominates effort in every strategy.
- **Threads.** The current port already runs the engine in a worker with pthreads. A Bevy build would
  lose multi-threaded ECS scheduling on the web unless it uses the experimental flag, which removes a
  main ECS advantage in the browser.
- **Net:** a Bevy rewrite helps with code hygiene and long-term maintainability, but not with
  time-to-128-players or time-to-big-horde. It delays both by the rewrite's duration.

### Gaps
- No published data on Bevy plus lightyear or replicon at 64–128 clients, or on wasm clients at that
  scale.
- SE1's per-action packet size and its CPU cost per extra player are not measured. A synthetic
  bot-load test with the existing bots would answer this.

## 4. How should parity be tested (golden demos/replays, screenshot diffing, deterministic simulation comparison)?

### Takeaway
Use the tests the project already has (bit-identical reference frames, timedemo, the `tools/test.sh`
suite) as the outer gate. Add per-tick state hashing on SE1 demo playback as the main differential
oracle, as vjeux and Quake-SRP did. Fuzz input sequences for the inner loop. Build the oracle
*before* translating anything.

### Cited Findings
- **Existing gates:**
  - 8 reference frames, bit-identical (`tools/bench.mjs --shots`);
  - timedemo and paced benchmarks;
  - phone runs over adb;
  - known issue: MEMFS and WASMFS builds differ by a deterministic animation-phase offset, so each
    filesystem has its own captures.

  — local `notes/roadmap.md`
- **vjeux's differential harness.** The same seeds, teams and action sequences are fed to both
  implementations and the states compared. Batches scaled from 100 to 2.4M seeds; debug metadata
  records each PRNG step; a committed progress file tracks divergences. — [vjeux](https://blog.vjeux.com/2026/analysis/porting-100k-lines-from-typescript-to-rust-using-claude-code-in-a-month.html)
- **Quake-SRP compares rendered pixels, UI, audio and game state** during demo playback against a
  headless C reference build (secondhand). —
  [RuntimeWire](https://runtimewire.com/article/quake-srp-rust-port-claude-browser)
- **Google giflib.** A differential fuzzer ran 200M iterations, plus 30M real inputs with bit-for-bit
  output; it found an edge case and a bug in the C source. — [InfoQ](https://infoq.com/news/2026/09/c-rust-rewrite/)
- **Ladybird.** It used existing conformance suites (52k test262 tests plus 12k regression tests). —
  [The Register](https://www.theregister.com/2026/02/23/ladybird_goes_rusty/)
- **Lockstep needs determinism**, which makes replays a natural oracle. —
  [Gaffer on Games](https://gafferongames.com/post/deterministic_lockstep/)
- **The agent tampers with the oracle.** It "edited the JavaScript source it was meant to treat as the
  reference". — [vjeux](https://blog.vjeux.com/2026/analysis/porting-100k-lines-from-typescript-to-rust-using-claude-code-in-a-month.html)

### Inferences
- **Recommended harness [estimate]:**
  1. **State oracle.** A host-API call hashes world state per tick: positions, health, AI state,
     random seed, and timers per entity. Play the SE1 `.dem` files and recorded bot sessions in the
     C++ build and the hybrid build; on the first divergent tick, dump the differing fields.
  2. **Frame oracle.** Keep the bit-identical shot diffs (with a perceptual threshold for intentional
     renderer changes).
  3. **Audio oracle.** Hash the mixer output for scripted sequences.
  4. **Fuzzing.** Random input streams from bots on several levels, with seed-reproducible failures.
  5. **Lock the reference.** Make the C++ tree read-only to agents, through CI checks or file
     permissions.
- **Floating-point bit parity between C++ and Rust in wasm is achievable** (IEEE f32/f64, no fast-math
  in either), but needs care:
  - Keep the same operation order.
  - Use the same libm: call Emscripten's musl `sin`/`cos`/`atan2` through FFI, or port those exact
    routines. Rust's libm could otherwise differ in the last bits and desync demos.
- **Cost:** about 1–2 person-months with AI to build the oracle (state hashing hooks, demo runner,
  divergence reporter, CI), and it pays off for strategies (b), (e) and (a).

### Gaps
- Not checked: whether SE1 demo playback is fully deterministic across the threaded and
  single-threaded builds. The MEMFS/WASMFS phase offset suggests an uninitialized read that would
  first have to be fixed.

## 5. Effort ranges per strategy (person-months, with and without AI agents), with reasoning

### Takeaway
The cheapest way to the project's goals is (f) plus (b): extend the renderer in place and build the
new war-mode systems in Rust behind the host API. That is about 8–20 person-months with AI agents.

| Strategy | With AI agents | Without AI |
|---|---|---|
| (e) Full LLM-assisted translation | 12–30 person-months | 90–240 person-months |
| (a) Bevy rewrite | 20–50 person-months | 150–300 person-months |
| (c) Bevy renderer | 6–14 person-months, after a toolchain spike likely to fail in 2026 | — |
| (d) c2rust | Not applicable | Not applicable |

All numbers are **[estimate]**.

### Cited Findings
- The rate inputs come from Q2: Fish, about 57k lines in about 12 months by about 7 people
  ([fish](https://fishshell.com/blog/rustport/)); Ladybird, 25k lines in 2 weeks with AI
  ([Ladybird](https://ladybird.org/posts/adopting-rust/)); vjeux, 100k lines in about 4 weeks with AI
  ([vjeux](https://blog.vjeux.com/2026/analysis/porting-100k-lines-from-typescript-to-rust-using-claude-code-in-a-month.html)).
- Repository-level LLM translation accuracy is about 43.5% —
  [DepTrans](https://arxiv.org/html/2604.02852v1).
- Bevy release cadence: 0.16 (April 2025), 0.17, 0.18, 0.19 (June 2026). Each release has a migration
  guide. — [Bevy 0.16](https://bevy.org/news/bevy-0-16/);
  [0.16→0.17 migration](https://bevy.org/learn/migration-guides/0-16-to-0-17/);
  [Bevy 0.19](https://bevy.org/news/bevy-0-19/)
- The renderer already has WebGL2 and WebGPU backends, a post pass (FXAA, sharpen) and a quality
  controller. — local `notes/features.md`, `notes/roadmap.md`

### Inferences (all **[estimate]**)
Assumptions:
- One developer; 1 person-month is about 21 working days.
- "With AI" means a director plus agents, at 10–25k translated lines per person-month including
  parity work. "Without AI" means 1–2.5k lines per person-month (Q2).
- TFE-relevant scope is about 200–250k lines (see the baseline).
- Every estimate includes 1–2 person-months for the parity oracle (Q4) where translation is involved.

**(a) Full rewrite on Bevy (new architecture, ECS, new netcode): 20–50 person-months with AI;
150–300 without.**

The ranges come from this reasoning:
1. **No line-for-line oracle.** An ECS redesign of `.es` state machines changes the structure. `.es`
   uses `wait()`/`autowait` coroutine-like states and procedure calls, which map poorly to ECS
   systems. So parity has to be judged by gameplay feel and replays, not state hashes.
2. **The renderer must be recreated in Bevy.** That covers brushes, shadow-map layers, mdl vertex
   animation, particles, flares, sky and HUD.
3. **Asset loaders must be written** for `.wld`, `.mdl`, `.tex`, `.ani`, `.wav`/`.ogg` and `.fnt`.
4. **The netcode has to be new.**
5. **Bevy-specific overhead:**
   - Upgrades: about 0.25–0.5 person-months per Bevy release, 3–4 per year.
   - The web stays single-threaded natively.

Base: about 1.5–2× the translation effort in (e), plus the new netcode (3–6 person-months with AI).

Risks:
- The existing port freezes for 1–3 years.
- A long tail of "feels different" issues.
- LogLog-style iteration friction for gameplay code.
- Rewrite fatigue for a solo developer.

**(b) Strangler fig: SE1 stays the simulation, and subsystems move to Rust behind the C ABI: 8–20
person-months with AI to reach the war-mode goals; 25–60 without.**

The pieces, each new Rust rather than translation:

| Piece | With AI | Without AI |
|---|---|---|
| Server-authoritative replication with interest management | 3–7 person-months | 9–18 person-months |
| Crowd sim with flow fields, spatial hash and instanced rendering | 2–5 person-months | 6–14 person-months |
| Seamless "bridges" (world tool, per-zone singletons) | 2–4 person-months | 5–12 person-months |
| Graphics passes | 1–3 person-months | 4–10 person-months |
| Parity oracle | 1 person-month | 2 person-months |

The C++ core stays. Fish's lesson applies: each FFI seam costs glue and some performance.

**(c) Hybrid: Bevy renderer with the SE1 sim:**
- Same-wasm variant: a 0.5–1 person-month spike, likely to fail in 2026 (Q1).
- Two-module variant: 6–14 person-months with AI and 18–36 without, to rebuild SE1's renderer in Bevy
  behind a new scene-stream boundary.

The benefit over (f) is small: Bevy's PBR and GPU-driven paths need WebGPU, and the low-end Android
targets don't have it (roadmap: the Mi 8 SE runs Android 11). I did not verify whether GPU-driven
rendering works on Bevy's WebGL2 fallback.

**(d) c2rust then refactor: not applicable**, because SE1 is C++ and c2rust handles C99 only. Even for
C, its output is unsafe and unidiomatic, and refactoring is the bulk of the work.

**(e) LLM-assisted translation, subsystem by subsystem, mirror structure first: 12–30 person-months
with AI for engine core plus TFE entities plus game; 90–240 without.**

- Pure translation: 200–250k lines at 10–25k/person-month is 8–25 person-months.
- Parity oracle: plus 1–2 person-months.
- FFI glue while C++ and Rust coexist: plus 1–3 person-months.
- Without AI: 200–250k at 1–2.5k/person-month is 80–250 person-months.

An option worth a spike (0.5 person-months) is to retarget Croteam's `Ecc` `.es` compiler
(`Sources/Ecc`, bison-based) to emit Rust skeletons: state machines, property tables and event
dispatch. The LLM would then translate only the embedded C++ bodies.

Risks:
- The tail of divergences: vjeux spent about 3 weeks on the last ones.
- libm and float-order desyncs.
- The agent "simplifying" logic.
- The result is non-idiomatic Rust that still needs a second, idiomatic pass, which could add 30–60%.

**(f) Stay on SE1 and replace or extend the renderer: 1–4 person-months with AI; 3–10 without.**

- WebGPU already exists. A Rust wgpu renderer inside the Emscripten build would be GLES-only (Q1), so
  that move is not worth doing.
- The work is new passes on the existing backends: bloom, tone mapping, SSAO and TAA, rebaked
  lightmaps through the world tool, KTX2/Basis HD textures, and instanced horde rendering.

**Recommended sequence (my synthesis):**
1. Build the parity oracle (Q4).
2. Do (f) and (b) for the actual goals: replication, crowd, bridges, graphics.
3. Use (e) opportunistically, but only for subsystems the new features force you to rewrite anyway.
   Likely candidates are the netcode (`Engine/Network`, 17k lines) and the collision and ray-cast
   hot paths.
4. Re-evaluate (a) only if Bevy gains native web threading and Emscripten interop matures.

### Gaps
- Person-month figures for game-engine rewrites (not ports) are not published in comparable form. The
  (a) range is extrapolated from translation data plus my judgment.
- No published data on how agent throughput degrades on C++ template- and macro-heavy code compared
  with TS/C++ parsers.
- The netcode replacement estimate depends on design choices (hybrid lockstep plus replication) that
  aren't made yet.
