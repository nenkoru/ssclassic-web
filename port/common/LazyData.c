/* Lazy game data (notes/lazy-data.md).
 *
 * The big data files (the .gro archives, levels, demos) are not in the preload bundle: the
 * bundle has an empty placeholder for each (so directory listings, stat and the case lookup
 * still see them) and SE1Lazy/manifest.txt lists them. __wrap_fopen (CaseFs.c) asks
 * se1_lazy_fopen first; for a listed file opened read-only it returns a fopencookie FILE whose
 * reads come from 256 KiB chunks:
 *   - chunks already read live in a small LRU cache in the heap (CACHE_SLOTS MiB);
 *   - missing chunks are fetched by the page (port/web/lazydata.js: OPFS cache, then HTTP Range)
 *     and the read waits: the threaded build posts the request to the main thread and waits on a
 *     futex (as gl1shim.c does), the single-threaded build awaits it through JSPI (or, inside a
 *     script function where JSPI can't suspend, reads with a synchronous XHR).
 * A user-data build (no game data of its own, the player imports theirs: port/web/userdata.js)
 * adds SE1Lazy/user.txt, written by the page before main(); its files are read the same way,
 * and the page serves them from the player's copy in OPFS.
 * The engine reads data only through fopen/fread/fseek/ftell (Stream.cpp, Unzip.cpp); its
 * _open + fstat calls (time stamps) see the placeholder, which is fine.
 */
#define _GNU_SOURCE
#include <emscripten.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#ifdef SE1_THREADS
#include <emscripten/atomic.h>
#include <emscripten/threading.h>
#endif

#define CHUNK (1u << 18)   /* 256 KiB: see "Measurements" in notes/lazy-data.md */
#define CACHE_SLOTS 256  /* heap cache: 256 x 256 KiB = 64 MiB */
#define MAX_RUN 16       /* chunks per request (4 MiB) */
#define READAHEAD 3      /* extra chunks for sequential reads */

FILE *__real_fopen(const char *path, const char *mode);

typedef struct { char *path; char key[17]; uint32_t size; const char *ds; } LzFile;
typedef struct { int file; uint32_t idx, len; uint64_t used; uint8_t *data; } Slot;
typedef struct { int file; uint32_t pos, lastEnd; } Handle;

static LzFile *_files;
static int _nfiles;
static char _dataset[17];      /* the build's lazy files (gamedata/) */
static char _userDataset[17];  /* the player's own files (port/web/userdata.js), if any */
static pthread_once_t _once = PTHREAD_ONCE_INIT;
static pthread_mutex_t _mx = PTHREAD_MUTEX_INITIALIZER;
static Slot _slots[CACHE_SLOTS];
static uint64_t _tick;

/* a manifest: "dataset <16 chars>", then "<key> <size> <path>" per file */
static void load_one(const char *mpath, char *ds)
{
  FILE *f = __real_fopen(mpath, "rb");
  if (!f) return;
  char line[1200];
  static int cap;
  int before = _nfiles;
  while (fgets(line, sizeof(line), f)) {
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    if (!strncmp(line, "dataset ", 8)) { strncpy(ds, line + 8, 16); ds[16] = 0; continue; }
    char *sp1 = strchr(line, ' '), *sp2 = sp1 ? strchr(sp1 + 1, ' ') : NULL;
    if (!sp1 || !sp2 || sp1 - line != 16) continue;
    if (_nfiles == cap) { cap = cap ? cap * 2 : 64; _files = (LzFile *)realloc(_files, cap * sizeof(LzFile)); }
    LzFile *z = &_files[_nfiles++];
    memcpy(z->key, line, 16); z->key[16] = 0;
    z->size = (uint32_t)strtoul(sp1 + 1, NULL, 10);
    z->path = strdup(sp2 + 1);
    z->ds = ds;
  }
  fclose(f);
  printf("lazy data: %d files on demand from %s (dataset %s)\n", _nfiles - before, mpath, ds);
}

static void load_manifest(void)
{
  load_one("/SE1Lazy/manifest.txt", _dataset);   /* missing in a SE1_LAZY_DATA=OFF build */
  load_one("/SE1Lazy/user.txt", _userDataset);   /* written by the page in a user-data build */
}

/* "/Levels//X.wld", "./Levels/X.wld" -> "Levels/X.wld" */
static void norm(const char *in, char *out, size_t cap)
{
  size_t n = 0;
  while (*in) {
    if (*in == '/') { in++; continue; }
    if (in[0] == '.' && (in[1] == '/' || !in[1])) { in++; continue; }
    if (n && n + 1 < cap) out[n++] = '/';
    while (*in && *in != '/' && n + 1 < cap) out[n++] = *in++;
  }
  out[n] = 0;
}

static int find_file(const char *path)
{
  char p[1024];
  norm(path, p, sizeof(p));
  for (int i = _nfiles - 1; i >= 0; i--)   /* the last listed wins: the player's files over the build's */
    if (!strcasecmp(_files[i].path, p)) return i;
  return -1;
}

/* ---------------------------------------------------------------- fetching through the page */
#ifdef SE1_THREADS
static int fetch_chunks(int fi, uint32_t first, uint32_t count, uint8_t *dst, uint32_t len)
{
  if (emscripten_is_main_browser_thread()) {   /* the page can't serve us while we block it */
    printf("lazy data: %s read on the main thread, not supported\n", _files[fi].path);
    return -1;
  }
  int32_t state = 0;   /* 0 pending, 1 done, -1 failed: set by the page */
  MAIN_THREAD_ASYNC_EM_ASM({ Module['se1Lazy'].fetchForThread($0, $1, $2, $3, $4, $5, $6, $7, $8); },
                           &state, _files[fi].ds, _files[fi].key, _files[fi].path, first, count, CHUNK, dst, len);
  int32_t v;
  while ((v = (int32_t)emscripten_atomic_load_u32((void *)&state)) == 0)
    emscripten_futex_wait((void *)&state, 0, 1000.0);
  return v == 1 ? 0 : -1;
}
#else
EM_ASYNC_JS(int, se1_lazy_fetch_js, (const char *ds, const char *key, const char *path, uint32_t first,
                                     uint32_t count, uint32_t chunk, uint8_t *dst, uint32_t len), {
  return await Module['se1Lazy'].fetch(UTF8ToString(ds), UTF8ToString(key), UTF8ToString(path),
                                       first, count, chunk, dst, len);
});
/* inside a script function (ShellCall.cpp) a JS frame is on the stack and JSPI can't suspend:
   the page reads synchronously then (sync XHR, no OPFS read) */
EM_JS(int, se1_lazy_fetch_sync_js, (const char *ds, const char *key, const char *path, uint32_t first,
                                    uint32_t count, uint32_t chunk, uint8_t *dst, uint32_t len), {
  return Module['se1Lazy'].fetchSync(UTF8ToString(ds), UTF8ToString(key), UTF8ToString(path),
                                     first, count, chunk, dst, len);
});
extern int _iSE1ShellDepth __attribute__((weak));
static int fetch_chunks(int fi, uint32_t first, uint32_t count, uint8_t *dst, uint32_t len)
{
  int r = (&_iSE1ShellDepth && _iSE1ShellDepth > 0)
    ? se1_lazy_fetch_sync_js(_files[fi].ds, _files[fi].key, _files[fi].path, first, count, CHUNK, dst, len)
    : se1_lazy_fetch_js(_files[fi].ds, _files[fi].key, _files[fi].path, first, count, CHUNK, dst, len);
  return r == 1 ? 0 : -1;
}
#endif

/* ---------------------------------------------------------------- heap cache (call with _mx held) */
static Slot *find_slot(int fi, uint32_t idx)
{
  for (int i = 0; i < CACHE_SLOTS; i++)
    if (_slots[i].data && _slots[i].file == fi && _slots[i].idx == idx) return &_slots[i];
  return NULL;
}

static void put_slot(int fi, uint32_t idx, const uint8_t *src, uint32_t len)
{
  if (find_slot(fi, idx)) return;   /* another thread fetched it meanwhile */
  Slot *s = NULL;
  for (int i = 0; i < CACHE_SLOTS && !s; i++) if (!_slots[i].data) s = &_slots[i];
  if (!s) {
    s = &_slots[0];
    for (int i = 1; i < CACHE_SLOTS; i++) if (_slots[i].used < s->used) s = &_slots[i];
  } else {
    s->data = (uint8_t *)malloc(CHUNK);
    if (!s->data) return;
  }
  s->file = fi; s->idx = idx; s->len = len; s->used = ++_tick;
  memcpy(s->data, src, len);
}

static uint32_t chunk_len(int fi, uint32_t idx)
{
  uint32_t start = idx * CHUNK, size = _files[fi].size;
  return size - start < CHUNK ? size - start : CHUNK;
}

/* fetch chunk `need` (missing) plus the missing chunks after it up to `last`, and read-ahead */
static int fetch_run(Handle *h, uint32_t need, uint32_t last)
{
  int fi = h->file;
  uint32_t nchunks = (_files[fi].size + CHUNK - 1) / CHUNK;
  uint32_t end = need + 1;   /* exclusive */
  int seq = h->pos == h->lastEnd && h->pos != 0;
  uint32_t want = seq ? last + 1 + READAHEAD : last + 1;
  pthread_mutex_lock(&_mx);
  while (end < want && end < nchunks && end - need < MAX_RUN && !find_slot(fi, end)) end++;
  pthread_mutex_unlock(&_mx);
  uint32_t len = 0;
  for (uint32_t i = need; i < end; i++) len += chunk_len(fi, i);
  uint8_t *buf = (uint8_t *)malloc(len);
  if (!buf) return -1;
  if (fetch_chunks(fi, need, end - need, buf, len) != 0) { free(buf); return -1; }
  pthread_mutex_lock(&_mx);
  /* insert the needed chunk last so it is the most recently used */
  uint32_t off = chunk_len(fi, need);
  for (uint32_t i = need + 1; i < end; i++) { put_slot(fi, i, buf + off, chunk_len(fi, i)); off += chunk_len(fi, i); }
  put_slot(fi, need, buf, chunk_len(fi, need));
  pthread_mutex_unlock(&_mx);
  free(buf);
  return 0;
}

/* ---------------------------------------------------------------- the FILE */
static ssize_t lz_read(void *c, char *buf, size_t n)
{
  Handle *h = (Handle *)c;
  uint32_t size = _files[h->file].size;
  if (h->pos >= size) return 0;
  if (n > size - h->pos) n = size - h->pos;
  uint32_t last = (uint32_t)((h->pos + n - 1) / CHUNK);
  size_t done = 0;
  int tries = 0;
  while (done < n) {
    uint32_t p = h->pos + (uint32_t)done, idx = p / CHUNK, off = p % CHUNK;
    pthread_mutex_lock(&_mx);
    Slot *s = find_slot(h->file, idx);
    if (s) {
      size_t k = s->len - off;
      if (k > n - done) k = n - done;
      memcpy(buf + done, s->data + off, k);
      s->used = ++_tick;
      done += k;
      pthread_mutex_unlock(&_mx);
      continue;
    }
    pthread_mutex_unlock(&_mx);
    if (++tries > 64 || fetch_run(h, idx, last) != 0) {   /* the page already retried */
      printf("lazy data: cannot read %s at %u\n", _files[h->file].path, p);
      if (done) break;
      errno = EIO;
      return -1;
    }
  }
  h->pos += (uint32_t)done;
  h->lastEnd = h->pos;
  return (ssize_t)done;
}

static int lz_seek(void *c, off_t *off, int whence)
{
  Handle *h = (Handle *)c;
  int64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? h->pos : (int64_t)_files[h->file].size;
  int64_t p = base + *off;
  if (p < 0 || p > 0xffffffffLL) { errno = EINVAL; return -1; }
  h->pos = (uint32_t)p;
  *off = p;
  return 0;
}

static int lz_close(void *c) { free(c); return 0; }

FILE *se1_lazy_fopen(const char *path, const char *mode)
{
  pthread_once(&_once, load_manifest);
  if (!_nfiles || !path || !mode || mode[0] != 'r' || strchr(mode, '+')) return NULL;
  int fi = find_file(path);
  if (fi < 0) return NULL;
  Handle *h = (Handle *)calloc(1, sizeof(Handle));
  if (!h) return NULL;
  h->file = fi;
  cookie_io_functions_t io = { lz_read, NULL, lz_seek, lz_close };
  FILE *f = fopencookie(h, mode, io);
  if (!f) free(h);
  return f;
}
