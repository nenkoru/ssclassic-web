/* SE1_THREADS build: the engine thread has no GL context (see sdlgl_threads.h).
 * These stand in for SDL's GL entry points the engine calls. Rendering goes through gl1shim's
 * command stream, which the page's main thread replays on its own WebGL2/WebGPU context. */
#ifdef SE1_THREADS
#define SE1_SDLGL_IMPL
#include <SDL.h>

extern "C" {
int SE1_SDL_GL_LoadLibrary(const char *) { return 0; }
SDL_GLContext SE1_SDL_GL_CreateContext(SDL_Window *) { return (SDL_GLContext)1; }   /* any non-NULL */
int SE1_SDL_GL_MakeCurrent(SDL_Window *, SDL_GLContext) { return 0; }
void SE1_SDL_GL_DeleteContext(SDL_GLContext) {}
void SE1_SDL_GL_SwapWindow(SDL_Window *) {}          /* frames are handed over in SE1_BeforeSwap */
int SE1_SDL_GL_SetSwapInterval(int) { return 0; }    /* the main thread's rAF loop paces us */
int SE1_SDL_GL_GetSwapInterval(void) { return 1; }
void SE1_SDL_GL_GetDrawableSize(SDL_Window *w, int *x, int *y) { SDL_GetWindowSize(w, x, y); }
int SE1_SDL_GL_GetAttribute(SDL_GLattr a, int *v) {
  switch (a) {
  case SDL_GL_DEPTH_SIZE: *v = 24; break;
  case SDL_GL_STENCIL_SIZE: *v = 8; break;
  case SDL_GL_RED_SIZE: case SDL_GL_GREEN_SIZE: case SDL_GL_BLUE_SIZE: *v = 8; break;
  case SDL_GL_DOUBLEBUFFER: *v = 1; break;
  default: *v = 0;
  }
  return 0;
}
}
#endif
