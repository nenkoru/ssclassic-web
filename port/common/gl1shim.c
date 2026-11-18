/* gl1shim: the OpenGL 1.x fixed-function subset Serious Engine 1 uses, on WebGL2 (GLES 3.0).
 *
 * The engine fetches every GL entry point through SDL_GL_GetProcAddress (Engine/Graphics/
 * SDL/SDLOpenGL.cpp). On Emscripten that call is routed to SE1_GL1Shim_GetProcAddress(),
 * which returns:
 *   - a shim_* implementation for fixed-function / GL1-only calls (matrices, immediate mode,
 *     client arrays, texenv, alpha test, clip plane, ...) and for a few core calls whose GL1
 *     semantics differ from GLES3 (enable caps, glGetString, texture formats, draws);
 *   - the real WebGL2 function for everything else.
 *
 * Fixed-function state is turned into a small GLSL ES 3.00 program keyed by the state that
 * changes the shader (per-unit texture enable + env mode, alpha func, clip plane) — the same
 * idea as nfsu2-web's FF_FS + pipeline-key cache. Client arrays and immediate-mode vertices
 * are streamed into VBOs at draw time.
 */
#include <GLES3/gl3.h>
#include <emscripten.h>
#include <SDL.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- GL1 enums not in GLES3 headers ---- */
#define GL1_QUADS 0x0007
#define GL1_QUAD_STRIP 0x0008
#define GL1_POLYGON 0x0009
#define GL1_MODELVIEW 0x1700
#define GL1_PROJECTION 0x1701
#define GL1_TEXTURE 0x1702
#define GL1_TEXTURE_2D_CAP 0x0DE1 /* == GL_TEXTURE_2D, but as an enable cap */
#define GL1_ALPHA_TEST 0x0BC0
#define GL1_CLIP_PLANE0 0x3000
#define GL1_VERTEX_ARRAY 0x8074
#define GL1_NORMAL_ARRAY 0x8075
#define GL1_COLOR_ARRAY 0x8076
#define GL1_TEXTURE_COORD_ARRAY 0x8078
#define GL1_TEXTURE_ENV 0x2300
#define GL1_TEXTURE_ENV_MODE 0x2200
#define GL1_TEXTURE_ENV_COLOR 0x2201
#define GL1_MODULATE 0x2100
#define GL1_DECAL 0x2101
#define GL1_ADD 0x0104
#define GL1_COMBINE 0x8570
#define GL1_COMBINE_RGB 0x8571
#define GL1_COMBINE_ALPHA 0x8572
#define GL1_RGB_SCALE 0x8573
#define GL1_BLEND_ENV 0x0BE2 /* GL_BLEND as env mode */
#define GL1_REPLACE 0x1E01
#define GL1_CLAMP 0x2900
#define GL1_MAX_TEXTURE_UNITS 0x84E2
#define GL1_TEXTURE_COMPRESSED 0x86A1
#define GL1_TEXTURE_COMPRESSED_IMAGE_SIZE 0x86A0
#define GL1_TEXTURE_WIDTH 0x1000
#define GL1_TEXTURE_HEIGHT 0x1001
#define GL1_TEXTURE_INTERNAL_FORMAT 0x1003
#define GL1_TEXTURE_RED_SIZE 0x805C
#define GL1_TEXTURE_GREEN_SIZE 0x805D
#define GL1_TEXTURE_BLUE_SIZE 0x805E
#define GL1_TEXTURE_ALPHA_SIZE 0x805F

#define MAXUNITS 4

typedef double GLdouble;  /* GL1 types missing from GLES headers */
typedef double GLclampd;

typedef struct { float m[16]; } Mat4;

static void mat_identity(Mat4 *a) { memset(a, 0, sizeof *a); a->m[0] = a->m[5] = a->m[10] = a->m[15] = 1.0f; }
static void mat_mul(Mat4 *out, const Mat4 *a, const Mat4 *b) { /* out = a*b, column-major */
  Mat4 r;
  for (int c = 0; c < 4; c++)
    for (int rr = 0; rr < 4; rr++) {
      float s = 0;
      for (int k = 0; k < 4; k++) s += a->m[k * 4 + rr] * b->m[c * 4 + k];
      r.m[c * 4 + rr] = s;
    }
  *out = r;
}
static int mat_invert(Mat4 *out, const Mat4 *in) {
  const float *m = in->m; float inv[16];
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  float det = m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
  if (det == 0) return 0;
  det = 1.0f / det;
  for (int i = 0; i < 16; i++) out->m[i] = inv[i] * det;
  return 1;
}

/* ---- state ---- */
enum { ENV_MODULATE, ENV_REPLACE, ENV_DECAL, ENV_BLEND, ENV_ADD, ENV_COMBINE_MOD, ENV_COMBINE_REPLACE, ENV_COMBINE_ADD };

typedef struct { int size; GLenum type; int stride; const void *ptr; int enabled; } ClientArray;

typedef struct {
  int enabled;          /* glEnable(GL_TEXTURE_2D) on this unit */
  GLenum envMode, combineRGB;
  float rgbScale;
  float envColor[4];
  Mat4 texMat;
  float curTex[4];
  ClientArray tc;
} Unit;

static struct {
  int inited;
  Mat4 modelview, projection;
  GLenum matrixMode;
  int activeUnit, clientUnit;
  Unit u[MAXUNITS];
  int alphaTest; GLenum alphaFunc; float alphaRef;
  int clipPlane; float clipEye[4];
  float curColor[4];
  ClientArray vtx, col, nor;
  int lockedCount;
  /* immediate mode */
  int inBegin; GLenum beginMode;
  float *imm; int immCount, immCap;
  /* GLES caps we track for glIsEnabled */
  int capBlend, capCull, capDepth, capScissor, capDither, capPolyOffset;
  /* texture info for glGetTexLevelParameteriv */
  GLuint boundTex[MAXUNITS];
} S;

typedef struct { GLuint tex; GLint ifmt, w, h; } TexInfo;
static TexInfo *_texInfo; static int _ctTexInfo, _capTexInfo;
static TexInfo *tex_info(GLuint t, int create) {
  for (int i = 0; i < _ctTexInfo; i++) if (_texInfo[i].tex == t) return &_texInfo[i];
  if (!create) return NULL;
  if (_ctTexInfo == _capTexInfo) { _capTexInfo = _capTexInfo ? _capTexInfo * 2 : 256; _texInfo = realloc(_texInfo, _capTexInfo * sizeof(TexInfo)); }
  TexInfo *ti = &_texInfo[_ctTexInfo++]; memset(ti, 0, sizeof *ti); ti->tex = t; return ti;
}


/* ---- command stream (render plan phase 1, notes/render-plan.md) ----
   The shim records WebGL work instead of calling WebGL: state changes and draws go into a command
   buffer, vertex/index data into two per-flush arenas. SE1_GL1Shim_Flush() (before every swap, and
   before any call that needs WebGL right away: texture uploads, read-backs, queries) hands it all
   to port/web/gfx.js, which uploads each arena once and replays the commands on raw WebGL2.
   JS owns every WebGL object; C refers to them by integer handles.
   OPCODES MUST MATCH port/web/gfx.js. */
enum {
  OP_ENABLE = 1, OP_DISABLE = 2, OP_BLENDFUNC = 3, OP_DEPTHFUNC = 4, OP_DEPTHMASK = 5, OP_COLORMASK = 6,
  OP_CULLFACE = 7, OP_FRONTFACE = 8, OP_POLYOFFSET = 9, OP_VIEWPORT = 10, OP_SCISSOR = 11,
  OP_CLEARCOLOR = 12, OP_CLEARDEPTH = 13, OP_CLEARSTENCIL = 14, OP_CLEAR = 15, OP_DEPTHRANGE = 16,
  OP_ACTIVETEX = 17, OP_BINDTEX = 18, OP_TEXPARAMI = 19, OP_TEXPARAMF = 20, OP_DELTEX = 21,
  OP_USEPROG = 22, OP_UNIFORM1I = 23, OP_UNIFORM1F = 24, OP_UNIFORM4F = 25, OP_UNIFORMMAT4 = 26,
  OP_ATTRIB_ON = 27, OP_ATTRIB_OFF = 28, OP_ATTRIB_CONST = 29, OP_ATTRIB_PTR = 30,
  OP_DRAW_ELEMENTS = 31, OP_DRAW_QUADS = 32, OP_DRAW_ARRAYS = 33,
  OP_TEXIMAGE = 34, OP_PIXELSTORE = 35, OP_VSTREAMS = 36
};
typedef union { int32_t i; float f; } Word;
static Word *_cmd; static size_t _ncmd, _capcmd;
static int _batchOpen;
static void batch_open(void);
static Word *cmd(int op, int nargs) {
  if (!_batchOpen) { _batchOpen = 1; batch_open(); }   /* every batch starts with OP_VSTREAMS */
  if (_ncmd + 1 + nargs > _capcmd) {
    _capcmd = _capcmd ? _capcmd : 1 << 16;
    while (_ncmd + 1 + nargs > _capcmd) _capcmd *= 2;
    _cmd = realloc(_cmd, _capcmd * sizeof(Word));
  }
  Word *w = _cmd + _ncmd; w[0].i = op; _ncmd += 1 + nargs;
  return w + 1;
}
static void cmd_i(int op, int a) { cmd(op, 1)[0].i = a; }
static void cmd_ii(int op, int a, int b) { Word *w = cmd(op, 2); w[0].i = a; w[1].i = b; }
static void cmd_iii(int op, int a, int b, int c) { Word *w = cmd(op, 3); w[0].i = a; w[1].i = b; w[2].i = c; }
static void cmd_iiii(int op, int a, int b, int c, int d) { Word *w = cmd(op, 4); w[0].i = a; w[1].i = b; w[2].i = c; w[3].i = d; }
static void cmd_ff(int op, float a, float b) { Word *w = cmd(op, 2); w[0].f = a; w[1].f = b; }
static void cmd_ffff(int op, float a, float b, float c, float d) { Word *w = cmd(op, 4); w[0].f = a; w[1].f = b; w[2].f = c; w[3].f = d; }
/* op loc v[0..n-1] */
static void cmd_loc_fv(int op, int loc, const float *v, int n) {
  Word *w = cmd(op, 1 + n); w[0].i = loc;
  for (int i = 0; i < n; i++) w[1 + i].f = v[i];
}

typedef struct { uint8_t *p; size_t n, cap; } Arena;
/* Vertex data: one stream per attribute (position, color, 4 texcoord units). Every draw puts its
   vertices at a shared vertex cursor (_v0) and adds it to its indices / first vertex, so an
   attribute's pointer stays valid from draw to draw while its format is unchanged: the shim
   records vertexAttribPointer only when it must ("index rebasing"). The streams are listed in the
   batch's first command (OP_VSTREAMS); the replayer uploads them one after another and adds each
   stream's base to the attribute offsets. */
#define NSTREAMS (2 + MAXUNITS)
static Arena _vs[NSTREAMS], _ia;   /* vertex streams / index data of the current batch */
static Arena _da;        /* texture upload data of the current flush (OP_TEXIMAGE) */
static size_t arena_alloc(Arena *a, size_t n, size_t align) {
  size_t off = (a->n + align - 1) & ~(align - 1);
  if (off + n > a->cap) {
    a->cap = a->cap ? a->cap : 1 << 20;
    while (off + n > a->cap) a->cap *= 2;
    a->p = realloc(a->p, a->cap);
  }
  a->n = off + n;
  return off;
}
/* make room for n bytes at offset off (>= the arena's end) and move the end there */
static uint8_t *arena_at(Arena *a, size_t off, size_t n) {
  if (off + n > a->cap) {
    a->cap = a->cap ? a->cap : 1 << 20;
    while (off + n > a->cap) a->cap *= 2;
    a->p = realloc(a->p, a->cap);
  }
  a->n = off + n;
  return a->p + off;
}
typedef struct { int valid, size, type, norm, stride; size_t base; } PtrCache;
static PtrCache _ap[NSTREAMS];   /* attribute pointers recorded in this batch */
static uint32_t _v0;             /* vertex cursor of this batch */
static size_t _vstreamsAt;       /* word index of this batch's OP_VSTREAMS */
static void batch_open(void) {
  _vstreamsAt = _ncmd;
  Word *w = cmd(OP_VSTREAMS, 2 * NSTREAMS);
  for (int l = 0; l < 2 * NSTREAMS; l++) w[l].i = 0;
  _v0 = 0;
  memset(_ap, 0, sizeof(_ap));
}
/* before a batch is handed over: list the streams in its OP_VSTREAMS (ptr, length) */
static void batch_close(void) {
  if (!_batchOpen) return;
  Word *w = _cmd + _vstreamsAt + 1;
  for (int l = 0; l < NSTREAMS; l++) { w[2 * l].i = (int32_t)(uintptr_t)_vs[l].p; w[2 * l + 1].i = (int32_t)_vs[l].n; }
}
static int batch_has_work(void) { return _batchOpen && (_ncmd > _vstreamsAt + 1 + 2 * NSTREAMS || _ia.n); }
static void batch_reset(void) {
  _ncmd = 0; _ia.n = 0; _da.n = 0;
  for (int l = 0; l < NSTREAMS; l++) _vs[l].n = 0;
  _batchOpen = 0;
}

#ifdef SE1_THREADS
/* engine runs in a worker: the replayer (and WebGL/WebGPU) live on the page's main thread.
   Recorded batches go over asynchronously (hand_off below); the calls here are proxied
   synchronously. Pointers are into shared memory, valid on both threads. */
#include <emscripten/threading.h>
static int gfx_create_program(const char *vs, const char *fs, unsigned key)
  { return MAIN_THREAD_EM_ASM_INT({ return Module['se1gfx'].createProgram(UTF8ToString($0), UTF8ToString($1), $2 >>> 0); }, vs, fs, key); }
static int gfx_uniform_location(int prog, const char *name)
  { return MAIN_THREAD_EM_ASM_INT({ return Module['se1gfx'].uniformLocation($0, UTF8ToString($1)); }, prog, name); }
static int gfx_gen_texture(void) { return MAIN_THREAD_EM_ASM_INT({ return Module['se1gfx'].genTexture(); }); }
static void gfx_quad_capacity(int ctQuads) { MAIN_THREAD_EM_ASM({ Module['se1gfx'].quadCapacity($0); }, ctQuads); }
static void gfx_tex_image(int sub, int target, int level, int x, int y, int w, int h, int fmt, int type, const void *data, int len)
  { MAIN_THREAD_EM_ASM({ Module['se1gfx'].texImage($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10); }, sub, target, level, x, y, w, h, fmt, type, data, len); }
static void gfx_read_pixels(int x, int y, int w, int h, int fmt, int type, void *out, int len)
  { MAIN_THREAD_EM_ASM({ Module['se1gfx'].readPixels($0, $1, $2, $3, $4, $5, $6, $7); }, x, y, w, h, fmt, type, out, len); }
static int gfx_get_param(int pname, void *out, int isFloat)
  { return MAIN_THREAD_EM_ASM_INT({ return Module['se1gfx'].getParam($0, $1, $2); }, pname, out, isFloat); }
static void gfx_pixel_store(int p, int v) { MAIN_THREAD_EM_ASM({ Module['se1gfx'].pixelStore($0, $1); }, p, v); }
#else
EM_JS(void, gfx_replay, (const void *c, int n, const void *v, int nv, const void *ix, int ni, const void *d, int nd),
      { Module['se1gfx'].replay(c, n, v, nv, ix, ni, d, nd); });
EM_JS(int, gfx_create_program, (const char *vs, const char *fs, unsigned key),
      { return Module['se1gfx'].createProgram(UTF8ToString(vs), UTF8ToString(fs), key >>> 0); });
EM_JS(int, gfx_uniform_location, (int prog, const char *name),
      { return Module['se1gfx'].uniformLocation(prog, UTF8ToString(name)); });
EM_JS(int, gfx_gen_texture, (void), { return Module['se1gfx'].genTexture(); });
EM_JS(void, gfx_quad_capacity, (int ctQuads), { Module['se1gfx'].quadCapacity(ctQuads); });
EM_JS(void, gfx_tex_image, (int sub, int target, int level, int x, int y, int w, int h, int fmt, int type, const void *data, int len),
      { Module['se1gfx'].texImage(sub, target, level, x, y, w, h, fmt, type, data, len); });
EM_JS(void, gfx_read_pixels, (int x, int y, int w, int h, int fmt, int type, void *out, int len),
      { Module['se1gfx'].readPixels(x, y, w, h, fmt, type, out, len); });
EM_JS(int, gfx_get_param, (int pname, void *out, int isFloat), { return Module['se1gfx'].getParam(pname, out, isFloat); });
EM_JS(void, gfx_pixel_store, (int p, int v), { Module['se1gfx'].pixelStore(p, v); });

#endif

#ifndef SE1_THREADS
/* hand everything recorded so far to the replayer (exported: also called before every swap) */
void SE1_GL1Shim_Flush(void);
void SE1_GL1Shim_Flush(void) {
  if (batch_has_work()) { batch_close(); gfx_replay(_cmd, (int)_ncmd, 0, 0, _ia.p, (int)_ia.n, _da.p, (int)_da.n); }
  batch_reset();
}
#else
/* SE1_THREADS: asynchronous, double-buffered hand-off. A flush gives the current command buffer
   and arenas (a "batch") to the main thread without waiting (MAIN_THREAD_ASYNC_EM_ASM) and the
   shim carries on recording into the other batch: the engine records frame N+1 while the page
   replays frame N. The main thread clears the batch's busy flag once it has replayed it; the shim
   only waits when it laps the replayer. Synchronous calls (createProgram, readPixels...) use the
   same FIFO proxy queue, so they still run after every batch handed over before them. */
#include <emscripten/atomic.h>
typedef struct { Word *cmd; size_t capcmd; Arena vs[NSTREAMS], ia, da; int32_t busy; } Batch;
static Batch _batch[2];
static int _curBatch;
static void batch_switch(void) {
  Batch *b = &_batch[_curBatch];          /* save the current buffers into their slot */
  b->cmd = _cmd; b->capcmd = _capcmd; b->ia = _ia; b->da = _da;
  memcpy(b->vs, _vs, sizeof(_vs));
  _curBatch ^= 1;
  b = &_batch[_curBatch];                 /* wait until the replayer is done with the other one */
  while (emscripten_atomic_load_u32((void *)&b->busy))
    emscripten_futex_wait((void *)&b->busy, 1, 1000.0);
  _cmd = b->cmd; _capcmd = b->capcmd; _ia = b->ia; _da = b->da;
  memcpy(_vs, b->vs, sizeof(_vs));
  batch_reset();
}
float SE1_DemoTime(void);   /* port/common/WebFrame.cpp */
static void hand_off(int present) {
  Batch *b = &_batch[_curBatch];
  /* the frame's own demo time goes along: by the time the page replays this frame, the engine
     is already simulating the next one (the ?shots= capture picks frames by demo time) */
  double tDemo = present ? SE1_DemoTime() : -1.0;
  batch_close();
  emscripten_atomic_store_u32((void *)&b->busy, 1);
  MAIN_THREAD_ASYNC_EM_ASM({ Module['se1ReplayBatch']($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10); },
                           &b->busy, present, _cmd, (int)_ncmd, 0, 0, _ia.p, (int)_ia.n, _da.p, (int)_da.n, tDemo);
  batch_switch();
}
void SE1_GL1Shim_Flush(void);
void SE1_GL1Shim_Flush(void) { if (batch_has_work()) hand_off(0); }
/* end of frame: replay the rest of the frame, run the ?shots= capture and end the frame as ONE
   main-thread task (between two tasks the browser may present, and clear, the canvas) */
void SE1_GL1Shim_FlushFrame(void);
void SE1_GL1Shim_FlushFrame(void) { hand_off(1); }
#endif

/* ---- state caches: skip recording commands that change nothing (WebGL state persists
   across flushes; the engine never touches programs/buffers/attributes itself) ---- */
static int _curProgram = -1;
static uint32_t _attribEnabled, _attribConstValid;
static float _attribConst[2 + MAXUNITS][4];
static int _activeTexUnit = 0;

static void use_program(int p) { if (_curProgram != p) { cmd_i(OP_USEPROG, p); _curProgram = p; } }
static void attrib_enable(int loc, int on) {
  uint32_t bit = 1u << loc;
  if (on) { if (!(_attribEnabled & bit)) { cmd_i(OP_ATTRIB_ON, loc); _attribEnabled |= bit; } }
  else if (_attribEnabled & bit) { cmd_i(OP_ATTRIB_OFF, loc); _attribEnabled &= ~bit; }
}
static void attrib_const(int loc, const float v[4]) {
  attrib_enable(loc, 0);
  uint32_t bit = 1u << loc;
  if (!(_attribConstValid & bit) || memcmp(_attribConst[loc], v, 16) != 0) {
    cmd_loc_fv(OP_ATTRIB_CONST, loc, v, 4); memcpy(_attribConst[loc], v, 16); _attribConstValid |= bit;
  }
}
/* offsets are into this flush's vertex arena (uploaded at replay start) */
static void attrib_pointer(int l, int size, GLenum type, int norm, int stride, size_t off) {
  attrib_enable(l, 1);
  Word *w = cmd(OP_ATTRIB_PTR, 6);
  w[0].i = l; w[1].i = size; w[2].i = (int)type; w[3].i = norm; w[4].i = stride; w[5].i = (int)off;
}

static void shim_init(void) {
  if (S.inited) return;
  S.inited = 1;
  mat_identity(&S.modelview); mat_identity(&S.projection);
  S.matrixMode = GL1_MODELVIEW;
  for (int i = 0; i < MAXUNITS; i++) {
    mat_identity(&S.u[i].texMat);
    S.u[i].envMode = GL1_MODULATE; S.u[i].combineRGB = GL1_MODULATE; S.u[i].rgbScale = 1.0f;
    S.u[i].curTex[3] = 1.0f;
  }
  S.alphaFunc = GL_ALWAYS;
  S.curColor[0] = S.curColor[1] = S.curColor[2] = S.curColor[3] = 1.0f;
  S.capDither = 1;
  /* VAO and stream buffers live in port/web/gfx.js */
}

/* ---- shader cache ---- */
typedef struct {
  uint32_t key; int prog;
  GLint uMVP, uMV, uTexMat[MAXUNITS], uSampler[MAXUNITS], uEnvColor[MAXUNITS], uAlphaRef, uClip;
  /* last values sent, so unchanged uniforms are skipped */
  float cMVP[16], cMV[16], cClip[4], cAlphaRef, cTexMat[MAXUNITS][16], cEnv[MAXUNITS][4];
  uint32_t cValid;
} Prog;
static Prog _progs[256]; static int _ctProgs;

static int unit_env(const Unit *u) {
  switch (u->envMode) {
  case GL1_REPLACE: return ENV_REPLACE;
  case GL1_DECAL: return ENV_DECAL;
  case GL1_BLEND_ENV: return ENV_BLEND;
  case GL1_ADD: return ENV_ADD;
  case GL1_COMBINE:
    if (u->combineRGB == GL1_REPLACE) return ENV_COMBINE_REPLACE;
    if (u->combineRGB == GL1_ADD) return ENV_COMBINE_ADD;
    return ENV_COMBINE_MOD;
  default: return ENV_MODULATE;
  }
}

static uint32_t state_key(void) {
  uint32_t k = 0;
  for (int i = 0; i < MAXUNITS; i++) {
    uint32_t e = S.u[i].enabled ? (1u | ((uint32_t)unit_env(&S.u[i]) << 1)) : 0; /* 4 bits */
    k |= e << (i * 4);
  }
  uint32_t af = S.alphaTest ? (S.alphaFunc - GL_NEVER + 1) : 0; /* 0..8 → 4 bits */
  k |= af << 16;
  k |= (uint32_t)(S.clipPlane ? 1 : 0) << 20;
  return k;
}

static Prog *get_prog(uint32_t key) {
  for (int i = 0; i < _ctProgs; i++) if (_progs[i].key == key) return &_progs[i];
  if (_ctProgs == 256) _ctProgs = 0; /* crude eviction; never expected in practice */

  char vs[4096], fs[8192]; int n;
  n = snprintf(vs, sizeof vs,
    "#version 300 es\n"
    "layout(location=0) in vec4 aPos;\nlayout(location=1) in vec4 aCol;\n"
    "layout(location=2) in vec4 aTex0;\nlayout(location=3) in vec4 aTex1;\n"
    "layout(location=4) in vec4 aTex2;\nlayout(location=5) in vec4 aTex3;\n"
    "uniform mat4 uMVP; uniform mat4 uMV; uniform mat4 uTexMat[4]; uniform vec4 uClip;\n"
    "out vec4 vCol; out vec4 vTex0; out vec4 vTex1; out vec4 vTex2; out vec4 vTex3; out float vClip;\n"
    "void main(){ gl_Position = uMVP*aPos; gl_PointSize = 1.0; vCol = aCol;\n"
    " vTex0 = uTexMat[0]*aTex0; vTex1 = uTexMat[1]*aTex1; vTex2 = uTexMat[2]*aTex2; vTex3 = uTexMat[3]*aTex3;\n"
    " vClip = dot(uMV*aPos, uClip); }\n");
  (void)n;

  n = snprintf(fs, sizeof fs,
    "#version 300 es\nprecision highp float;\n"
    "in vec4 vCol; in vec4 vTex0; in vec4 vTex1; in vec4 vTex2; in vec4 vTex3; in float vClip;\n"
    "uniform sampler2D uS0; uniform sampler2D uS1; uniform sampler2D uS2; uniform sampler2D uS3;\n"
    "uniform vec4 uEnv0; uniform vec4 uEnv1; uniform vec4 uEnv2; uniform vec4 uEnv3; uniform float uAlphaRef;\n"
    "out vec4 oColor;\n"
    "void main(){ vec4 c = vCol; vec4 t;\n");
  if (key & (1u << 20)) n += snprintf(fs + n, sizeof fs - n, " if (vClip < 0.0) discard;\n");
  for (int i = 0; i < MAXUNITS; i++) {
    uint32_t e = (key >> (i * 4)) & 0xF;
    if (!(e & 1)) continue;
    int env = (int)(e >> 1);
    n += snprintf(fs + n, sizeof fs - n, " t = texture(uS%d, vTex%d.xy / vTex%d.w);\n", i, i, i);
    switch (env) {
    case ENV_REPLACE: n += snprintf(fs + n, sizeof fs - n, " c = t;\n"); break;
    case ENV_DECAL: n += snprintf(fs + n, sizeof fs - n, " c.rgb = mix(c.rgb, t.rgb, t.a);\n"); break;
    case ENV_BLEND: n += snprintf(fs + n, sizeof fs - n, " c.rgb = mix(c.rgb, uEnv%d.rgb, t.rgb); c.a *= t.a;\n", i); break;
    case ENV_ADD: n += snprintf(fs + n, sizeof fs - n, " c.rgb = min(c.rgb + t.rgb, 1.0); c.a *= t.a;\n"); break;
    case ENV_COMBINE_MOD: n += snprintf(fs + n, sizeof fs - n, " c.rgb = min(c.rgb * t.rgb * uEnv%d.w, 1.0); c.a *= t.a;\n", i); break;
    case ENV_COMBINE_REPLACE: n += snprintf(fs + n, sizeof fs - n, " c.rgb = min(t.rgb * uEnv%d.w, 1.0); c.a *= t.a;\n", i); break;
    case ENV_COMBINE_ADD: n += snprintf(fs + n, sizeof fs - n, " c.rgb = min((c.rgb + t.rgb) * uEnv%d.w, 1.0); c.a *= t.a;\n", i); break;
    default: n += snprintf(fs + n, sizeof fs - n, " c *= t;\n"); break;
    }
  }
  uint32_t af = (key >> 16) & 0xF;
  if (af) {
    static const char *cmp[] = { "false", "c.a < uAlphaRef", "c.a == uAlphaRef", "c.a <= uAlphaRef",
                                 "c.a > uAlphaRef", "c.a != uAlphaRef", "c.a >= uAlphaRef", "true" };
    n += snprintf(fs + n, sizeof fs - n, " if (!(%s)) discard;\n", cmp[af - 1]);
  }
  n += snprintf(fs + n, sizeof fs - n, " oColor = c; }\n");

  double tmStart = emscripten_get_now();
  int p = gfx_create_program(vs, fs, key);   /* GLSL for WebGL2; WebGPU builds WGSL from the key */

  fprintf(stderr, "gl1shim: compiled program %d (key %06x) in %.1f ms\n", _ctProgs, key, emscripten_get_now() - tmStart);
  Prog *pr = &_progs[_ctProgs++];
  pr->key = key; pr->prog = p;
  pr->uMVP = gfx_uniform_location(p, "uMVP");
  pr->uMV = gfx_uniform_location(p, "uMV");
  pr->uClip = gfx_uniform_location(p, "uClip");
  pr->uAlphaRef = gfx_uniform_location(p, "uAlphaRef");
  char name[32];
  for (int i = 0; i < MAXUNITS; i++) {
    snprintf(name, sizeof name, "uTexMat[%d]", i); pr->uTexMat[i] = gfx_uniform_location(p, name);
    snprintf(name, sizeof name, "uS%d", i); pr->uSampler[i] = gfx_uniform_location(p, name);
    snprintf(name, sizeof name, "uEnv%d", i); pr->uEnvColor[i] = gfx_uniform_location(p, name);
  }
  pr->cValid = 0;
  use_program(p);
  for (int i = 0; i < MAXUNITS; i++) if (pr->uSampler[i] >= 0) cmd_ii(OP_UNIFORM1I, pr->uSampler[i], i);
  return pr;
}

enum { CV_MVP = 1, CV_MV = 2, CV_CLIP = 4, CV_ALPHA = 8, CV_TEX = 16, CV_ENV = 16 << MAXUNITS };
#define UNIFORM_CHANGED(p, bit, cache, val, n) \
  (!((p)->cValid & (bit)) || memcmp((cache), (val), (n) * sizeof(float)) != 0)

static Prog *_lastProg; static uint32_t _lastKey = 0xFFFFFFFFu;
static void apply_program(void) {
  uint32_t key = state_key();
  Prog *p = (key == _lastKey && _lastProg) ? _lastProg : get_prog(key);
  _lastKey = key; _lastProg = p;
  use_program(p->prog);
  Mat4 mvp; mat_mul(&mvp, &S.projection, &S.modelview);
  if (UNIFORM_CHANGED(p, CV_MVP, p->cMVP, mvp.m, 16)) {
    if (p->uMVP >= 0) cmd_loc_fv(OP_UNIFORMMAT4, p->uMVP, mvp.m, 16); memcpy(p->cMVP, mvp.m, 64); p->cValid |= CV_MVP;
  }
  if (S.clipPlane) {
    if (UNIFORM_CHANGED(p, CV_MV, p->cMV, S.modelview.m, 16)) {
      if (p->uMV >= 0) cmd_loc_fv(OP_UNIFORMMAT4, p->uMV, S.modelview.m, 16); memcpy(p->cMV, S.modelview.m, 64); p->cValid |= CV_MV;
    }
    if (UNIFORM_CHANGED(p, CV_CLIP, p->cClip, S.clipEye, 4)) {
      if (p->uClip >= 0) cmd_loc_fv(OP_UNIFORM4F, p->uClip, S.clipEye, 4); memcpy(p->cClip, S.clipEye, 16); p->cValid |= CV_CLIP;
    }
  }
  if (S.alphaTest && UNIFORM_CHANGED(p, CV_ALPHA, &p->cAlphaRef, &S.alphaRef, 1)) {
    if (p->uAlphaRef >= 0) cmd_loc_fv(OP_UNIFORM1F, p->uAlphaRef, &S.alphaRef, 1); p->cAlphaRef = S.alphaRef; p->cValid |= CV_ALPHA;
  }
  for (int i = 0; i < MAXUNITS; i++) {
    if (!S.u[i].enabled) continue;
    if (UNIFORM_CHANGED(p, CV_TEX << i, p->cTexMat[i], S.u[i].texMat.m, 16)) {
      if (p->uTexMat[i] >= 0) cmd_loc_fv(OP_UNIFORMMAT4, p->uTexMat[i], S.u[i].texMat.m, 16); memcpy(p->cTexMat[i], S.u[i].texMat.m, 64); p->cValid |= CV_TEX << i;
    }
    float env[4] = { S.u[i].envColor[0], S.u[i].envColor[1], S.u[i].envColor[2], S.u[i].rgbScale };
    if (UNIFORM_CHANGED(p, CV_ENV << i, p->cEnv[i], env, 4)) {
      if (p->uEnvColor[i] >= 0) cmd_loc_fv(OP_UNIFORM4F, p->uEnvColor[i], env, 4); memcpy(p->cEnv[i], env, 16); p->cValid |= CV_ENV << i;
    }
  }
}

/* ---- matrices ---- */
static Mat4 *cur_mat(void) {
  if (S.matrixMode == GL1_PROJECTION) return &S.projection;
  if (S.matrixMode == GL1_TEXTURE) return &S.u[S.activeUnit].texMat;
  return &S.modelview;
}
static void shim_glMatrixMode(GLenum m) { shim_init(); S.matrixMode = m; }
static void shim_glLoadIdentity(void) { shim_init(); mat_identity(cur_mat()); }
static void shim_glLoadMatrixf(const GLfloat *m) { shim_init(); memcpy(cur_mat()->m, m, 64); }
static void shim_glMultMatrixf(const GLfloat *m) { shim_init(); Mat4 b; memcpy(b.m, m, 64); mat_mul(cur_mat(), cur_mat(), &b); }
static void shim_glTranslatef(GLfloat x, GLfloat y, GLfloat z) {
  shim_init(); Mat4 t; mat_identity(&t); t.m[12] = x; t.m[13] = y; t.m[14] = z; mat_mul(cur_mat(), cur_mat(), &t);
}
static void shim_glScalef(GLfloat x, GLfloat y, GLfloat z) {
  shim_init(); Mat4 t; mat_identity(&t); t.m[0] = x; t.m[5] = y; t.m[10] = z; mat_mul(cur_mat(), cur_mat(), &t);
}
static void shim_glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f) {
  shim_init(); Mat4 o; mat_identity(&o);
  o.m[0] = (float)(2 / (r - l)); o.m[5] = (float)(2 / (t - b)); o.m[10] = (float)(-2 / (f - n));
  o.m[12] = (float)(-(r + l) / (r - l)); o.m[13] = (float)(-(t + b) / (t - b)); o.m[14] = (float)(-(f + n) / (f - n));
  mat_mul(cur_mat(), cur_mat(), &o);
}
static void shim_glFrustum(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f) {
  shim_init(); Mat4 o; memset(&o, 0, sizeof o);
  o.m[0] = (float)(2 * n / (r - l)); o.m[5] = (float)(2 * n / (t - b));
  o.m[8] = (float)((r + l) / (r - l)); o.m[9] = (float)((t + b) / (t - b));
  o.m[10] = (float)(-(f + n) / (f - n)); o.m[11] = -1; o.m[14] = (float)(-2 * f * n / (f - n));
  mat_mul(cur_mat(), cur_mat(), &o);
}

/* ---- enables ---- */
static int is_gles_cap(GLenum c) {
  switch (c) {
  case GL_BLEND: case GL_CULL_FACE: case GL_DEPTH_TEST: case GL_DITHER: case GL_POLYGON_OFFSET_FILL:
  case GL_SCISSOR_TEST: case GL_STENCIL_TEST: case GL_SAMPLE_ALPHA_TO_COVERAGE: case GL_SAMPLE_COVERAGE:
    return 1;
  }
  return 0;
}
static void set_cap(GLenum c, int on) {
  shim_init();
  switch (c) {
  case GL1_TEXTURE_2D_CAP: S.u[S.activeUnit].enabled = on; return;
  case GL1_ALPHA_TEST: S.alphaTest = on; return;
  case GL1_CLIP_PLANE0: S.clipPlane = on; return;
  case GL_BLEND: S.capBlend = on; break;
  case GL_CULL_FACE: S.capCull = on; break;
  case GL_DEPTH_TEST: S.capDepth = on; break;
  case GL_SCISSOR_TEST: S.capScissor = on; break;
  case GL_DITHER: S.capDither = on; break;
  case GL_POLYGON_OFFSET_FILL: S.capPolyOffset = on; break;
  }
  if (is_gles_cap(c)) cmd_i(on ? OP_ENABLE : OP_DISABLE, (int)c);
  /* everything else (POLYGON_OFFSET_POINT/LINE, PN_TRIANGLES, MULTISAMPLE_3DFX, ...) is ignored */
}
static void shim_glEnable(GLenum c) { set_cap(c, 1); }
static void shim_glDisable(GLenum c) { set_cap(c, 0); }
static GLboolean shim_glIsEnabled(GLenum c) {
  shim_init();
  switch (c) {
  case GL1_TEXTURE_2D_CAP: return S.u[S.activeUnit].enabled;
  case GL1_ALPHA_TEST: return S.alphaTest;
  case GL1_CLIP_PLANE0: return S.clipPlane;
  case GL1_VERTEX_ARRAY: return S.vtx.enabled;
  case GL1_COLOR_ARRAY: return S.col.enabled;
  case GL1_NORMAL_ARRAY: return S.nor.enabled;
  case GL1_TEXTURE_COORD_ARRAY: return S.u[S.clientUnit].tc.enabled;
  }
  /* answered from shadow state: WebGL lags the recorded stream */
  switch (c) {
  case GL_BLEND: return S.capBlend;
  case GL_CULL_FACE: return S.capCull;
  case GL_DEPTH_TEST: return S.capDepth;
  case GL_SCISSOR_TEST: return S.capScissor;
  case GL_DITHER: return S.capDither;
  case GL_POLYGON_OFFSET_FILL: return S.capPolyOffset;
  }
  return GL_FALSE;
}
static void shim_glAlphaFunc(GLenum f, GLclampf ref) { shim_init(); S.alphaFunc = f; S.alphaRef = ref; }
static void shim_glClipPlane(GLenum p, const GLdouble *eq) {
  shim_init();
  if (p != GL1_CLIP_PLANE0) return;
  /* plane is given in object space of the current modelview; store in eye space: eq * inverse(MV) */
  Mat4 inv; if (!mat_invert(&inv, &S.modelview)) mat_identity(&inv);
  for (int c = 0; c < 4; c++)
    S.clipEye[c] = (float)(eq[0] * inv.m[c * 4 + 0] + eq[1] * inv.m[c * 4 + 1] + eq[2] * inv.m[c * 4 + 2] + eq[3] * inv.m[c * 4 + 3]);
}

/* ---- texture units & env ---- */
static void shim_glActiveTexture(GLenum t) {
  shim_init(); S.activeUnit = (int)(t - GL_TEXTURE0) & (MAXUNITS - 1);
  if (_activeTexUnit != S.activeUnit) { cmd_i(OP_ACTIVETEX, (int)t); _activeTexUnit = S.activeUnit; }
}
static void shim_glClientActiveTexture(GLenum t) { shim_init(); S.clientUnit = (int)(t - GL_TEXTURE0) & (MAXUNITS - 1); }
static void shim_glTexEnvi(GLenum target, GLenum pname, GLint v) {
  shim_init();
  if (target != GL1_TEXTURE_ENV) return; /* e.g. TEXTURE_FILTER_CONTROL lod bias: ignored */
  Unit *u = &S.u[S.activeUnit];
  if (pname == GL1_TEXTURE_ENV_MODE) u->envMode = (GLenum)v;
  else if (pname == GL1_COMBINE_RGB) u->combineRGB = (GLenum)v;
  else if (pname == GL1_RGB_SCALE) u->rgbScale = (float)v;
}
static void shim_glTexEnvf(GLenum target, GLenum pname, GLfloat v) {
  if (pname == GL1_RGB_SCALE) { shim_init(); if (target == GL1_TEXTURE_ENV) S.u[S.activeUnit].rgbScale = v; return; }
  shim_glTexEnvi(target, pname, (GLint)v);
}
static void shim_glTexEnvfv(GLenum target, GLenum pname, const GLfloat *v) {
  shim_init();
  if (target == GL1_TEXTURE_ENV && pname == GL1_TEXTURE_ENV_COLOR) memcpy(S.u[S.activeUnit].envColor, v, 16);
  else shim_glTexEnvf(target, pname, v[0]);
}
static void shim_glGetTexEnviv(GLenum target, GLenum pname, GLint *out) {
  shim_init();
  Unit *u = &S.u[S.activeUnit];
  if (pname == GL1_TEXTURE_ENV_MODE) *out = (GLint)u->envMode;
  else if (pname == GL1_COMBINE_RGB) *out = (GLint)u->combineRGB;
  else if (pname == GL1_RGB_SCALE) *out = (GLint)u->rgbScale;
  else *out = 0;
}

/* ---- textures ---- */
static void shim_glBindTexture(GLenum target, GLuint t) {
  shim_init();
  if (S.boundTex[S.activeUnit] == t) return;
  S.boundTex[S.activeUnit] = t; cmd_ii(OP_BINDTEX, (int)target, (int)t);
}
/* Texture uploads are commands in the stream (pixels copied into the data arena), so they replay
   in order inside the frame: no mid-frame replays (in the threaded build each replay is its own
   main-thread task, and the browser could present a half-drawn frame between them). During level
   loads the arena is flushed every 32 MB to bound memory. */
static void record_tex_image(int sub, GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                             GLenum fmt, GLenum type, const void *data) {
  int len = data ? w * h * 4 : 0;   /* the engine uploads RGBA8 */
  int off = -1;
  if (data) { off = (int)arena_alloc(&_da, (size_t)len, 16); memcpy(_da.p + off, data, (size_t)len); }
  Word *c = cmd(OP_TEXIMAGE, 11);
  c[0].i = sub; c[1].i = (int)target; c[2].i = level; c[3].i = x; c[4].i = y; c[5].i = w; c[6].i = h;
  c[7].i = (int)fmt; c[8].i = (int)type; c[9].i = off; c[10].i = len;
  if (_da.n > (32u << 20)) SE1_GL1Shim_Flush();
}
static void shim_glTexImage2D(GLenum target, GLint level, GLint ifmt, GLsizei w, GLsizei h, GLint border,
                              GLenum fmt, GLenum type, const void *data) {
  shim_init();
  if (level == 0) { TexInfo *ti = tex_info(S.boundTex[S.activeUnit], 1); ti->ifmt = ifmt; ti->w = w; ti->h = h; }
  /* the engine always supplies RGBA8 pixels; GL1 internal formats (RGB5_A1, LUMINANCE8, ...) → RGBA8 */
  (void)border;
  record_tex_image(0, target, level, 0, 0, w, h, fmt, type, data);
}
static void shim_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                                 GLenum fmt, GLenum type, const void *data) {
  shim_init();
  record_tex_image(1, target, level, x, y, w, h, fmt, type, data);
}
static void shim_glGenTextures(GLsizei n, GLuint *t) { shim_init(); for (int i = 0; i < n; i++) t[i] = (GLuint)gfx_gen_texture(); }
static void shim_glTexParameteri(GLenum target, GLenum pname, GLint v) {
  if ((pname == GL_TEXTURE_WRAP_S || pname == GL_TEXTURE_WRAP_T) && v == GL1_CLAMP) v = GL_CLAMP_TO_EDGE;
  cmd_iii(OP_TEXPARAMI, (int)target, (int)pname, v);
}
static void shim_glTexParameterf(GLenum target, GLenum pname, GLfloat v) {
  if (pname == GL_TEXTURE_WRAP_S || pname == GL_TEXTURE_WRAP_T) { shim_glTexParameteri(target, pname, (GLint)v); return; }
  Word *w = cmd(OP_TEXPARAMF, 3); w[0].i = (int)target; w[1].i = (int)pname; w[2].f = v;
}
static void shim_glGetTexLevelParameteriv(GLenum target, GLint level, GLenum pname, GLint *out) {
  shim_init(); (void)target;
  TexInfo *ti = tex_info(S.boundTex[S.activeUnit], 0);
  int w = ti ? ti->w >> level : 0, h = ti ? ti->h >> level : 0;
  switch (pname) {
  case GL1_TEXTURE_WIDTH: *out = w; break;
  case GL1_TEXTURE_HEIGHT: *out = h; break;
  case GL1_TEXTURE_INTERNAL_FORMAT: *out = ti ? ti->ifmt : GL_RGBA8; break;
  case GL1_TEXTURE_COMPRESSED: *out = 0; break;
  case GL1_TEXTURE_COMPRESSED_IMAGE_SIZE: *out = w * h * 4; break;
  case GL1_TEXTURE_RED_SIZE: case GL1_TEXTURE_GREEN_SIZE: case GL1_TEXTURE_BLUE_SIZE: case GL1_TEXTURE_ALPHA_SIZE: *out = 8; break;
  default: *out = 0;
  }
}
static void shim_glDeleteTextures(GLsizei n, const GLuint *t) {
  for (int i = 0; i < n; i++) {
    TexInfo *ti = tex_info(t[i], 0); if (ti) *ti = _texInfo[--_ctTexInfo];
    for (int u = 0; u < MAXUNITS; u++) if (S.boundTex[u] == t[i]) S.boundTex[u] = 0; /* GL unbinds deleted textures */
    if (t[i]) cmd_i(OP_DELTEX, (int)t[i]);
  }
}

/* ---- current vertex attributes ---- */
static void shim_glColor4f(GLfloat r, GLfloat g, GLfloat b, GLfloat a) { shim_init(); S.curColor[0] = r; S.curColor[1] = g; S.curColor[2] = b; S.curColor[3] = a; }
static void shim_glColor3f(GLfloat r, GLfloat g, GLfloat b) { shim_glColor4f(r, g, b, 1.0f); }
static void shim_glColor4ub(GLubyte r, GLubyte g, GLubyte b, GLubyte a) { shim_glColor4f(r / 255.0f, g / 255.0f, b / 255.0f, a / 255.0f); }
static void shim_glColor4ubv(const GLubyte *v) { shim_glColor4ub(v[0], v[1], v[2], v[3]); }
static void shim_glTexCoord4f(GLfloat s, GLfloat t, GLfloat r, GLfloat q) {
  shim_init(); float *c = S.u[0].curTex; c[0] = s; c[1] = t; c[2] = r; c[3] = q;
}
static void shim_glTexCoord2f(GLfloat s, GLfloat t) { shim_glTexCoord4f(s, t, 0, 1); }

/* immediate-mode vertex layout: pos4, col4, tex4 x MAXUNITS */
#define IMM_FLOATS (4 + 4 + 4 * MAXUNITS)
static void imm_push(float x, float y, float z, float w) {
  if (!S.inBegin) return;
  if (S.immCount == S.immCap) { S.immCap = S.immCap ? S.immCap * 2 : 1024; S.imm = realloc(S.imm, S.immCap * IMM_FLOATS * sizeof(float)); }
  float *v = S.imm + S.immCount++ * IMM_FLOATS;
  v[0] = x; v[1] = y; v[2] = z; v[3] = w;
  memcpy(v + 4, S.curColor, 16);
  for (int i = 0; i < MAXUNITS; i++) memcpy(v + 8 + 4 * i, S.u[i].curTex, 16);
}
static void shim_glVertex4f(GLfloat x, GLfloat y, GLfloat z, GLfloat w) { imm_push(x, y, z, w); }
static void shim_glVertex3f(GLfloat x, GLfloat y, GLfloat z) { imm_push(x, y, z, 1); }
static void shim_glVertex2f(GLfloat x, GLfloat y) { imm_push(x, y, 0, 1); }

/* fetch one component group from a client array into floats (GL semantics for missing comps) */
static void fetch(const ClientArray *a, int i, float out[4], float defW) {
  out[0] = out[1] = out[2] = 0; out[3] = defW;
  int ts = a->type == GL_FLOAT ? 4 : a->type == GL_UNSIGNED_BYTE ? 1 : a->type == GL_SHORT ? 2 : 4;
  int stride = a->stride ? a->stride : a->size * ts;
  const uint8_t *p = (const uint8_t *)a->ptr + (size_t)i * stride;
  for (int c = 0; c < a->size && c < 4; c++) {
    if (a->type == GL_FLOAT) out[c] = ((const float *)p)[c];
    else if (a->type == GL_UNSIGNED_BYTE) out[c] = p[c] / 255.0f;
    else if (a->type == GL_SHORT) out[c] = ((const int16_t *)p)[c];
  }
}
static void shim_glArrayElement(GLint i) {
  shim_init();
  if (S.col.enabled) { float c[4]; fetch(&S.col, i, c, 1); memcpy(S.curColor, c, 16); }
  for (int u = 0; u < MAXUNITS; u++) if (S.u[u].tc.enabled) fetch(&S.u[u].tc, i, S.u[u].curTex, 1);
  if (S.vtx.enabled) { float v[4]; fetch(&S.vtx, i, v, 1); imm_push(v[0], v[1], v[2], v[3]); }
}

/* ---- client arrays ---- */
static ClientArray *client_array(GLenum cap) {
  switch (cap) {
  case GL1_VERTEX_ARRAY: return &S.vtx;
  case GL1_COLOR_ARRAY: return &S.col;
  case GL1_NORMAL_ARRAY: return &S.nor;
  case GL1_TEXTURE_COORD_ARRAY: return &S.u[S.clientUnit].tc;
  }
  return NULL;
}
static void shim_glEnableClientState(GLenum cap) { shim_init(); ClientArray *a = client_array(cap); if (a) a->enabled = 1; }
static void shim_glDisableClientState(GLenum cap) { shim_init(); ClientArray *a = client_array(cap); if (a) a->enabled = 0; }
static void set_array(ClientArray *a, GLint size, GLenum type, GLsizei stride, const void *ptr) { a->size = size; a->type = type; a->stride = stride; a->ptr = ptr; }
static void shim_glVertexPointer(GLint size, GLenum type, GLsizei stride, const void *p) { shim_init(); set_array(&S.vtx, size, type, stride, p); }
static void shim_glColorPointer(GLint size, GLenum type, GLsizei stride, const void *p) { shim_init(); set_array(&S.col, size, type, stride, p); }
static void shim_glNormalPointer(GLenum type, GLsizei stride, const void *p) { shim_init(); set_array(&S.nor, 3, type, stride, p); }
static void shim_glTexCoordPointer(GLint size, GLenum type, GLsizei stride, const void *p) { shim_init(); set_array(&S.u[S.clientUnit].tc, size, type, stride, p); }
static void shim_glLockArraysEXT(GLint first, GLsizei count) { shim_init(); S.lockedCount = first + count; }
static void shim_glUnlockArraysEXT(void) { shim_init(); S.lockedCount = 0; }

static int type_size(GLenum t) { return t == GL_FLOAT ? 4 : t == GL_UNSIGNED_BYTE ? 1 : t == GL_SHORT ? 2 : 4; }

/* Copy every enabled client array covering vertices [0, ctVerts) into the vertex arena and
   point the attributes at it. */
/* the replayer's quad index buffer only grows (doubling from 1024 quads): mirror its capacity
   here, so the (synchronous, in the threaded build) call happens only when it must grow */
static void ensure_quad_capacity(int ctQuads) {
  static int quadCap;
  if (ctQuads <= quadCap) return;
  int cap = 1024; while (cap < ctQuads) cap *= 2;
  gfx_quad_capacity(cap);
  quadCap = cap;
}

typedef struct { const uint8_t *ptr; int size; GLenum type; int norm; int stride; } VSrc;   /* stride: source */
/* copy ctVerts vertices of every enabled attribute into its stream at the vertex cursor, record
   attribute pointers only where needed; returns the base vertex to add to this draw's indices */
static uint32_t put_vertices(const VSrc *src, int ctVerts) {
  int elem[NSTREAMS], dst[NSTREAMS];
  for (int l = 0; l < NSTREAMS; l++) {
    if (!src[l].ptr) continue;
    elem[l] = src[l].size * type_size(src[l].type);
    int st = src[l].stride ? src[l].stride : elem[l];
    dst[l] = st > 2 * elem[l] ? elem[l] : st;       /* widely interleaved (immediate mode): compact */
    if (dst[l] & 3) dst[l] = (elem[l] + 3) & ~3;    /* keep offsets 4-aligned (WebGPU) */
  }
  for (int pass = 0; pass < 2; pass++) {             /* pass 1: after restarting the vertex cursor */
    int restart = 0;
    for (int l = 0; l < NSTREAMS && !restart; l++) {
      if (!src[l].ptr) continue;
      PtrCache *c = &_ap[l];
      int same = c->valid && c->size == src[l].size && c->type == (int)src[l].type && c->norm == src[l].norm && c->stride == dst[l];
      if (same) continue;
      size_t at = (size_t)_v0 * (size_t)dst[l], end = (_vs[l].n + 15) & ~(size_t)15;
      if (at < end) continue;                        /* new pointer just below the stream's end: no gap */
      if (at - end > (256u << 10)) restart = 1;      /* would leave a big hole: restart the cursor */
    }
    if (_v0 > (1u << 20)) restart = 1;
    if (!restart || pass) break;
    _v0 = 0;
    for (int l = 0; l < NSTREAMS; l++) _ap[l].valid = 0;
  }
  uint32_t v0 = _v0;
  for (int l = 0; l < NSTREAMS; l++) {
    if (!src[l].ptr) {
      if (l == 0) { static const float zero[4] = { 0, 0, 0, 1 }; attrib_const(0, zero); }
      else if (l == 1) attrib_const(1, S.curColor);
      else attrib_const(l, S.u[l - 2].curTex);
      continue;
    }
    PtrCache *c = &_ap[l];
    int st = dst[l];
    if (!(c->valid && c->size == src[l].size && c->type == (int)src[l].type && c->norm == src[l].norm && c->stride == st)) {
      size_t at = (size_t)v0 * (size_t)st, end = (_vs[l].n + 15) & ~(size_t)15;
      c->base = end > at ? ((end - at + 15) & ~(size_t)15) : 0;    /* base + v0 * stride >= end */
      c->valid = 1; c->size = src[l].size; c->type = (int)src[l].type; c->norm = src[l].norm; c->stride = st;
      attrib_pointer(l, src[l].size, src[l].type, src[l].norm, st, c->base);
    } else {
      attrib_enable(l, 1);
    }
    size_t off = c->base + (size_t)v0 * (size_t)st;
    int sst = src[l].stride ? src[l].stride : elem[l];
    if (sst == st) {                                 /* same layout: one block copy */
      size_t len = (size_t)(ctVerts - 1) * st + elem[l];
      memcpy(arena_at(&_vs[l], off, len), src[l].ptr, len);
    } else {                                         /* gather into the compact layout */
      uint8_t *d = arena_at(&_vs[l], off, (size_t)ctVerts * st);
      for (int k = 0; k < ctVerts; k++) memcpy(d + (size_t)k * st, src[l].ptr + (size_t)k * sst, elem[l]);
    }
  }
  _v0 = (v0 + (uint32_t)ctVerts + 3) & ~3u;        /* quads need a base vertex that's a multiple of 4 */
  return v0;
}

static uint32_t bind_client_arrays(int ctVerts) {
  VSrc src[NSTREAMS] = { { 0 } };
  if (S.vtx.enabled) src[0] = (VSrc){ S.vtx.ptr, S.vtx.size, S.vtx.type, 0, S.vtx.stride };
  if (S.col.enabled) src[1] = (VSrc){ S.col.ptr, S.col.size, S.col.type, S.col.type == GL_UNSIGNED_BYTE, S.col.stride };
  for (int i = 0; i < MAXUNITS; i++)
    if (S.u[i].enabled && S.u[i].tc.enabled) src[2 + i] = (VSrc){ S.u[i].tc.ptr, S.u[i].tc.size, S.u[i].tc.type, 0, S.u[i].tc.stride };
  return put_vertices(src, ctVerts);
}

static void shim_glDrawArrays(GLenum mode, GLint first, GLsizei count) {
  shim_init();
  if (count <= 0) return;
  apply_program();
  uint32_t v0 = bind_client_arrays(first + count);
  if (mode == GL1_QUADS) {
    ensure_quad_capacity((int)((v0 + first + count) / 4));
    cmd_ii(OP_DRAW_QUADS, count / 4 * 6, (int)((v0 + first) / 4 * 6 * 4));
  } else {
    cmd_iii(OP_DRAW_ARRAYS, (int)(mode == GL1_POLYGON ? GL_TRIANGLE_FAN : mode), (int)(first + v0), count);
  }
}

static void shim_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
  shim_init();
  if (count <= 0) return;
  int maxIdx = 0;
  if (S.lockedCount > 0) maxIdx = S.lockedCount - 1;
  else if (type == GL_UNSIGNED_INT) { const uint32_t *ix = indices; for (int i = 0; i < count; i++) if ((int)ix[i] > maxIdx) maxIdx = ix[i]; }
  else if (type == GL_UNSIGNED_SHORT) { const uint16_t *ix = indices; for (int i = 0; i < count; i++) if (ix[i] > maxIdx) maxIdx = ix[i]; }
  else { const uint8_t *ix = indices; for (int i = 0; i < count; i++) if (ix[i] > maxIdx) maxIdx = ix[i]; }
  apply_program();
  uint32_t v0 = bind_client_arrays(maxIdx + 1);
  /* indices are rebased onto the vertex cursor, always as 32-bit */
  size_t ioff = arena_alloc(&_ia, (size_t)count * 4, 4);
  uint32_t *o = (uint32_t *)(_ia.p + ioff);
  if (type == GL_UNSIGNED_INT) { const uint32_t *ix = indices; for (int i = 0; i < count; i++) o[i] = ix[i] + v0; }
  else if (type == GL_UNSIGNED_SHORT) { const uint16_t *ix = indices; for (int i = 0; i < count; i++) o[i] = ix[i] + v0; }
  else { const uint8_t *ix = indices; for (int i = 0; i < count; i++) o[i] = ix[i] + v0; }
  cmd_iiii(OP_DRAW_ELEMENTS, (int)mode, count, GL_UNSIGNED_INT, (int)ioff);
}

/* ---- immediate mode ---- */
static void shim_glBegin(GLenum mode) { shim_init(); S.inBegin = 1; S.beginMode = mode; S.immCount = 0; }
static void shim_glEnd(void) {
  shim_init();
  S.inBegin = 0;
  int n = S.immCount;
  if (n == 0) return;
  apply_program();
  VSrc src[NSTREAMS];
  for (int l = 0; l < NSTREAMS; l++) src[l] = (VSrc){ (const uint8_t *)(S.imm + 4 * l), 4, GL_FLOAT, 0, IMM_FLOATS * 4 };
  uint32_t v0 = put_vertices(src, n);
  switch (S.beginMode) {
  case GL1_QUADS: ensure_quad_capacity((int)((v0 + n) / 4)); cmd_ii(OP_DRAW_QUADS, n / 4 * 6, (int)(v0 / 4 * 6 * 4)); break;
  case GL1_QUAD_STRIP: cmd_iii(OP_DRAW_ARRAYS, GL_TRIANGLE_STRIP, (int)v0, n); break;
  case GL1_POLYGON: cmd_iii(OP_DRAW_ARRAYS, GL_TRIANGLE_FAN, (int)v0, n); break;
  default: cmd_iii(OP_DRAW_ARRAYS, (int)S.beginMode, (int)v0, n); break;
  }
}

/* ---- read-back / sync ---- */
/* The browser presents frames itself: an explicit GPU sync only stalls the main thread. */
static void shim_glFinish(void) {}
static void shim_glFlush(void) {}
static void shim_glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum fmt, GLenum type, void *px) {
  shim_init();
  if (fmt == GL_DEPTH_COMPONENT) {
    /* WebGL2 can't read the depth buffer. Used for lens-flare/corona visibility (DepthCheck.cpp):
       report "far" so they stay visible. TODO: occlusion queries. */
    if (type == GL_FLOAT) { float *f = px; for (int i = 0; i < w * h; i++) f[i] = 1.0f; }
    return;
  }
  if (fmt == GL_RGB && type == GL_UNSIGNED_BYTE) {
    /* WebGL2 only guarantees RGBA/UNSIGNED_BYTE: read that, repack to RGB (screenshots) */
    uint8_t *tmp = malloc((size_t)w * h * 4), *o = px;
    SE1_GL1Shim_Flush();
    gfx_read_pixels(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, tmp, w * h * 4);
    for (int i = 0; i < w * h; i++) { o[i * 3] = tmp[i * 4]; o[i * 3 + 1] = tmp[i * 4 + 1]; o[i * 3 + 2] = tmp[i * 4 + 2]; }
    free(tmp);
    return;
  }
  SE1_GL1Shim_Flush();
  gfx_read_pixels(x, y, w, h, (int)fmt, (int)type, px, w * h * 4);   /* RGBA/UNSIGNED_BYTE */
}

/* ---- misc GL1 calls ---- */
static void shim_glClearDepth(GLdouble d) { shim_init(); cmd(OP_CLEARDEPTH, 1)[0].f = (float)d; }
static void shim_glDepthRange(GLdouble n, GLdouble f) { shim_init(); cmd_ff(OP_DEPTHRANGE, (float)n, (float)f); }
static void shim_glShadeModel(GLenum m) { (void)m; }
static void shim_glDrawBuffer(GLenum m) { (void)m; }
static void shim_glPolygonMode(GLenum f, GLenum m) { (void)f; (void)m; } /* wireframe: unsupported */
static void shim_glPointSize(GLfloat s) { (void)s; }
static void shim_glHint(GLenum t, GLenum m) { (void)t; (void)m; } /* mipmaps are uploaded by the engine */
static void shim_nop(void) {}

static char _strExtensions[512];
static const GLubyte *shim_glGetString(GLenum name) {
  if (name == GL_EXTENSIONS) {
    if (!_strExtensions[0]) {
      strcpy(_strExtensions, "GL_ARB_multitexture GL_EXT_texture_env_combine GL_ARB_texture_env_combine "
                             "GL_EXT_compiled_vertex_array GL_EXT_texture_edge_clamp");
#ifdef SE1_THREADS
      if (MAIN_THREAD_EM_ASM_INT({ return Module['se1gfx'].hasAnisotropy() ? 1 : 0; }))
        strcat(_strExtensions, " GL_EXT_texture_filter_anisotropic");
#else
      const char *real = (const char *)glGetString(GL_EXTENSIONS);
      if (real && strstr(real, "texture_filter_anisotropic")) strcat(_strExtensions, " GL_EXT_texture_filter_anisotropic");
#endif
    }
    return (const GLubyte *)_strExtensions;
  }
  if (name == GL_VERSION) return (const GLubyte *)"1.3 (SE1 gl1shim on WebGL2)";
#ifdef SE1_THREADS
  /* the engine worker has no GL context: same strings Chrome's WebGL reports (same GLSettings preset) */
  if (name == GL_VENDOR) return (const GLubyte *)"WebKit";
  if (name == GL_RENDERER) return (const GLubyte *)"WebKit WebGL";
  return (const GLubyte *)"";
#else
  return glGetString(name);
#endif
}
static void shim_glGetIntegerv(GLenum p, GLint *out) {
  if (p == GL1_MAX_TEXTURE_UNITS) { *out = MAXUNITS; return; }
  shim_init();
  gfx_get_param((int)p, out, 0);   /* engine queries constants (limits): no flush needed */
}

/* ---- core GL calls the engine makes directly: recorded too, so they stay in order ---- */
static void shim_glGetFloatv(GLenum p, GLfloat *out) { shim_init(); gfx_get_param((int)p, out, 1); }
static GLenum shim_glGetError(void) { return GL_NO_ERROR; }  /* WebGL reports errors in the console */
static void shim_glPixelStorei(GLenum p, GLint v) { shim_init(); cmd_ii(OP_PIXELSTORE, (int)p, v); }
static void shim_glBlendFunc(GLenum s, GLenum d) { shim_init(); cmd_ii(OP_BLENDFUNC, (int)s, (int)d); }
static void shim_glDepthFunc(GLenum f) { shim_init(); cmd_i(OP_DEPTHFUNC, (int)f); }
static void shim_glDepthMask(GLboolean f) { shim_init(); cmd_i(OP_DEPTHMASK, f ? 1 : 0); }
static void shim_glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a) { shim_init(); cmd_iiii(OP_COLORMASK, !!r, !!g, !!b, !!a); }
static void shim_glCullFace(GLenum m) { shim_init(); cmd_i(OP_CULLFACE, (int)m); }
static void shim_glFrontFace(GLenum m) { shim_init(); cmd_i(OP_FRONTFACE, (int)m); }
static void shim_glPolygonOffset(GLfloat f, GLfloat u) { shim_init(); cmd_ff(OP_POLYOFFSET, f, u); }
static void shim_glViewport(GLint x, GLint y, GLsizei w, GLsizei h) { shim_init(); cmd_iiii(OP_VIEWPORT, x, y, w, h); }
static void shim_glScissor(GLint x, GLint y, GLsizei w, GLsizei h) { shim_init(); cmd_iiii(OP_SCISSOR, x, y, w, h); }
static void shim_glClearColor(GLclampf r, GLclampf g, GLclampf b, GLclampf a) { shim_init(); cmd_ffff(OP_CLEARCOLOR, r, g, b, a); }
static void shim_glClearStencil(GLint s) { shim_init(); cmd_i(OP_CLEARSTENCIL, s); }
static void shim_glClear(GLbitfield m) { shim_init(); cmd_i(OP_CLEAR, (int)m); }

/* ---- proc address table ---- */
typedef struct { const char *name; void *fn; } Entry;
static const Entry _entries[] = {
#define E(n) { #n, (void *)shim_##n }
  E(glMatrixMode), E(glLoadIdentity), E(glLoadMatrixf), E(glMultMatrixf), E(glTranslatef), E(glScalef),
  E(glOrtho), E(glFrustum), E(glEnable), E(glDisable), E(glIsEnabled), E(glAlphaFunc), E(glClipPlane),
  E(glTexEnvi), E(glTexEnvf), E(glTexEnvfv), E(glGetTexEnviv), E(glBindTexture), E(glTexImage2D),
  E(glTexParameteri), E(glTexParameterf), E(glGetTexLevelParameteriv), E(glDeleteTextures),
  E(glColor4f), E(glColor3f), E(glColor4ub), E(glColor4ubv), E(glTexCoord2f), E(glTexCoord4f),
  E(glVertex2f), E(glVertex3f), E(glVertex4f), E(glArrayElement), E(glBegin), E(glEnd),
  E(glEnableClientState), E(glDisableClientState), E(glVertexPointer), E(glColorPointer),
  E(glNormalPointer), E(glTexCoordPointer), E(glLockArraysEXT), E(glUnlockArraysEXT),
  E(glDrawArrays), E(glDrawElements), E(glClearDepth), E(glDepthRange), E(glShadeModel),
  E(glDrawBuffer), E(glPolygonMode), E(glPointSize), E(glHint), E(glGetString), E(glGetIntegerv),
  E(glFinish), E(glFlush), E(glReadPixels),
  E(glTexSubImage2D), E(glGenTextures), E(glGetFloatv), E(glGetError), E(glPixelStorei),
  E(glBlendFunc), E(glDepthFunc), E(glDepthMask), E(glColorMask), E(glCullFace), E(glFrontFace),
  E(glPolygonOffset), E(glViewport), E(glScissor), E(glClearColor), E(glClearStencil), E(glClear),
#undef E
  { "glActiveTextureARB", (void *)shim_glActiveTexture },
  { "glActiveTexture", (void *)shim_glActiveTexture },
  { "glClientActiveTextureARB", (void *)shim_glClientActiveTexture },
  { "glClientActiveTexture", (void *)shim_glClientActiveTexture },
};

void *SE1_GL1Shim_GetProcAddress(const char *name) {
  for (unsigned i = 0; i < sizeof _entries / sizeof _entries[0]; i++)
    if (strcmp(_entries[i].name, name) == 0) return _entries[i].fn;
  void *p = SDL_GL_GetProcAddress(name);
  /* Never hand the engine NULL for a GL1 entry it might call unconditionally (e.g. NV/ATI/3DFX
   * extension functions are guarded by extension checks, but some GL1 calls are not). */
  if (p == NULL && strncmp(name, "wgl", 3) != 0) {
    static int warned = 0;
    if (warned++ < 64) fprintf(stderr, "gl1shim: no implementation for %s (using no-op)\n", name);
    return (void *)shim_nop;
  }
  return p;
}
