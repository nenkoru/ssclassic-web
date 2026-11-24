# Feature registry

Every feature of the port on top of the original engine. Before adding a feature, read the rules;
after landing one, add or update its row. Review every change against this file, omp's included.

## Rules

1. **One feature, one home.** Each feature lives in its own module:
   - a page script `port/web/<feature>.js`;
   - a Rust module `rust/se1-mod/src/<feature>/`;
   - a glue file `port/common/<Feature>.cpp`.

   It talks to the others only through the interfaces in rule 2. It never reaches into another
   feature's internals.
2. **Interfaces:**
   - Engine ↔ mod: the host table (`port/common/se1mod.h` + `rust/se1-mod/src/host.rs`). Calls are
     only appended, and the API version bumps with each addition.
   - Mod ↔ page: JSON messages (`ui_post` / `Module.se1ModUi`, answers through `_SE1Mod_UiSend`).
   - Engine ↔ page: `SE1_*` exports (`EMSCRIPTEN_KEEPALIVE`).
   - There are no shared globals between features.
3. **Engine edits are thin hooks.** An engine change calls out, `#ifdef SE1_WITH_RUSTMOD` or
   `__EMSCRIPTEN__`, to a glue function. The logic itself stays in glue or the mod. Heavy engine
   modifications are allowed (more players, new netcode, buildable geometry), but each one gets a
   row here, a reason and a test. `git diff vanilla -- src/` must stay explainable row by row.
4. **Switchable.** A feature that changes behaviour has a URL option, or is a mode (`?mode=`).
   Anything risky is off by default until it is verified. Debug options are named `sv*`, `bot*`, etc.
5. **Modes are plug-ins.** Survivors is one minigame; war will be the main mode; more minigames
   may come. A mode is a module under `rust/se1-mod/src/<mode>/` plus `port/web/<mode>.js`, chosen
   by `?mode=`. Anything two modes need (HUD warnings, bots, the director) moves to a shared module
   instead of being copied.
6. **Tested.** A feature has a test in `tools/test.sh`, unit tests for pure logic, or both. A
   feature without a test isn't done.
7. **Pure logic behind traits.** Logic that can be tested without the engine (navigation, AI,
   balance data, report maths) stays free of `host` calls. A thin adapter connects it.
8. **Remove what's unused.** A feature that's superseded or never used is deleted, not left
   behind a flag.

## Features

Status: ✅ landed and tested · 🧪 landed, partly tested · 🚧 in progress · 📝 planned.

| Feature | Status | Home | Switch | Test | Depends on |
|---|---|---|---|---|---|
| Browser port (WASM, SDL, files, sound) | ✅ | port/common/{CaseFs,WebAudio,WebDynamicLoader,ShellCall}.c*, port/web/{pre,audio}.js | — | flowtest, inputtest | — |
| Threaded engine (worker + GL command shim) | ✅ | port/common/{gl1shim.c,SdlGlThreads.cpp}, port/web/gfx.js | build `SE1_THREADS` | shimtest, vrangetest¹ | — |
| WebGPU renderer | ✅ | port/web/gfx-webgpu.js | `?gfx=webgpu` | bench + shotdiff | shim |
| Dynamic resolution and quality controller | ✅ | rust/se1-mod/src/quality.rs, gfx.js applyScale | `?quality=auto`, `?scale=` | qualitytest | mod |
| Post-processing (FXAA, sharpen) | ✅ | gfx.js post pass | `?post=fxaa,sharpen` | posttest, shotdiff | gfx |
| Input: mouse lock, keyboard | ✅ | port/web/input.js, SDLInput.cpp hooks | — | inputtest | — |
| Touch controls | ✅ | port/web/touch.js, `SE1_TouchLook` | automatic on touch | touchtest | input |
| Gamepad + aim assist + bullet magnetism | ✅ | port/web/gamepad.js, port/common/AimAssist.cpp, WorldRayCasting.cpp hook, Game.cpp hook | `?aimassist=0-3` | gamepadtest | input |
| DualSense gyro (WebHID) | ✅ | port/web/gyro.js | `?gyro=0`, `?gyrosens=` | gyrotest; tools/dualsense.html (manual) | gamepad |
| Persistence (saves, settings) | ✅ | port/common/Persist.cpp, port/web/persist.js | — | persisttest | — |
| Lazy data (big files on demand, OPFS cache) | ✅ | tools/lazydata.py (build split), port/common/LazyData.c (`fopen` hook in CaseFs.c), port/web/lazydata.js, Range in tools/devserver.py | build `SE1_LAZY_DATA` (on), `?lazycache=0` | menutime --check-lazy, test_lazydata.py, test_devserver.py | — |
| User data (the player's own game files) | ✅ | port/web/userdata.js, tools/basedata.py, `u` datasets in LazyData.c + lazydata.js, target `serioussam_byod` (port/CMakeLists.txt) | build `SE1_USER_DATA` (on; `<build>/byod/`), `?userdata=reset` | userdatatest | lazy data |
| Static hosting / packaging | ✅ | port/web/{isolate,coi-sw}.js, tools/package.sh, landing.html | — | packagetest | — |
| Multiplayer: virtual LAN switch | ✅ | rust/se1-server, port/common/NetLan.c, port/web/net.js | `?room=`, `&host=1` | mptest | — |
| Multiplayer: WebRTC data channels | 🧪 | port/web/net.js, se1-server signal relay | `&rtc=1` | mptest --rtc (local only; internet needs STUN/TURN) | LAN |
| Lobby | ✅ | port/web/lobby.js | Multiplayer button | lobbytest | LAN |
| Rust mod layer (host API v9) | ✅ | port/common/{Se1ModHost,Se1ModEntities}.cpp, se1mod.h, rust/se1-mod/src/{lib,host,config}.rs | build `SE1_RUSTMOD` | cargo test | — |
| Damage hook + projectile attribution | ✅ | Entity.cpp hooks (3 call sites), Se1ModHost.cpp | used by Survivors | damagetest, projtest¹ | mod |
| Serious Survivors mode (a minigame; war is the main mode) | ✅ | rust/se1-mod/src/survivors/, port/web/survivors.js | `?mode=survivors` | svtest, cargo test | mod, damage hook |
| Threat warnings + hit direction | ✅ | survivors (mod + page) for now; move to a shared HUD module when war mode needs it. Host `player_hurt` (API v7) | `?svthreats=0` | threattest | Survivors |
| Survivors auto guns (every owned gun fires on its own) | ✅ | survivors mod (`auto_guns`), data.rs `AUTO_GUNS` | `?svautofire=0` | autogunstest, autofiretest | Survivors |
| Playtest recording + report | ✅ | port/web/playtest.js, lib.rs `post_telemetry`, tools/devserver.py, tools/playtest-report.py | `?rec=1` | playtesttest, test_playtest_report.py | mod |
| Archipelago client (weapon pickups as checks, weapons as items) | 🧪 | port/web/archipelago.js (socket), rust/se1-mod/src/archipelago.rs, archipelago/serioussam_tfe (APWorld, tfe.toml); host `page_recv`, `pickups` (API v11); `WeaponItem.es` hook | `?ap=host:port`, `slot=`, `appass=`, `apscan=1`, `level=` | aptest, cargo test | mod |
| Benchmarks, visual regression | ✅ | port/web/bench.js, tools/{bench.mjs,shotdiff.py} | `?timedemo`, `?shots=` | test.sh | — |
| Bots: navigation graph | ✅ | rust/se1-mod/src/bots/nav.rs (pure Rust, behind the `World` trait); `impl Paths for NavGraph` in bots/mod.rs | — | tests/bots_nav_accept.rs | — |
| Bots: brain | ✅ | rust/se1-mod/src/bots/brain.rs (pure Rust, behind the `Paths` trait) | — | tests/bots_brain_accept.rs, bots_brain_accept2.rs | — |
| Bots: engine wiring + runtime | ✅ | engine: `CServer::AddVirtualPlayer`/`SetVirtualAction`, `_pSE1ServerTickHook`; glue: port/common/Se1ModBots.cpp (host API v8+); runtime: rust/se1-mod/src/bots/runtime.rs (behind the `BotHost` trait) | `?bots=N`, `?botskill=` | bottest, tests/bots_runtime_accept.rs | nav, brain, mod |
| Bots: baked nav graphs + doors | 🧪 | tools/navbake.mjs bakes data/<pack>/Nav/Levels/*.nav; runtime.rs `bake`, `use_baked`, `check_doors`; lib.rs `load_baked_nav`; door-aware ray `ray_door` (host API v10, Se1ModBots.cpp) | `?navbake=1` (the tool only), `?botroam=N` (tests) | tests/bots_runtime_accept.rs, nav.rs unit tests; tools/navroamtest.mjs (full data, `?botroam=N`) | bots runtime |
| More than 16 players | 📝 | Network.h limits, wire format | — | mptest at 32+ | LAN |
| War mode (lines, side missions, game master, roles, building) | 📝 | rust/se1-mod/src/war/, port/web/war.js | `?mode=war` | — | bots, >16 players |
| War map (persistent front) | 📝 | rust/se1-server | — | — | war mode |

¹ Exists but isn't run by `tools/test.sh` yet: to add.

## Engine changes since `vanilla`

`git diff --stat vanilla -- src/` touches 12 files (as of 2026-11-24):
- `SDLInput.cpp`: touch, pad and pointer exports.
- `Entity.cpp`: the damage hook.
- `WorldRayCasting.cpp`: the bullet-magnetism ray radius.
- `Game.cpp`: the aim-assist call.
- `SeriousSam.cpp`: the web frame loop, save requests and settings.
- `Network/Server.cpp`, `Server.h`: virtual players for bots (`AddVirtualPlayer`, `RemoveVirtualPlayer`,
  `SetVirtualAction`, `IsVirtualPlayer`) and `_pSE1ServerTickHook`, called once per tick before
  `MakeAllActions`.
- `Network/PlayerBuffer.cpp`, `PlayerBuffer.h`: the `plb_bVirtual` mark, so bot calls can never reach a
  human player.
- `Engine/Base/Console.cpp` (TFE and TSE): each console line also goes to the page's console
  (`SE1_WebConsolePut`, port/common/WebFrame.cpp).
- `Entities/WeaponItem.es`: with `SE1_WITH_RUSTMOD`, the mod may take a weapon pickup of the local
  player as an Archipelago check (`SE1Mod_Pickup`): the item is picked up but gives nothing
  (notes/archipelago.md).

Update this list when an engine change lands.
