/* Persistent storage for the engine's user directory.
 *
 * The engine keeps settings, controls, player profiles and saved games under
 * SDL_GetPrefPath("Serious-Engine", "SeriousSam"), which on Emscripten is
 * /libsdl/SeriousSam/ (SDL creates the directory). By default that tree lives
 * in the in-memory filesystem and dies with the tab.
 *
 * Threaded build (WASMFS, -sWASMFS): WASMFS's OPFS backend makes /libsdl
 * persistent (the browser's Origin Private File System). Creating the backend
 * blocks on the browser's OPFS dedicated worker, so it must run on a pthread
 * - here, at the start of main(), before the engine touches the user dir.
 *
 * Single-threaded build (MEMFS, -lidbfs.js): port/web/persist.js mounts IDBFS
 * at /libsdl in Module.preRun and loads/saves it with FS.syncfs.
 */
#include <stdio.h>
#include <emscripten.h>
#include <emscripten/wasmfs.h>

#ifdef SE1_THREADS

extern "C" void SE1_InitPersistentStorage(void)
{
  backend_t opfs = wasmfs_create_opfs_backend();
  if (wasmfs_create_directory("/libsdl", 0777, opfs) != 0) {
    fprintf(stderr, "web: OPFS mount of /libsdl failed, settings won't persist\n");
  }
}

#endif  // SE1_THREADS
