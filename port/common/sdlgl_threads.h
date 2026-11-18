/* Force-included (-include) into every engine/game translation unit of the SE1_THREADS build.
 *
 * The engine runs in a worker and never owns a GL context: gl1shim records commands and the page's
 * main thread replays them (render plan phase 3). SDL would try to create EGL/WebGL objects from the
 * worker, so the engine's SDL_GL_* calls are renamed to the stubs in SdlGlThreads.cpp. The renames
 * also apply to SDL's own prototypes, so the stubs keep exactly SDL's signatures.
 */
#ifndef SE1_SDLGL_THREADS_H
#define SE1_SDLGL_THREADS_H
#if defined(SE1_THREADS) && !defined(SE1_SDLGL_IMPL)
#define SDL_GL_LoadLibrary SE1_SDL_GL_LoadLibrary
#define SDL_GL_CreateContext SE1_SDL_GL_CreateContext
#define SDL_GL_MakeCurrent SE1_SDL_GL_MakeCurrent
#define SDL_GL_DeleteContext SE1_SDL_GL_DeleteContext
#define SDL_GL_SwapWindow SE1_SDL_GL_SwapWindow
#define SDL_GL_SetSwapInterval SE1_SDL_GL_SetSwapInterval
#define SDL_GL_GetSwapInterval SE1_SDL_GL_GetSwapInterval
#define SDL_GL_GetDrawableSize SE1_SDL_GL_GetDrawableSize
#define SDL_GL_GetAttribute SE1_SDL_GL_GetAttribute
#endif
#endif
