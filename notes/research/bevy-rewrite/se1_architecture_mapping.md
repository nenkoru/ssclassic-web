# Serious Engine 1 architecture → Bevy: subsystem-by-subsystem feasibility of a TFE rewrite

Scope: Serious Engine 1.10 as vendored in this repo (tx00100xt fork, `src/SamTFE/Sources`, here **S/**), measured
with `wc`/`grep` on 2026-11-24, plus web sources on file formats and third-party tooling. All line counts are
raw `wc -l` (comments and blanks included). Local links are relative to this notes file.

Base for local links: `S/` = [`../../../src/SamTFE/Sources/`](../../../src/SamTFE/Sources/).

---

## Q0. Overall inventory: what exists, and how big is it?

### Takeaway
SE1 for TFE is about 168k lines of engine C++ that TFE really uses, plus 54k lines of `.es` game logic in 120 entity
classes, compiled by a ~2k-line compiler (Ecc) into ~94k lines of generated C++. The game data a rewrite would
have to consume is 2,457 files in 6 `.gro` zip archives: 359 `.mdl`, 1,229 `.tex`, 386 sounds, 17+ `.wld`. About
40% of the engine directory (Vulkan/D3D, SKA skeletal models, Terrain, zlib) is not used by TFE content.

### Cited Findings
- Engine was released by Croteam on 11 March 2016 as v1.10, "the very same engine that we used for Serious Sam
  Classic: The First Encounter and The Second Encounter" — [Croteam blog](https://www.croteam.com/serious-sam-source-code-released/);
  license GPL-2.0-only, game art/IP not included — [GamingOnLinux](https://www.gamingonlinux.com/2016/03/croteam-releases-serious-engine-version-110-as-free-software/),
  [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine). 3D Exploration (model import)
  is disabled in the open release for copyright reasons — [SE1-GameShell README](https://github.com/SE1-Community/SE1-GameShell).
- Line counts per `S/Engine/<dir>` (cpp/h/c/asm), measured locally — [S/Engine](../../../src/SamTFE/Sources/Engine/):

  | Engine dir | Lines | Used by TFE? |
  |---|---|---|
  | Base (streams, shell/console parser, files, timer, input, unzip) | 26,482 | yes |
  | Brushes (CSG brush/sector/polygon data, IO, shadows, triangulation) | 7,062 | yes |
  | Classes (`.es` base classes: MovableEntity etc., + generated C++) | 5,004 | yes |
  | Entities (CEntity core, properties, collision, class loader) | 8,706 | yes |
  | GameAgent (master-server lister) | 2,218 | no (online lobby) |
  | Graphics (gfx API, textures, drawport, texture effects, shadow maps) | 79,827 | ~40k; 38,558 are the vendored `vk_mem_alloc.h` + `_vk_mem_alloc_old.h`, ~2.7k Direct3D |
  | Light (light sources, shadow-layer maker/mixer) | 4,535 | yes |
  | Math (vectors, projections, CSG on Object3D, geometry) | 11,876 | yes |
  | Models (`.mdl` vertex-animated models, rendering) | 13,354 | yes |
  | Network (session state, server, client, packets, demos) | 17,330 | yes |
  | Rendering (world renderer, ASER visibility, model/brush lists) | 7,456 | yes |
  | Ska (skeletal models, `.smc/.bm/.ba`) | 11,552 | no — no TFE `.es` file references `CModelInstance`/Terrain (grep) |
  | Sound (mixer, decoders, objects) | 6,292 | yes |
  | Templates (containers, BSP template) | 6,110 | yes |
  | Terrain | 8,380 | no (TSE feature) |
  | World (world IO, CSG, collision, ray casting, collision grid) | 7,177 | yes |
  | zlib | 6,734 | replace with a crate |

  Total `S/Engine` incl. `.es`: 238,093 lines; minus Vulkan headers, D3D, Ska, Terrain, zlib, GameAgent ≈ **168k
  lines** relevant to TFE.
- Other modules (local counts): `S/Entities` 168,799 lines in total, of which `.es` sources 64,153 lines in 122 files
  (two are unused variants `PlayerWeaponsHD.es`/`PlayerWeapons_old.es` copied over `PlayerWeapons.es` at configure time,
  [S/CMakeLists.txt:615-621](../../../src/SamTFE/Sources/CMakeLists.txt)); the TFE build lists **120** `entity()`
  classes ([S/CMakeLists.txt:700-972](../../../src/SamTFE/Sources/CMakeLists.txt)) = **54,411 `.es` lines**;
  generated `.cpp/.h` (excluding `_tables.h`) 93,852 lines incl. hand-written `Entities/Common/*` 7,111 lines
  (Particles.cpp 3,003, HUD.cpp 1,287, Common.cpp 1,132, PathFinding.cpp 297). Engine base classes in `.es`:
  5 files, 3,631 lines (`MovableEntity.es` alone 3,119). `S/GameMP` (built as the TFE Game library: Netricsa
  computer, console, controls, map, session properties, [S/CMakeLists.txt:1003-1012](../../../src/SamTFE/Sources/CMakeLists.txt))
  10,229 lines; `S/SeriousSam` (executable, menus) 13,729 lines; `S/Ecc` 9,355 lines of which real sources are
  `Parser.y` 1,450 + `Scanner.l` 187 + `Main.cpp` 348 (the rest is bison/flex output).
- Data actually shipped with TFE (local `data/tfe-full`, 410 MB): 6 `.gro` (zip) archives holding 2,457 files —
  17 `.wld`, 359 `.mdl`, 1,229 `.tex`, 331 `.wav`, 55 `.ogg`, 102 `.ecl`, 7 `.ani`, 6 `.fnt`, 116 `.txt`, 29 `.des`;
  15 single-player levels `01_Hatshepsut.wld` … `15_TheGreatPyramid.wld` under `Levels/`; demos are `.dem` files
  under `Demos/`. (Measured with `unzip -Z1` over the archives.)
- Our existing port: Emscripten port + host glue in `port/common` (e.g. `gl1shim.c` 1,141 lines that turns the
  engine's fixed-function GL into WebGL2/WebGPU, `Se1ModHost.cpp` 380 lines) and a Rust mod layer
  `rust/se1-mod` 8,675 lines + `rust/se1-server` 677 lines — local [port/common](../../../port/common/), [rust](../../../rust/).

### Inferences
- A faithful Bevy rewrite has to reproduce roughly 168k lines of engine behaviour and 54k lines of `.es` gameplay,
  i.e. ~220k lines of 2001-era C++ semantics, while the asset readers are the comparatively small part.
- Skipping Ska/Terrain/Vulkan/D3D/GameAgent removes ~70k lines from scope without losing TFE content.

### Gaps
- No precise split of comment vs code lines (no `cloc`/`tokei` run); counts are raw lines.
- The 42 loose `.wld` files under `data/tfe-full` include demo/extra levels; I did not dedupe them against the 17 in `.gro`.

---

## Q1. World format (.wld): what is stored, what must be parsed vs recomputed, is it documented?

### Takeaway
A `.wld` is a chunked binary dump of the engine's in-memory world: CSG brushes already split into sectors with
double-precision vertices/planes, polygons with 3 texture layers, **precomputed triangulation, per-polygon shadow
maps (per-light layers), and a per-sector BSP tree**, plus portal-sector links and the full entity state (property
values keyed by numeric IDs and each entity's AI state stack). Nothing essential must be recomputed to *play*; all
of it must be parsed. The format is **not documented anywhere public** — the C++ readers in the GPL source are the only spec.

### Cited Findings
- Load path: `CWorld::Load_t` → version check → `Read_t` expects `WRLD`, reads info, brush archive
  (`wo_baBrushes.Read_t`, line 202), terrains (209), then world state `WSTA` and `WEND` —
  [S/Engine/World/WorldIO.cpp:60-235](../../../src/SamTFE/Sources/Engine/World/WorldIO.cpp).
- World state (`ReadState_new_t`, line 551; older versions at 304/434 are still supported): background viewer
  `BGVW`, backdrop `BRDP/BDRO`, viewer position `VWPS`, thumbnail `TBPS`, **shadow animations `SHAN`**, entity
  class table `ECLs`, entities `ENTs` — [WorldIO.cpp:304-569](../../../src/SamTFE/Sources/Engine/World/WorldIO.cpp).
- Brush archive: `BRAR` → count → each `CBrush3D` (`BR3D`…`BREN`, mip levels `BRMP`) → portal-sector links
  `PSLS…PSLE` → `EOAR` — [S/Engine/Brushes/BrushArchive.cpp:470-513, 245-307](../../../src/SamTFE/Sources/Engine/Brushes/BrushArchive.cpp);
  entity-sector links `ESL2…ESLE` (311-370).
- Sector chunk `BSC `: flags, vertices `VTXs` stored as `DOUBLE3D`, planes `PLNs` as `DOUBLEplane3D`, edges
  `EDGs`, polygons `BPOs` (flags, 3 `CBrushPolygonTexture` layers with mapping, `bpo_bppProperties` raw struct),
  **triangle elements read from file** (595), **shadow map** `bpo_smShadowMap.Read_t` (600), `CalculateVolume()`
  (616), and **BSP tree `BSP0`** read from file (622-624) —
  [S/Engine/Brushes/BrushIO.cpp:373-630](../../../src/SamTFE/Sources/Engine/Brushes/BrushIO.cpp).
  Note raw `Read_t(&struct, sizeof(struct))` dumps (e.g. `bpo_bppProperties`, mapping definitions) — layout is the
  MSVC 32-bit struct layout.
- Shadow maps are not flat lightmaps: each polygon's `CBrushShadowMap` holds a list of `CBrushShadowLayer`s, one
  per light source, each a bit mask over a pixel rectangle (`bsl_pixMinU/V`, `bsl_slSizeInPixels`) —
  [S/Engine/Brushes/Brush.h:176-185](../../../src/SamTFE/Sources/Engine/Brushes/Brush.h). `CLayerMixer` composites
  layers at runtime with the current light colour, including animated lights (`ls_paoLightAnimation` →
  `SMF_ANIMATINGLIGHTS`) and dynamic lights (`LSF_DYNAMIC`, "fast frequent caching, no shadows") —
  [S/Engine/Light/LayerMixer.cpp:2515-2679](../../../src/SamTFE/Sources/Engine/Light/LayerMixer.cpp) (2,706 lines),
  [S/Engine/Light/LightSource.h:34,61](../../../src/SamTFE/Sources/Engine/Light/LightSource.h).
- Portal-sector links are rebuilt with BSP cutting if missing (`LinkPortalsAndSectors`, BSP polygon cut against
  the sector BSP) — [BrushArchive.cpp:115-192](../../../src/SamTFE/Sources/Engine/Brushes/BrushArchive.cpp).
- Entities: `ENT4` chunk with render type, physics/collision/spawn flags, rotation matrix, brush index, then
  properties as `(ID<<8 | type)` + value matched by `PropertyForTypeAndID` —
  [S/Engine/Entities/Entity.cpp:3292-3339](../../../src/SamTFE/Sources/Engine/Entities/Entity.cpp),
  [S/Engine/Entities/EntityProperties.cpp:103-135](../../../src/SamTFE/Sources/Engine/Entities/EntityProperties.cpp);
  the AI **state stack** (`en_stslStateStack`, numeric state IDs) is read/written per entity —
  [Entity.cpp:3788-3810](../../../src/SamTFE/Sources/Engine/Entities/Entity.cpp).
- Entity classes are referenced through `.ecl` text stubs, e.g. `Classes/Eruptor.ecl` = `Package: TFNM Bin\Entities.dll`
  / `Class: CEruptor` (read from `data/tfe-full` `.gro`); 102 `.ecl` files ship with TFE.
- Size of the CSG/world code that the editor uses to *produce* these files: `WorldCSG.cpp` 1,401,
  `BrushTriangularize.cpp` 976, `BrushShadows.cpp` 753, `Templates/BSP.cpp` 1,612, `Math/ObjectSector.cpp` 1,967,
  `Object3D_CSG.cpp` 687 lines (local `wc`).
- Web: searches for a public SE1 `.wld` spec or third-party parser returned only other games' `.wld` formats
  (EverQuest, Redguard) and the engine repos — [search hits incl. tx00100xt/SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic);
  the community modding Q&A documents no `.wld/.mdl/.tex` internals — [rentry SamClassicQNA](https://rentry.org/SamClassicQNA).
  Community entity reference exists (behaviour, not format) — [SED1 entity docs](https://rentry.co/SED1Docs).

### Inferences
- **Parse, don't recompute:** geometry, triangulation, BSP, shadow layers and entity state are all baked; a Rust
  reader can port `Read_t` chunk by chunk (~1.5–2.5k lines of Rust for brushes + world state, est.). CSG, BSP
  building and shadow calculation are only needed for editing (e.g. the "world tool" in `notes/big-ideas.md`), not to play.
- **Hard part is entity state, not geometry:** entity properties are keyed by class-specific numeric IDs and the
  state stack stores Ecc-generated state numbers (e.g. `0x012f000e` in `Headman.cpp`, class 0x012f). A rewrite must
  reproduce each class's property-ID table and state numbering exactly, or translate `.wld` entities into a new
  schema at import time. Initial levels are "savegames" of the editor's world, so state stacks matter even at level start.
- **Lighting look:** a Bevy port cannot just bake a static lightmap per polygon; to keep flickering/animated
  lights and dynamic lights, it needs the layer-mixing step (CPU like the original, or a GPU shader that sums
  per-light mask layers × animated colours).
- Byte-level pitfalls: MSVC struct dumps, `DOUBLE` vertices, multiple legacy versions (`ENT2/ENT3/ENT4`, three
  `WSTA` versions) — TFE levels may hit older paths; verifying against all 15 shipped levels is required.

### Gaps
- No public format doc or non-C++ parser found; the GPL source is the only reference (needs reading of
  `CBrushShadowMap::Read_t`, `CMappingDefinition`, `CBrushPolygonProperties` layouts).
- Did not measure what fraction of shipped `.wld` files use the old vs new world-state versions.

---

## Q2. Models (.mdl), textures (.tex), effects/particles, sounds — and third-party parsers

### Takeaway
`.mdl` is a vertex-animated mesh format (per-frame compressed vertices, mip models, polygonal patches, attachment
positions, collision boxes; 8 historical versions) with an 13.4k-line engine module; `.tex` is a chunked texture
with mip data, optional animation frames and optional procedural "texture effects" (fire/water/plasma). Sounds are
plain WAV/OGG. Third-party support is thin: one C# `.tex` converter; no `.mdl` or `.wld` parser in any language was found.

### Cited Findings
- `.mdl`: `MDAT` + version chunk with 8 version branches (`WITHOUT_STRETCH_CENTER`, `…MULTIPLE_COLLISION_BOXES`,
  `…ATTACHED_POSITIONS`, `…POLYGONAL_PATCHES`, `…POLYGONS_PER_SURFACE`, `…16_BIT_COMPRESSION`,
  `…REFLECTION_AND_SPECULARITY`, `…DIFFUSE_COLOR`), patches `PTC2`, attachment positions `POSS`, collision boxes
  `COLI`, mip models `MDPL/MDP2`, texture vertices `TXVT` —
  [S/Engine/Models/Model.cpp:520-1953](../../../src/SamTFE/Sources/Engine/Models/Model.cpp) (3,110 lines);
  model rendering incl. shading `RenderModel_View.cpp` 3,503 lines; animation data via `Base/Anim.cpp` 1,151 lines.
- `.tex`: `TVER`, then `TDAT` (data), `FRMS` (frames), `ANIM` (animations), `FXDT` (effect data) —
  [S/Engine/Graphics/Texture.cpp:707-1126](../../../src/SamTFE/Sources/Engine/Graphics/Texture.cpp) (1,868 lines);
  procedural texture effects in `TextureEffects.cpp` 3,471 lines.
- Particles are immediate-mode helpers in hand-written C++, not data: `Entities/Common/Particles.cpp` 3,003 lines,
  engine side `Graphics/DrawPort_Particles.cpp` 646 lines; TFE `.es` files contain 114 `Particles_*` call sites.
  Effects are entity classes (`BasicEffects.es` 1,253 lines, `Effector.es` 483, `Projectile.es` 2,558) — local counts,
  and see [notes/survivors-engine.md](../../survivors-engine.md) for `BET_*` effect types.
- Sound: `Sound/` 6,292 lines (mixer 1,010, library 1,812, decoders 607 using Vorbis/amp11lib), SDL callback +
  ring buffer — [notes/engine-map.md §4](../../engine-map.md). TFE ships 331 `.wav` + 55 `.ogg`.
- Third-party tools found:
  - `SS1TexConverter` (C#): converts to/from the Classics/Revolution `.tex` format, reverse-engineered from an old
    VB6 converter; supports TGA/JPEG/PNG/BMP/TIFF; no mention of animated textures or effects —
    [purifetchi/SS1TexConverter](https://www.github.com/purifetchi/SS1TexConverter).
  - `TEXConv` (in the GPL tree) converts `.tex` → `.tga` — [Croteam-official/Serious-Engine](https://github.com/Croteam-official/Serious-Engine), local `S/TEXConv`.
  - `io_sedASCII` Blender add-on: imports/exports Serious Editor ASCII formats (AMF/ASF/AAF — SKA ASCII, not `.mdl`) —
    [naomiEve/io_sedASCII](https://github.com/naomiEve/io_sedASCII); `SeriousSkaConverter` for ASCII SKA models —
    [DreamyCecil/SeriousSkaConverter](https://github.com/DreamyCecil/SeriousSkaConverter).
  - Community workflow for `.mdl` is *into* the engine: export each animation frame as OBJ and assemble in Serious
    Modeler via a script; "Serious Engine uses mostly vertex animation" — [rentry SamClassicQNA](https://rentry.org/SamClassicQNA).
  - No dedicated `.mdl` → glTF/OBJ exporter or Noesis plugin was found; old forum claim of Milkshape support is
    unverified — [hiveworkshop thread](https://www.hiveworkshop.com/threads/serious-sam-1-2-models.23418).

### Inferences
- `.mdl` → Bevy: convert offline to glTF with **morph targets** or (better for many frames) a vertex-animation
  texture; Bevy has morph targets but each `.mdl` animation can have dozens of frames, so a custom VAT material is
  the practical path. Attachments (weapons on hands, heads) are positional, map to child transforms updated per frame.
  Difficulty: **medium** (format is fully readable in `Model.cpp`; risk is the custom lighting/shading of models).
- `.tex` → Bevy `Image`: **easy** for static mips; **medium** for animated textures (frame index driven by time);
  **medium-hard** for `FXDT` effect textures (3.5k lines of per-pixel procedural code; needs a CPU or compute port to look the same).
- Sounds: **easy** to load (bevy_audio/kira can play WAV/OGG); **medium** to match SE1's 3D attenuation,
  `SOF_*` flags, Doppler, and per-channel mixing semantics used by entities (338 `PlaySound` sites).
- Particles: **medium** — they are code, not data: 3k lines of hand-written C++ particle routines must be ported
  as procedural mesh builders; no particle-asset format to import.

### Gaps
- Did not find any public byte-level `.mdl` documentation; whether the 16-bit compression/normal encoding has
  surprises is unknown until a reader is written.
- Could not confirm whether any community Blender importer for classic `.mdl` exists beyond the frame-by-frame OBJ workflow.

---

## Q3. The .es entity language: classes, state-machine model, size, translation options

### Takeaway
TFE's gameplay is 120 `.es` classes (54k lines) — every monster, weapon, item, trigger, mover, effect and the
player. `.es` is C++ plus a coroutine-like state-machine DSL (`procedures`, `wait()/autowait()`, `on (EEvent)`,
`call/autocall/jump/return`) that Ecc lowers into numbered handler functions with an explicit state stack. A
transpiler is feasible (Ecc's grammar is only ~1.6k lines) but the bodies are raw C++ against ~400+ engine API
names, so "transpile to Rust" really means "port 54k lines of C++ semantics".

### Cited Findings
- Class count: 120 TFE classes in the build ([S/CMakeLists.txt:700-972](../../../src/SamTFE/Sources/CMakeLists.txt)),
  plus 5 engine base classes in `.es` (`BaseEvents`, `MovableEntity`, `MovableModelEntity`, `MovableBrushEntity`,
  `PlayerEntity`) — [S/Engine/Classes](../../../src/SamTFE/Sources/Engine/Classes/).
- Largest classes (lines): `Player.es` 5,989, `PlayerWeapons.es` 4,864, `EnemyBase.es` 2,800, `Projectile.es` 2,558,
  `Devil.es` 2,430, `PlayerAnimator.es` 1,567, `Elemental.es` 1,524, `WorldBase.es` 1,263, `BasicEffects.es` 1,253,
  `PyramidSpaceShip.es` 936, `MovingBrush.es` 880, `MusicHolder.es` 807 — local `wc` on [S/Entities](../../../src/SamTFE/Sources/Entities/).
- Construct counts over the 120 used files (grep, approximate): `autowait(` 381; `wait(` blocks ~149 more;
  `autocall` 170; `call` 96; `jump` 229; `on (E…)` handlers 465; `otherwise` 63; `resume;` 295; `stop;` 157;
  `event E…` declarations 77; numbered properties ~1,476; components (model/texture/sound/class) ~1,233;
  procedure/function definitions ~889; `SendEvent` 133; `SendToTarget` 44; `PlaySound` 338;
  `StartModelAnim/PlayAnim` 531; `FRnd/IRnd` 506; `_pTimer->CurrentTick` 305; prediction checks 216 refs in 19 files.
- Lowered form: each `wait`/`autowait` splits a procedure into handler functions `H0x012f0003_Fire_01(const CEntityEvent&)`
  with `switch(ee_slEvent)`; transitions are `Jump(STATE_CURRENT, 0x012f000e, …)`, `Call(…)`, `Return(…, EReturn())`;
  `autowait(t)` = `SetTimerAfter` + wait for `ETimer` — generated [S/Entities/Headman.cpp:526-663](../../../src/SamTFE/Sources/Entities/Headman.cpp)
  from `Headman.es:472-521`. State IDs are `classID<<16 | n` (Headman = 0x012f).
- Runtime: `CRationalEntity` holds `en_timeTimer` and `en_stslStateStack`, with `Jump/Call/Return/UnwindStack/
  SetTimerAt/SetTimerAfter/HandleEvent` — [S/Engine/Entities/Entity.h:759-810](../../../src/SamTFE/Sources/Engine/Entities/Entity.h).
- Engine API surface: ~435 distinct function names declared in `S/Engine` headers are called from TFE `.es`
  (rough identifier intersection, upper-bound-ish). Most-used globals: `_pTimer->CurrentTick` 305,
  `_pShell->DeclareSymbol` 126, `_pTimer->TickQuantum` 125, `_pNetwork->IsPlayerLocal` 48,
  `_pTimer->GetLerpedCurrentTick` 27, `_pNetwork->GetEntityWithName` 11.
- Ecc itself: `Parser.y` 1,450 + `Scanner.l` 187 + `Main.cpp` 348 lines — [S/Ecc](../../../src/SamTFE/Sources/Ecc/).
- No public tutorial on `.es` syntax (`autowait`, procedures) was found by search; the community reference covers
  entity behaviour for mappers — [SED1 entity docs](https://rentry.co/SED1Docs); modding uses the SDK and recompiling
  `Entities.dll` — [rentry SamClassicQNA](https://rentry.org/SamClassicQNA).

### Inferences
- **Bevy mapping of the state model:** a per-entity component holding a state stack of `u32` state IDs plus a
  timer, and a system that dispatches events to `fn(&mut World, Entity, &Event) -> Transition` handlers, mirrors
  Ecc's output 1:1. Rust `async`/coroutines are tempting but break save/demo compatibility (state must be
  serialisable as plain numbers, exactly like `en_stslStateStack`).
- **Translation options:**
  1. *Transpiler* (Ecc-grammar → Rust): handles the DSL skeleton (properties, components, states, event switches)
     mechanically — maybe 25–35% of the text. Embedded C++ bodies (pointer-heavy `CEntityPointer`, `((CPlayer&)*pen)`
     casts, `FLOAT3D` operator `%` dot product, macros, `CTString`) do not transpile cleanly.
  2. *LLM-assisted per-class port* with the generated C++ as the reference and the running C++ game as an oracle
     (record demos, compare traces). Most plausible, but 54k lines + 7k `Common/` + 3.6k base classes ≈ 65k lines.
  3. *Keep `.es` → C++ and link it* into a Rust/Bevy host via FFI — this is what the current port already does;
     it defeats "rewrite" but de-risks.
- Hardest classes are the player/weapon trio (~12.4k lines with heavy view/animation/prediction code) and
  `EnemyBase` (AI, path finding through `NavigationMarker`s, watcher).

### Gaps
- Exact number of engine API *methods* per class was not computed (the 435 figure is a name-level estimate).
- No prior .es → other-language transpiler was found in public sources.

---

## Q4. Physics/collision: how custom, how gameplay-critical

### Takeaway
Movement is entirely custom: `CMovableEntity` (3,119 lines of `.es`) does swept-ellipsoid/sphere clipping
against brush polygons and other entities, stair stepping, sliding, per-polygon gravity, jumping and water/
friction, on a fixed 20 Hz tick. None of this maps to Rapier/Avian; to keep the game's feel (Sam's movement,
bunny-hop-like air control, rocket-jump impulses, monster stepping) it must be ported line by line.

### Cited Findings
- `MovableEntity.es`: `SendTouchEvent/SendBlockEvent` from `CClipMove` (1098-1113), `TryToGoUpstairs` (1440),
  `PreMoving` with `PreMovingNew/PreMovingOld` variants (2009-2441, gravity direction taken from the polygon below,
  `en_vGravityDir = -(plane)`), `DoMoving` (2854) — [S/Engine/Classes/MovableEntity.es](../../../src/SamTFE/Sources/Engine/Classes/MovableEntity.es).
- Collision against the world: `WorldCollision.cpp` 1,221, `WorldCollisionGrid.cpp` 480, `WorldRayCasting.cpp` 875,
  `Entities/EntityCollision.cpp`, `FieldBSPTesting.cpp` — local counts in [S/Engine/World](../../../src/SamTFE/Sources/Engine/World/).
- Fixed timestep: `CTimer::TickQuantum = 1/20 s` ("20 ticks per second") —
  [S/Engine/Base/Timer.cpp:308](../../../src/SamTFE/Sources/Engine/Base/Timer.cpp); entity code reads it 125× and
  `CurrentTick` 305×.
- Determinism is deliberately protected at build level: collision/ray-casting/CSG/projection sources are compiled
  into a separate `engine_safemath` library with `-fno-unsafe-math-optimizations` —
  [S/CMakeLists.txt:1110-1125](../../../src/SamTFE/Sources/CMakeLists.txt).
- Perf data from our port: at 500 monsters, line-of-sight ray casts ~21% and movement collision ~14% of engine
  time — [notes/big-ideas.md §2](../../big-ideas.md).

### Inferences
- **Difficulty: hard; risk: feel.** Physics engines (Rapier/Avian) use different contact resolution; Sam's
  movement, monster stepping, sliding on slopes, and gravity-per-polygon areas (e.g. gravity routers) would feel
  different. A port must reimplement `ClipMove` against the parsed brush polygons and the collision grid in plain Rust.
- Exactness matters most for: player feel (speed-running/strafe-jumping communities), projectile hit timing, monster
  behaviour (AI uses `ETouch/EBlock` events from the clipper), and — critically — demo/network compatibility, which
  needs bit-identical float results (see Q5).

### Gaps
- No measured community data on which movement quirks (e.g. strafe-jumping) TFE players rely on; not researched here.

---

## Q5. Networking, demos, saves

### Takeaway
SE1 networking is deterministic lockstep: the server batches all players' `CPlayerAction`s per 20 Hz tick
(`MSG_SEQ_ALLACTIONS`) and every client runs the whole simulation; clients additionally run "predictor" copies of
entities to hide latency, and sync is verified by CRCs of world state. Demos are the same action stream recorded
to disk; saves are the serialised world + session state. Reproducing this in Bevy requires a bit-deterministic
simulation — the single hardest cross-cutting requirement.

### Cited Findings
- `CPlayerAction` = translation, rotation, view rotation, 32-bit buttons, timestamp; "order is important for
  compression… do not reorder"; has `ChecksumForSync` — [S/Engine/Network/NetworkMessage.h:287-307](../../../src/SamTFE/Sources/Engine/Network/NetworkMessage.h).
- Session loop: `ProcessGameTick`, `ProcessPredictedGameTick`, `ProcessPrediction`, `FlushProcessedPredictions`,
  `ChecksumForSync`, `MakeSynchronisationCheck`, `ReadWorldAndState_t/WriteWorldAndState_t`, remembered levels
  (for returning to earlier levels) — [S/Engine/Network/SessionState.cpp:767-2172](../../../src/SamTFE/Sources/Engine/Network/SessionState.cpp)
  (2,231 lines); actions batched as `MSG_SEQ_ALLACTIONS` (756, 1183, 1413). Shared RNG `ses_ulRandomSeed*262147`
  (74-76) — entity code calls `FRnd/IRnd` 506×.
- Demos: `StartDemoRec_t` writes `DEMO` header then the stream; `StartDemoPlay_t` expects `DEMO`, with
  real-time/stop sync modes — [S/Engine/Network/Network.cpp:1311-1963](../../../src/SamTFE/Sources/Engine/Network/Network.cpp).
  TFE ships demo files `auto-demo0001.dem…` (local `data/tfe-full/Demos`).
- Network module size: 17,330 lines (`Network.cpp` 2,555, `SessionState.cpp` 2,231, `Server.cpp` 1,672,
  `CommunicationInterface.cpp` 1,391, …). Player input is applied in `CPlayer::ApplyAction` —
  [S/Entities/Player.es:3164](../../../src/SamTFE/Sources/Entities/Player.es).
- Prediction is entity-level: 216 prediction-related references across 19 `.es` files (grep `Predict`).

### Inferences
- **Bevy mapping:** Bevy has no built-in netcode. Options: (a) keep lockstep — then every system (physics, AI,
  RNG, entity iteration order, float math) must be deterministic across platforms; Bevy's parallel scheduler and
  unordered queries must be constrained to a single ordered schedule; `f32` libm differences (sin/cos/sqrt) across
  wasm/x86/ARM must be controlled (e.g. `libm` crate everywhere). (b) switch to server-authoritative snapshots
  (lightyear / bevy_replicon / GGRS for rollback) — simpler to make robust, but it **loses compatibility** with
  original demos and saves and changes the netcode feel.
- Original `.dem` playback in a rewrite is effectively only possible if the rewrite is bit-exact; realistically
  treat demos/saves as non-portable and use them only as test oracles against the C++ build.
- **Difficulty: hard (lockstep-exact) / medium (new netcode).** Main risk: desyncs from any divergence.

### Gaps
- Did not measure how often TFE co-op desyncs today on our wasm build vs native (would indicate how tolerant the
  community is).

---

## Q6. Rendering: what Bevy would change, and the "doesn't look like Serious Sam" risk

### Takeaway
SE1 renders sectors visible through portals using an edge/span rasteriser (ASER) for occlusion, draws
polygons with up to 3 texture layers + a mixed shadow-map layer + fog/haze textures, and lights models from the
shadow map under them. Bevy's PBR/clustered forward renderer is the wrong default: a faithful port needs a custom
unlit multi-layer material, CPU/GPU shadow-layer mixing, per-model "ambient+directional from below" shading,
and texture-based fog/haze. Without that, it will not look like Serious Sam.

### Cited Findings
- Rendering module 7,456 lines: `Render.cpp` 1,062, `RenderModels.cpp` 977, `RenderAdding.cpp` 924, `RenCache.cpp`
  920, `RendASER.cpp` 866 (active-edge-list scan-line code: "Add all edges in add list to active list… scan-line
  coherence") — [S/Engine/Rendering](../../../src/SamTFE/Sources/Engine/Rendering/).
- Scene/polygon drawing `DrawPort_RenderScene.cpp` 2,012 lines; fixed-function GL with `GL_COMBINE_EXT`, matrix
  stack, client arrays, clip planes, alpha test, immediate mode; **fog and haze are done with textures, not
  `glFog`** — [notes/engine-map.md §2](../../engine-map.md).
- Polygon textures: 3 layers per polygon with blend modes (`BPT_BLEND_OPAQUE/SHADE/BLEND/ADD`) —
  [BrushIO.cpp:489-530](../../../src/SamTFE/Sources/Engine/Brushes/BrushIO.cpp).
- Shadow-map layers mixed at runtime incl. animated and dynamic lights —
  [LayerMixer.cpp](../../../src/SamTFE/Sources/Engine/Light/LayerMixer.cpp); "Models are vertex-lit today" —
  [notes/big-ideas.md §4](../../big-ideas.md).
- Model rendering, shading and masks: `RenderModel_View.cpp` 3,503, `RenderModel_Mask.cpp` 542 lines (local).
- Our port already converts this pipeline into WebGL2/WebGPU via `gl1shim.c` (1,141 lines) — local
  [port/common/gl1shim.c](../../../port/common/gl1shim.c); 454 GL entry points are declared in `gl_functions.h` —
  [notes/engine-map.md §2](../../engine-map.md).

### Inferences
- **Bevy mapping:** level geometry → one mesh per sector (or per texture batch) with a custom `Material` that
  samples 3 UV-mapped layers + shadow map atlas + fog/haze, unlit, no tonemapping (Bevy defaults to TonyMcMapface
  tonemapping — must be set to none to keep colours). Visibility: Bevy's frustum culling is enough for
  performance on modern GPUs; portal/ASER culling can be dropped visually, but some gameplay/scripting reads
  visibility? (unverified). Background viewer (sky) = separate camera with its own world transform.
- Mirrors (`MirrorMarker`), haze/fog markers, lens flares, `BackgroundViewer` and texture effects each need custom
  passes. **Difficulty: medium-hard; risk: visual fidelity** (gamma, overbright 2× blending, lightmap filtering,
  mip bias, colour quantisation that define the 2001 look).

### Gaps
- Did not verify whether any gameplay code depends on renderer-side visibility results (e.g. `en_ulFlags` set
  during rendering, lens-flare occlusion tests).

---

## Q7. Scripting/data: data-driven vs hard-coded

### Takeaway
Almost everything that defines gameplay is compiled code: monster stats, weapons, damage, AI, effects, particles
and HUD are hard-coded in `.es`/C++. Data files supply geometry, entity placement + per-instance property values
(in `.wld`), assets, Netricsa texts, console/config scripts and level lists.

### Cited Findings
- Base stats live in code, e.g. enemy HP/variants (Headman 19.5 HP, Werebull 250, Lava Golem up to 10,000) and
  item types are `.es` enums/properties — [notes/survivors-engine.md](../../survivors-engine.md).
- Per-instance values are properties in the `.wld` (1,476 numbered properties exist across TFE classes; editor
  names such as `"Type"`, `"Character"`) — local grep; property serialisation
  [EntityProperties.cpp:103-135](../../../src/SamTFE/Sources/Engine/Entities/EntityProperties.cpp).
- Data in archives: 116 `.txt` (Netricsa messages etc.), 16 `.ini` (console scripts/controls), 29 `.des`,
  1 `.lst`, 7 `.ani`, 6 `.fnt` (local `.gro` listing). Console shell language is its own flex/bison parser
  (`Base/Parser.cpp` 3,057, `Base/Scanner.cpp` 2,342 lines); `.es` declares 126 shell symbols via `_pShell->DeclareSymbol`.
- Models are assembled with Serious Modeler script (`.src`) files at authoring time, not at runtime —
  [rentry SamClassicQNA](https://rentry.org/SamClassicQNA).

### Inferences
- A rewrite cannot be "a new engine reading the old data": the old data presumes the old code. Each of the 120
  classes' behaviour, and the meaning of each numbered property, must be re-created.
- The console/cvar scripts (`.ini`) would need a small interpreter or be replaced by Bevy settings; low gameplay impact.

### Gaps
- Did not inventory which `.ini` cvars change gameplay (e.g. difficulty/co-op options) vs presentation.

---

## Q8. Difficulty ratings and main risks per subsystem (synthesis)

### Takeaway
Asset loading is the easy ~10%; the hard parts are the 54k-line entity logic, the custom movement/collision, the
lightmap-layer look and (if desired) deterministic lockstep. A full exact rewrite is a multi-person-year effort;
a "data-compatible look-alike" is feasible but will diverge in feel.

### Cited Findings
- Sizes per subsystem are in Q0–Q7 (all local `wc`/grep on [S/](../../../src/SamTFE/Sources/)); no public prior
  reimplementation of SE1/TFE on Godot/Unity/Rust/Bevy was found — searches returned only C++ forks
  ([tx00100xt/SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic), [DreamyCecil/Serious-Engine](https://www.github.com/DreamyCecil/Serious-Engine),
  [fgsfdsfgs/Serious-Engine](https://github.com/fgsfdsfgs/Serious-Engine), [EXL/Serious-Engine](https://github.com/EXL/Serious-Engine),
  [SE1-Community/SE1-GameShell](https://github.com/SE1-Community/SE1-GameShell), [Serious Sam Evolution](https://twsdev.itch.io/sse)).

### Inferences
| Subsystem | SE1 size (lines) | Bevy counterpart | Difficulty | Main risk |
|---|---|---|---|---|
| GRO/zip VFS, streams, chunk IO | Base streams/unzip ~2.6k | `bevy_asset` custom `AssetReader` + `zip` crate | Easy | case-insensitive paths, `.gro` override order |
| `.tex` (static, animated) | Texture.cpp 1,868 | custom `AssetLoader` → `Image` | Easy/Medium | animated frame timing |
| Texture effects (`FXDT`) | TextureEffects.cpp 3,471 | CPU port or compute shader | Medium-Hard | water/fire look |
| `.mdl` + anims + attachments | Models 13,354 (+Anim 1,151) | VAT/morph-target material, child transforms | Medium | model shading from floor shadow map |
| `.wld` brushes/BSP/shadows | Brushes 7,062 + World 7,177 | loader → meshes + collision data | Medium | undocumented raw structs, legacy versions |
| `.wld` entity state | Entities core 8,706 | ECS components keyed by class/prop ID | Hard | property-ID/state-ID fidelity |
| Lighting (layer mixer, dynamic lights) | Light 4,535 | custom material + atlas updates | Medium-Hard | "doesn't look like SS" |
| World renderer (sectors, portals, fog/haze, mirrors, sky) | Rendering 7,456 + DrawPort ~4k | custom render graph nodes/materials | Medium-Hard | fidelity, mirrors |
| Movement/collision/ray casts | MovableEntity.es 3,119 + World collision ~2.6k | hand-ported systems (not Rapier) | Hard | feel, determinism |
| Entity state machines | 120 classes, 54,411 `.es` lines + 7,111 Common + 3,631 base | per-class Rust systems + state-stack runtime | Very hard (volume) | behavioural drift across ~890 procedures |
| Particles | 3,003 + 646 | procedural mesh systems | Medium | volume of hand-tuned code |
| Sound | 6,292 | bevy_audio / kira | Easy-Medium | 3D attenuation semantics |
| Networking/demos/saves | Network 17,330 | lockstep (custom) or lightyear/replicon/GGRS | Hard (exact) / Medium (new) | desync; demo/save incompatibility |
| Game shell, Netricsa, HUD, menus | GameMP 10,229 + SeriousSam 13,729 + HUD 1,287 | bevy_ui / egui | Medium | volume, fonts (`.fnt`) |
| Console/cvars | Parser/Scanner ~5.4k | small interpreter or settings | Easy-Medium | low |
| Not needed for TFE | Ska 11,552, Terrain 8,380, Vulkan/D3D ~41k, GameAgent 2,218 | — | — | — |

- Overall: an exact rewrite ≈ porting ~220k lines; even with LLM assistance and the C++ build as a test oracle, the
  long pole is entity logic + movement + look. The cheapest exactness oracle is the existing port: record demos /
  traces in the C++ build and diff the Rust build's per-tick entity states.

### Gaps
- No effort estimate from an actual prior SE1 reimplementation exists to calibrate against.
- Bevy-side claims (morph targets, tonemapping defaults, lack of built-in netcode, scheduler ordering) are from
  general knowledge of Bevy and were not re-verified against current Bevy release docs in this research.
