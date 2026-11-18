# Serious Sam Classic (vk fork) — engine map for an Emscripten/wasm port

Paths are relative to `src/SamTFE/Sources` (S/) unless marked otherwise. SamTSE has the same structure.
Its differing engine files are: SDLEvents/Input/Synchronization/Timer, UnixDynamicLoader/FileSystem,
BrushArchive.cpp, Adapter.cpp, Graphics.cpp, vk_mem_alloc.h and the CMakeLists. Diff these when porting.

## Blockers / must-fix
- `Base/Types.h:90-111`: wasm32 isn't recognised. You get `#error "Unknown CPU-Architecture"` and
  `PLATFORM_NOT_X86=0`. Add `__wasm32__`/`__EMSCRIPTEN__` to both checks.
- S/CMakeLists.txt platform branches (150, 505-538, 1632-1676) cover only LINUX/MACOSX/FREEBSD/WINDOWS.
  Add an EMSCRIPTEN branch. Don't apply `-march=native` (~401) under emcc.
- The modules are all SHARED and loaded with dlopen. Link them statically, using the `STATICALLY_LINKED` hooks plus a
  name→pointer registry, and link with whole-archive so the `*_DLLClass` objects aren't dropped.
- The main loop is a blocking `while` in `SubMain` (SeriousSam.cpp:1214) and needs restructuring.
- The CTimer constructor sleeps until `SDL_AddTimer` fires (Timer.cpp:627-636), which deadlocks without threads.
  Use `USE_SINGLE_THREAD` (`SINGLE_THREADED`, NullSynchronization.cpp).

## 1. Build
- Top level (src/CMakeLists.txt): options at 7-11 (`USE_SYSTEM_VULKAN` defaults ON). Both games are added at 170-171.
- S/CMakeLists.txt options:
  - `USE_ASM` (70); OFF gives `USE_PORTABLE_C`.
  - Vulkan (83-90, 128-135).
  - `XPLUS` (612; runs `cp` at configure time).
  - `USE_SINGLE_THREAD` (628).
  - Tools (1556-1584).
- Code generation:
  - flex/bison macro at 648-675, used for the Ecc, Engine/Base and Ska parsers.
  - The `ecc` tool (679) is skipped if `-DECC=<path>` is passed, so build it natively first.
  - The `entity()` macro (684-696) generates `.cpp`/`.h`/`_tables.h` in the source tree.
  - Entity lists are at 708-972. Target `ParseEntities` (974).
- Targets:
  - Entities (977).
  - Game (1004).
  - Shaders (1025).
  - Engine (1482), which links the static `engine_safemath` (1118, `-fno-unsafe-math-optimizations`).
  - SeriousSam executable (1532).
  - Engine source lists: with Vulkan at 1127-1309, without Vulkan at 1310-1479.
- dlopen sites:
  - `Base/Unix/UnixDynamicLoader.cpp:116-190`.
  - `Entities/EntityClass.cpp:301-334` (`<Class>_DLLClass`).
  - `SeriousSam.cpp:507-530` (`GAME_Create`).
  - `Graphics/Shader.cpp:811-862`.
  - `Sound/SoundDecoder.cpp:221,240`.
  - `Base/IFeel.cpp:124`.

## 2. Graphics
- OpenGL backend:
  - Sources: `Gfx_OpenGL.cpp`, `Gfx_OpenGL_Textures.cpp`, and the state wrapper `Gfx_wrapper_OpenGL.cpp` (1172 lines).
  - `gl_functions.h` lists 454 `DLLFUNCTION` entries. They are loaded via `SDL_GL_GetProcAddress` (`SDL/SDLOpenGL.cpp:23-111`).
  - Extensions are fetched at Gfx_OpenGL.cpp:262-390.
- Fixed-function usage:
  - Matrix stack and ortho/frustum (wrapper 834-912).
  - `glTexEnvi` with `GL_COMBINE_EXT` (986).
  - Client arrays and `glDrawElements` (1051, 1139).
  - `glClipPlane`, alpha test and `glPolygonMode`.
  - Immediate mode in DrawPort.cpp and RenderModel*.cpp.
  - Fog and haze are done with textures, not `glFog`.
- Vulkan compiles out with `-DUSE_SYSTEM_VULKAN=OFF`.
- Backend selection: the cvar `sam_iGfxAPI` (SeriousSam.cpp:114). Buffers are swapped with `SDL_GL_SwapWindow` (GfxLibrary.cpp:2038).

## 3. Platform
- SDL init is at SeriousSam.cpp:688. Input: `Base/SDL/SDLInput.cpp` (relative mouse). Events: `SDLEvents.cpp` emulates PeekMessage.
- Main loop: `main` (1777) → `CommonMainline` (~1676) → `SubMain` (1196).
  - The loop at 1214 calls `DoGame()` (991/1580) and then `LimitFrameRate()` (356).
  - Also: `QuitScreenLoop` (~1147) and mod reload via `execl` (~1640).
- Threads:
  - Timer thread: covered under "Blockers" above.
  - GameAgent pthreads (GameAgent.cpp:1479).
  - SDL audio thread.
  - `__thread` TLS (ThreadLocalStorage.h:9).
- Asm: every block has a C fallback under `USE_PORTABLE_C` (Types.h:149-172). `DetectCPU` uses cpuid (Engine.cpp:195-270).

## 4. Sound
- SDL audio callback (`SoundLibrary.cpp:143-256`) reads from a ring buffer. The main thread fills it in `MixSounds` (1619), called via `UpdateSounds`.
- Vorbis (`ov_functions.h`) and amp11lib are loaded with dlopen. For wasm, link `-sUSE_VORBIS=1` directly.

## 5. Filesystem
- exe dir comes from `SDL_GetBasePath` and the user dir from `SDL_GetPrefPath` (UnixFileSystem.cpp:97).
- Data search logic: Engine.cpp:665-870.
- `InitStreams` (Stream.cpp:148) mounts every `*.gro` with `UNZIPAddArchive`.
- All IO is stdio, which maps directly onto the Emscripten FS.

## 6. Networking
- BSD UDP in `Network/CommunicationInterface.cpp` (socket 470, recvfrom 1293, sendto 1352).
- The singleplayer "Local" provider opens no socket and passes packets through in memory (~839).

## 7. Endianness / bits
- Little-endian. The 32-bit path (`PLATFORM_32BIT`, i386 build) already exists, so ILP32 is exercised.
