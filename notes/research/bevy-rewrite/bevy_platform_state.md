# Bevy as a platform for a web + desktop fast-paced 3D FPS (state as of Nov 2026)

Research date: 2026-11-24. About 20 search/fetch calls. Primary sources are preferred, and older items carry their date. Several questions (wasm size, compile times, memory64, shipped 3D web FPS titles) had thin or old evidence; see the Gaps sections.

## 1. Version, release cadence, API churn, 1.0

### Takeaway
The current line is Bevy 0.20 (released 8 Oct 2026; 0.20.1 is on docs.rs). Releases still come roughly every 3-5 months and every one breaks the API. The 0.18->0.19 migration guide alone has about 103 top-level entries. No 1.0 has been announced. The project's stated position is still "1.0 when the foundations are stable", with no date.

### Cited Findings
- Bevy 0.20 was posted on 8 Oct 2026, with 227 contributors and 817 PRs. The page's contributor list says 226, so the page is inconsistent. Headlines: BSN syntax improvements, a `Ready` event for BSN scenes, Feathers widgets, a move to WESL shaders (the old custom WGSL dialect was removed), mesh shaders ("Mesh shaders are not supported on web platforms"), custom sprite and 2D materials, sprite rendering unified with 3D infrastructure, a pan-orbit camera, `chain_weak` ordering, and faster bulk despawning (1.30x-1.70x). Per-column change ticks gave "a 132x speedup" in GPU mesh extraction code — [Bevy 0.20 notes](https://bevy.org/news/bevy-0-20/)
- The 0.20 "What's Next" list includes a `.bsn` asset format, assets as entities, a remote inspector, and HDR display support. The 0.20 notes do not mention web/wasm, WebGL2/WebGPU, lightmaps, occlusion culling, audio, or 1.0 — [Bevy 0.20 notes](https://bevy.org/news/bevy-0-20/)
- Bevy 0.19 was released on 19 Jun 2026, with 261 contributors and 1,185 PRs. Headlines: next-generation scenes (`bsn!` macro, code-only, with no first-party `.bsn` asset loader yet), contact shadows, physically based SSR, rectangular area lights, "Render Graph as Systems", typed GPU error recovery, partial bindless on Metal, Parley text, and resources-as-components — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/)
- A 0.19.1 patch release exists — [gamedev.net](https://gamedev.net/news/5064-bevy-engine-v0191-released/)
- Bevy 0.18 was released on 13 Jan 2026, with 174 contributors and 659 PRs (atmosphere scattering asset, fly/pan cameras, atmosphere occlusion) — [Bevy 0.18 notes](https://bevy.org/news/bevy-0-18/); [AlternativeTo](https://alternativeto.net/news/2026/1/bevy-0-18-brings-atmospheric-occlusion-pbr-shading-solari-improvements-and-font-variations). 0.18.1 followed on 2 Mar 2026; the source is an auto-generated article, so this is low confidence — [Prism News](https://www.prismnews.com/hobbies/rust-programming/bevy-releases-v0181-to-stabilize-018-fix-regressions). A third-party guide says "0.18 shipped March 2026", which conflicts with the official 13 Jan date and probably confuses it with 0.18.1 — [StraySpark](https://www.strayspark.studio/blog/bevy-rust-game-engine-2026-indie-guide)
- Observed cadence: 0.18 (Jan 2026) -> 0.19 (Jun 2026, about 5 months) -> 0.20 (Oct 2026, about 3.7 months). The official process describes "three-months-long development cycles" followed by a weeks-long rolling release candidate process — [Release Process](https://bevy.org/learn/contribute/project-information/release-process/)
- The 0.18->0.19 migration guide has about 103 top-level entries plus about 17 subsections, and the page is about 133k characters. Examples: resources became components on dedicated entities; `bevy_scene` was renamed `bevy_world_serialization`; `ShaderStorageBuffer` became `ShaderBuffer`; text moved from Cosmic Text to Parley; "Render Graph as Systems"; "Morph targets stored in meshes"; "Occlusion culling no longer experimental"; the Rodio 0.22/cpal 0.17 update; the `audio` feature is no longer implied by 3d/2d/ui; the mesh view bind group layout changed; `WgpuSettingsPriority::Compatibility` was renamed `WebGPU` — [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)
- A 0.19->0.20 migration guide also exists — [0.19->0.20 migration guide](https://bevy.org/learn/migration-guides/0-19-to-0-20/). I did not count its entries.
- On 1.0, Cart's stated position (2022) is that 1.0 comes "when all foundations have been laid and (roughly) stabilized". Community members have asked for LTS/backports for commercial users — [Reddit, Bevy 0.15 thread, Nov 2024](https://redlib.hackliberty.org/r/rust/comments/1h2wgqb/bevy_015/lzorjag/?context=3); [GitHub discussion](https://github.com/bevyengine/bevy/discussions/21911). A Sept 2025 post by core rendering contributor JMS55 treats production readiness as still open and calls UI a weak point — [JMS55, Bevy's Fifth Birthday (Sep 2025)](https://jms55.github.io/posts/2025-09-03-bevy-fifth-birthday)

### Inferences
- A multi-year FPS rewrite would need to either pin one Bevy version, giving up fixes, or absorb about 100 breaking migration items per release, 2-3 times a year. Rendering internals (render graph, bind group layouts, shader dialect, which moved to WESL in 0.20) churn the most. That is exactly where a custom 2001-era renderer (lightmaps, Serious Engine-style shading) would sit.
- BSN, the scene/prefab format, is still half-built: in code since 0.19, with the `.bsn` file asset format still "next" as of 0.20. The editor depends on it.

### Gaps
- I did not verify the exact 0.17 release date (it was around late Sep 2025, per the JMS55 post context).
- I found no official 1.0 roadmap or date as of Nov 2026, and no LTS policy.
- I did not count the size of the 0.19->0.20 migration guide.

## 2. Web support: backends, browser WebGPU coverage, threading, audio, size, memory

### Takeaway
Bevy builds for wasm with either WebGL2 (still the default) or WebGPU (opt-in feature). The engine itself is single-threaded on the web: the task pool runs on one thread and the renderer does not use workers. Experimental `+atomics` builds exist only through the unstable Bevy CLI, on nightly Rust, and only benefit some third-party crates. Browser WebGPU coverage in late 2026 is good on Chrome (desktop and Android 12+), Safari 26 (macOS, iOS, iPadOS) and Firefox Windows/macOS. It is still missing in stable Firefox on Linux and Android. So a WebGL2 fallback is still needed for broad reach.

### Cited Findings
- **Threading on web.** The Bevy CLI docs say: "The Bevy engine does not yet take advantage of multi-threading on the web, only certain 3rd-party crates do" (for example `firewheel-web-audio` and `bevy_seedling` with `web-audio`). Opting in (`web-multi-threading = true` or `bevy run web --unstable multi-threading`) needs nightly Rust plus COOP `same-origin` and COEP `require-corp` headers. The docs say to "Expect to encounter more bugs and a worse user interface" — [Bevy CLI: web multi-threading](https://thebevyflock.github.io/bevy_cli/cli/web/multi-threading.html)
- The `bevy_tasks` README (0.17.x) says the same task API runs single-threaded on wasm targets — [bevy_tasks 0.17.2 README](https://docs.rs/crate/bevy_tasks/0.17.2/source/README.md). An earlier PR (#12205, 2024) made Bevy compile with `+atomics`, but the renderer kept `fragile-send-sync-non-atomic-wasm` because wgpu web types are not Send/Sync, so it was wrapped in `SendWrapper` — [bevy PR #12205](https://www.github.com/bevyengine/bevy/pull/12205)
- In 0.19, wasm builds use the `web-task` crate. Dropping a `Task<T>` now cancels it, matching native behaviour, and `detach()` keeps the old behaviour. This is a semantics change, not multithreading — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/); [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/); [web-task repo](https://github.com/bevyengine/web-task) ("enabling `+atomics` turns on a thread-safe runtime that works with web workers")
- **Backend default.** WebGL2 is still Bevy's default web backend, and WebGPU needs the `webgpu` feature — [bevy_hanabi docs/wasm.md](https://github2.scsujunhua.workers.dev/djeedai/bevy_hanabi/blob/main/docs/wasm.md); [Bevy + WebGPU post (2023)](https://bevy.org/news/bevy-webgpu/). In 0.19 the `WgpuSettingsPriority::Compatibility` setting was renamed `WebGPU` (the env var `WGPU_SETTINGS_PRIO` value changed from "compatibility" to "webgpu") — [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)
- **WebGPU browser coverage** (gpuweb wiki, last edited 2 Oct 2026) — [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status):
  - Chrome/Edge (Dawn): Win/Mac/ChromeOS since Chrome 113. Android 12+ on ARM/Qualcomm/Intel GPUs since 121, Imagination GPUs on Android 16+ since 139, Samsung Xclipse "TBD". Linux: Intel Gen12+ since 144 and NVIDIA (driver 535.183.01+) on Wayland since 147; other Linux configurations need flags. Windows ARM64 is behind a flag.
  - Firefox (wgpu): Windows since 141 (Jul 2025). macOS Apple Silicon since 145 on macOS 26+ and since 147 on all macOS versions. Intel Macs and Linux are Nightly-only ("expects to ship in 2026"). Android is behind a flag.
  - Safari: enabled by default in Safari 26 on macOS Tahoe 26, iOS 26, iPadOS 26 and visionOS 26.
  - The web.dev announcement of "supported in all major browsers" is dated 25 Nov 2025 — [web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
- **Audio on web.** `bevy_audio` is built on rodio/cpal (0.19 moved to Rodio 0.22 and cpal 0.17). The migration guide notes known OGG/Vorbis (symphonia) issues with buffering, reverb, looping and spatial audio — [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/). The ecosystem alternative for web audio is Firewheel via `bevy_seedling` / `firewheel-web-audio`, which is what benefits from the experimental web threading — [Bevy CLI docs](https://thebevyflock.github.io/bevy_cli/cli/web/multi-threading.html)
- **Binary size.** The Bevy CLI says binary size "is a lot more important for web apps" and ships a `web-release` profile. It recommends `wasm-opt -Oz --enable-bulk-memory` — [Bevy CLI web docs](https://thebevyflock.github.io/bevy_cli/cli/web.html). The only Bevy-specific number I found is old: a WebGPU example in May 2023 was about 13 MB raw and about 3.9 MB compressed — [r/rust comment, May 2023](https://axebps-redlib.hf.space/r/rust/comments/13lb0h8/bevy_webgpu/jkr35ga/?context=3). The Bevy cheatbook's size-optimization page is marked outdated (0.12) — [cheatbook](https://bevy-cheatbook.github.io/platforms/wasm/size-opt.html)

### Inferences
- Compared with the existing Emscripten port, which runs threaded wasm with SharedArrayBuffer, Bevy on web is a step back in threading. All ECS systems, physics, animation and render preparation run on the browser main thread, unless the team builds its own worker architecture or adopts the unstable CLI path, which still does not parallelize Bevy's own scheduler.
- A WebGPU-only build would exclude stable Firefox on Linux/Android, Chrome on non-Intel/non-NVIDIA-Wayland Linux, and some Android GPUs (Xclipse). Bevy's WebGL2 path lacks compute and storage buffers (see section 3), so it has fewer features.
- A full Bevy 3D build with PBR, glTF and audio will likely be larger than the current roughly 6 MB Serious Engine wasm, based on the 2023 data point. This is unverified for 0.20.

### Gaps
- I found no current (0.19/0.20) published wasm size or startup-time measurements for a Bevy 3D game.
- I found no Bevy-specific source on wasm32 4 GB memory limits or memory64 support/plans. I did not research wgpu's memory64 status.
- I found no specific source on asset streaming on web (HTTP asset reader behaviour, range requests, progressive loading of about 368 MB of data).
- I did not confirm whether `bevy_audio` on web uses WebAudio via cpal's wasm backend, or its latency characteristics.

## 3. Rendering features relevant to a 2001-era engine

### Takeaway
Bevy has the building blocks: lightmaps (baked externally and consumed via a `Lightmap` component with atlas UV rects and bicubic option), custom materials and shaders (now WESL), fog/atmosphere, clustered forward lights, GPU-driven rendering that handles 55k-1.6M entities on native, morph targets and skinning. But the most advanced pieces (GPU occlusion culling, bindless, compute-based effects, mesh shaders, Hanabi particles) need compute or storage buffers, so they are WebGPU-only or native-only. I found no portal/PVS visibility system.

### Cited Findings
- **Lightmaps.** `Lightmap` is "a component that applies baked indirect diffuse global illumination from a lightmap". It is used with `Mesh3d` + `MeshMaterial3d<StandardMaterial>` and the second UV channel (`ATTRIBUTE_UV_1`). Fields: `image`, `uv_rect` (for atlases shared by many meshes) and `bicubic_sampling` (higher quality, "may lead to light leaks"). The page does not describe any in-engine baker (doc for bevy 0.20.1) — [docs.rs bevy::pbr::Lightmap](https://docs.rs/bevy/latest/bevy/pbr/struct.Lightmap.html). Lightmap support originally landed around 0.13 (PR #10231) — [Bevy graphics tracker discussion #4630](https://redirect.github.com/bevyengine/bevy/discussions/4630)
- **Render performance (native, 0.19 vs 0.18).** `many_cubes` with 1.6M cube entities and culling went from 49.47 ms (21 FPS) to 18.77 ms (53 FPS). `bevy_city` with 55,000 rendered entities went from 19.3 ms to 11.8 ms when static and from 22.1 ms to 16.2 ms when moving. Bindless Bistro Exterior improved +15% frame time on M2 Max, +46% on an NVIDIA 5060 Ti and +14% on Intel — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/)
- **Occlusion culling.** It was declared "no longer experimental" in 0.19 — [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/). However, a Bevy commit notes the `occlusion_culling` example breaks under WebGL2 limits and under WebGPU compatibility minimums (it hits `max_storage_buffers_per_shader_stage`), and panics on real WebGL. This comes from a mirror commit page, so treat it as a snapshot — [commit mirror](https://tgfed.nhyvvfeijnh.workers.dev/slyedoc/bevy/commit/09ff7ce9f6312e33d75ebdca8c0c68f043751023)
- **Compute on WebGL2.** Bevy detects missing compute by checking for zero `max_compute_workgroup_*` limits, which is what WebGL2 downlevel defaults give — [bevy_pbr 0.17.2 light_probe/generate.rs](https://docs.rs/bevy_pbr/0.17.2/src/bevy_pbr/light_probe/generate.rs.html)
- **Culling and skinning.** 0.19 added skinned mesh culling using animated joint positions each frame, GPU-side visibility range checks and `NoCpuCulling` — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/). 0.19 also restructured morph targets into the mesh ("Morph targets stored in meshes"; `MorphWeights`/`MeshMorphWeights` restructured) — [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)
- **Shaders.** Bevy's shaders moved to WESL in 0.20 and the custom WGSL dialect was removed. Mesh shaders are native-only. Custom sprite materials and extendable 2D mesh materials arrived in 0.20 — [Bevy 0.20 notes](https://bevy.org/news/bevy-0-20/)
- **Particles.** bevy_hanabi (GPU particles) "makes heavy usage of compute shaders" and therefore requires the WebGPU backend on wasm, not WebGL2 — [bevy_hanabi README](https://raw.githubusercontent.com/djeedai/bevy_hanabi/main/README.md); [hanabi docs/wasm.md](https://github2.scsujunhua.workers.dev/djeedai/bevy_hanabi/blob/main/docs/wasm.md); [hanabi issue #41 (historical)](https://www.github.com/djeedai/bevy_hanabi/issues/41)
- **Fog and atmosphere.** 0.18 added an atmospheric scattering asset and atmosphere occlusion, and 0.19 made the atmosphere an entity and moved it to `bevy_light` — [Bevy 0.18 notes](https://bevy.org/news/bevy-0-18/); [0.18->0.19 migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)
- **Older caveat.** An itch.io dev wrote that "Bevy doesn't currently implement any batching or instancing when rendering 3d entities". This predates the GPU-driven rendering work and is superseded by the 0.19 numbers above — [itch.io post](https://itch.io/post/8900460)

### Inferences
- Serious Engine's look (lightmapped brush geometry, vertex-animated MDL models, simple fog/haze, many small dynamic lights, particles) is well within Bevy's native feature set. Lightmaps would have to be converted from SE's existing lightmap data or re-baked externally.
- On WebGL2, expect a reduced path: no GPU occlusion culling, no Hanabi, no compute. CPU frustum culling only, with all of it running on one thread. For SE-style levels that relied on portal/sector visibility, the team would have to implement its own PVS/portal culling.
- Serious Sam models use vertex animation (MDL frames). In Bevy that maps to morph targets (with known limits on target counts) or to custom vertex shaders that sample frame textures. Neither path is verified here for performance on WebGL2.

### Gaps
- I found no Bevy doc that lists exactly which render features are disabled on WebGL2 vs WebGPU in 0.20.
- I found no portal/PVS culling support in Bevy core or a mature crate.
- I found no benchmark of Bevy frame times on WebGL2 vs WebGPU vs native for the same scene.
- I found no source on the cost of many dynamic point lights on WebGL2 (clustered forward light limits on WebGL2).

## 4. Physics and collision

### Takeaway
Avian (ECS-native) is the community-default physics engine and pairs with lightyear for networked physics. It offers an `enhanced-determinism` feature for cross-platform determinism. bevy_rapier is the alternative. I found no recent figures for physics performance on web.

### Cited Findings
- Avian has an `enhanced-determinism` feature for cross-platform deterministic math, at a small performance cost — [docs.rs avian3d](https://docs.rs/avian3d). The repo includes a cross-platform determinism test — [avian3d 0.6.0 determinism test](https://docs.rs/crate/avian3d/0.6.0/source/src/tests/determinism_2d.rs)
- The lightyear Bevy 0.19 stack uses Avian 0.7 — [lightyear releases](https://github.com/cBournhonesque/lightyear/releases)
- An older comparison (Avian 0.2 era) says Avian is deterministic across platforms by design, while bevy_rapier is deterministic only within the same platform and build. This is outdated — [comparison page](https://jedimemo.github.io/my-claude-marketplace/bevy/skills/bevy-physics/references/physics-comparison.html)
- On web, physics runs on the single Bevy main thread because Bevy's task pool is not multithreaded on wasm — [Bevy CLI docs](https://thebevyflock.github.io/bevy_cli/cli/web/multi-threading.html)

### Inferences
- An FPS like Serious Sam (hundreds of enemies, hitscan plus projectiles, BSP-like brush collision) would likely want a custom character controller and possibly custom brush collision rather than generic rigid-body physics. Avian or Rapier would mainly cover debris and ragdolls.

### Gaps
- I found no published Avian/Rapier wasm performance benchmarks for 2026.
- I did not verify the current Avian version for Bevy 0.20.
- I did not research Rapier's `enhanced-determinism` status for 2026.

## 5. Networking crates

### Takeaway
lightyear (server-authoritative replication with client prediction and rollback, Avian integration, WebTransport/WebSocket on wasm) is the most complete option. bevy_replicon is transport-agnostic and tracks Bevy closely (0.45 for Bevy 0.20). matchbox provides WebRTC peer-to-peer for native and wasm, but its Bevy/replicon bindings lag behind.

### Cited Findings
- lightyear offers server authority, client prediction and rollback, with examples that replicate Avian 2D/3D. It works in wasm through WebTransport, with WebSocket available on native and wasm, and has a `deterministic` crate in its workspace — [lightyear README](https://raw.githubusercontent.com/cBournhonesque/lightyear/main/README.md); [docsearch index](https://docsearch.algolia.com/mcp/docs/repo/cbournhonesque/lightyear)
- lightyear 0.29 targets Bevy 0.19 — [docs.rs lightyear 0.29.0](https://docs.rs/crate/lightyear/0.29.0)
- bevy_replicon's compatibility table: Bevy 0.20.0 -> replicon 0.45, 0.19 -> 0.41-0.44, 0.18 -> 0.38-0.40, 0.17 -> 0.36-0.37, 0.16 -> 0.33-0.35. It has no built-in I/O; backends are renet, renet2, quinnet, aeronet and matchbox. It has no built-in prediction or rollback: `bevy_rewind` is the listed option, and `bevy_replicon_snap` and `bevy_timewarp` are marked unmaintained — [bevy_replicon README](https://raw.githubusercontent.com/simgine/bevy_replicon/master/README.md)
- That compatibility table shows 4 replicon releases within one Bevy cycle (0.41-0.44 for 0.19), so ecosystem crates also break often — [bevy_replicon README](https://raw.githubusercontent.com/simgine/bevy_replicon/master/README.md)
- matchbox describes itself as "painless peer-to-peer WebRTC networking for both native Rust and WASM". bevy_matchbox 0.14 depends on bevy ^0.18 — [bevy_matchbox 0.14 README](https://docs.rs/crate/bevy_matchbox/0.14.0/source/README.md); [matchbox releases](https://www.github.com/johanhelsing/matchbox/releases)
- bevy_replicon_matchbox lists Bevy 0.16 and says its wasm support "has not been tested" — [bevy_replicon_matchbox](https://rust-digger.code-maven.com/crates/bevy_replicon_matchbox)
- GGRS-style rollback with matchbox has been demonstrated in Bevy (2022-era article) — [Rock and rollback (metabrew)](https://metabrew.com/article/rock-and-rollback-realtime-multiplayer-games-with-bevy); [bevy_gaff](https://github.com/johanhelsing/bevy_gaff)

### Inferences
- For a web FPS, lightyear over WebTransport/WebSocket, or replicon plus aeronet/renet2 with WebTransport, are the realistic paths. Lockstep or rollback with cross-platform determinism would require Avian `enhanced-determinism` and careful float discipline across native x86/ARM and wasm. I found no FPS-scale proof of this.

### Gaps
- I did not confirm a lightyear release for Bevy 0.20.
- I found no production FPS shipped on lightyear or replicon.
- I found no Safari WebTransport status sources in this research. Safari WebTransport support matters for lightyear on iOS and should be checked separately.

## 6. Editor, tooling and scene format

### Takeaway
As of Nov 2026 there is still no shipped Bevy editor. The editor is "upcoming" and depends on BSN `.bsn` files, Feathers widgets and an entity inspector, which are still in progress. The scene format BSN exists as a code macro (`bsn!`, since 0.19), and the `.bsn` file loader is still on the "next" list. Blender-to-glTF is the practical content pipeline.

### Cited Findings
- 0.19 describes the Bevy Editor as upcoming and a future consumer of BSN, Feathers and `.bsn`, and lists an entity inspector as upcoming work. 0.19 does not ship a first-party `.bsn` asset loader — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/)
- 0.20 improved BSN syntax (`@` scene references, `--` list separators, a `Ready` event), added editor-centric Feathers widgets (color input, list view, dropdown, number input), upstreamed a pan-orbit camera from `bevy_editor_cam`, and lists the `.bsn` asset format, a remote inspector and a "scene editor" as next — [Bevy 0.20 notes](https://bevy.org/news/bevy-0-20/)
- 0.19 added asset saving, an interactive transform gizmo and an infinite grid. These are editor building blocks — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/)

### Inferences
- A Serious Sam rewrite would rely on a converter from Serious Engine `.wld`/`.mdl`/`.tex` formats to glTF/Bevy assets, or on custom runtime loaders. No level editor exists to replace SE's Serious Editor.

### Gaps
- I did not research the status of third-party Blender integration tools (Skein, Blenvy) for Bevy 0.20.
- I did not research compile times. I found no current numbers for clean or incremental builds of Bevy 0.20, or for the dynamic-linking dev workflow.

## 7. Shipped games and performance reports

### Takeaway
Commercial Bevy titles are few ("on two hands" per a May 2026 overview). The most-cited one, Tiny Glade, uses Bevy ECS/App with a custom renderer. I found no shipped commercial fast-paced 3D FPS on Bevy, and none on the web. The evidence comes mostly from jam postmortems on itch.io.

### Cited Findings
- Tiny Glade uses Bevy ECS and Bevy App "alongside a custom renderer" and had over a million Steam wishlists — [hn.nuxt.dev summary](https://hn.nuxt.dev/item/41214369). A 2026 indie guide calls it the flagship commercial Bevy title, with a long tail of smaller releases — [StraySpark (Apr 2026)](https://www.strayspark.studio/blog/bevy-rust-game-engine-2026-indie-guide)
- A May 2026 overview says Bevy counts shipped commercial titles "on two hands" — [youngju.dev (May 2026)](https://www.youngju.dev/blog/culture/2026-05-14-bevy-game-engine-rust-hands-on-ecs-paradigm-modern-gamedev-deep-dive-2026.en)
- Tunnet (a 3D network-building game) is reported as shipped on Steam and itch.io. This comes from a forum post and is unverified — [itch.io post](https://itch.io/post/9324242)
- Jam postmortems (Bevy Jam, 2025) — [Chainboom postmortem (Jan Hohenheim)](https://janhohenheim.itch.io/chainboom/devlog/964782/postmortem-from-jans-perspective); [At the End of the Hall postmortem](https://piefayth.itch.io/at-the-end-of-the-hall/devlog/964759/at-the-end-of-the-hall-postmortem); [Subfuse postmortem](https://dgriffin.itch.io/subfuse/devlog/422315/subfuse-postmortem)
- The native many-entity benchmarks from 0.19 (1.6M cubes at 18.77 ms; 55k-entity city at 11.8-16.2 ms) are in section 3 — [Bevy 0.19 notes](https://bevy.org/news/bevy-0-19/)

### Inferences
- A Serious Sam rewrite would be among the more ambitious 3D Bevy projects and the first web-targeted fast FPS. There is little prior art to borrow from.

### Gaps
- I found no WebGL2/WebGPU frame-time reports for real Bevy 3D games.
- I found no postmortem from a commercial 3D Bevy release covering performance, compile times and engine upgrades. The Tunnet, El Mono and GLOW claims are unverified.

## 8. Known pain points (summary)

### Takeaway
Confirmed pain points: per-release API churn (about 100 migration items per release), single-threaded execution on web, WebGL2 missing compute and storage buffers (which removes occlusion culling and GPU particles), incomplete WebGPU coverage (Firefox Linux/Android), immature editor/BSN tooling, and ecosystem crates trailing Bevy releases. Compile times and wasm size are widely reported but lacked current numbers in this research.

### Cited Findings
- Churn: about 103 migration entries for 0.18->0.19 — [migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)
- Web is single-threaded: "does not yet take advantage of multi-threading on the web" — [Bevy CLI](https://thebevyflock.github.io/bevy_cli/cli/web/multi-threading.html)
- On WebGL2, the occlusion culling example fails on the storage buffer limit — [commit mirror](https://tgfed.nhyvvfeijnh.workers.dev/slyedoc/bevy/commit/09ff7ce9f6312e33d75ebdca8c0c68f043751023); Hanabi needs WebGPU — [hanabi wasm doc](https://github2.scsujunhua.workers.dev/djeedai/bevy_hanabi/blob/main/docs/wasm.md)
- WebGPU on Firefox Linux/Android is not shipped in stable (wiki edited 2 Oct 2026) — [gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- Safari: WebGPU is on by default in Safari 26 on iOS/iPadOS/macOS — [gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status). Safari-specific Bevy bugs were not researched.
- Ecosystem lag: bevy_replicon_matchbox is still on Bevy 0.16, and bevy_matchbox 0.14 is on 0.18 — [bevy_replicon_matchbox](https://rust-digger.code-maven.com/crates/bevy_replicon_matchbox); [bevy_matchbox](https://docs.rs/crate/bevy_matchbox/0.14.0/source/README.md)
- Audio: OGG/Vorbis via symphonia has known buffering, looping and spatial issues as of 0.19 — [migration guide](https://bevy.org/learn/migration-guides/0-18-to-0-19/)

### Inferences
- Several Bevy web limitations are the same ones the current Emscripten port has already solved: threading via SharedArrayBuffer, a dual WebGL2/WebGPU renderer, and a roughly 6 MB binary. On the web side, a rewrite would likely regress on threading, and at best match on rendering reach.

### Gaps
- No current compile-time benchmarks (clean or incremental) for Bevy 0.20.
- No current wasm binary size for Bevy 0.20 3D builds.
- No Safari-specific Bevy issue survey.
- No memory64 / greater-than-4 GB wasm status for Bevy or wgpu.
