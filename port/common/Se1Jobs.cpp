/* Se1Jobs: fork-join job pool for the engine thread (see Se1Jobs.h, notes/perf/threads.md). */
#include "Se1Jobs.h"
#include <stdint.h>
#include <limits.h>

static thread_local int _iJobThread = -1;   // >=0 while this thread runs a job
extern "C" int SE1Jobs_InJob(void) { return _iJobThread>=0; }

#ifndef SE1_THREADS
extern "C" int SE1Jobs_Threads(void) { return 1; }
extern "C" void SE1Jobs_ParallelFor(int ct, int iGrain, SE1JobFn fn, void *pvCtx)
{
  if (ct<=0) return;
  _iJobThread = 0; fn(pvCtx, 0, ct, 0); _iJobThread = -1;
}
#else
#include <pthread.h>
#include <math.h>
#include <emscripten.h>
#include <emscripten/threading.h>

#define SE1JOBS_MAX 16

/* One parallel section at a time. Its parameters sit in one of two slots (by generation parity),
   so a helper that wakes late for an old section can't read half-written parameters of the next.
   _ullNext packs the generation (high 32 bits) and the next unclaimed index (low 32 bits): a helper
   claims a chunk with a compare-exchange, which fails once the section moved on, and reads the
   slot only after a successful claim. */
struct Section {
  SE1JobFn fn;
  void *pv;
  int ct, iGrain;
  int ctDone;          // indices finished (atomic)
};
static Section _asec[2];
static uint64_t _ullNext;       // (generation<<32) | next index (atomic)
static int32_t _iWakeGen;       // futex word: low 32 bits of the generation (atomic)
static uint32_t _ulGen;         // engine thread only
static int _ctThreads = 0;      // 0 = not started yet

static int RunChunks(int iThread)
{
  int ctRan = 0;
  for (;;) {
    uint64_t v = __atomic_load_n(&_ullNext, __ATOMIC_ACQUIRE);
    uint32_t g = (uint32_t)(v>>32), i = (uint32_t)v;
    Section &sec = _asec[g&1];
    if ((int)i>=sec.ct) return ctRan;   // (stale reads only make this return early; CAS checks)
    uint64_t vNew = v+(uint64_t)sec.iGrain;
    if (!__atomic_compare_exchange_n(&_ullNext, &v, vNew, false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) {
      continue;
    }
    // claimed [i, i+grain) of generation g: the slot's parameters were written before g was published
    int iEnd = (int)i+sec.iGrain;
    if (iEnd>sec.ct) iEnd = sec.ct;
    _iJobThread = iThread;
    sec.fn(sec.pv, (int)i, iEnd, iThread);
    _iJobThread = -1;
    __atomic_fetch_add(&sec.ctDone, iEnd-(int)i, __ATOMIC_RELEASE);
    ctRan++;
  }
}

static void *Helper(void *pv)
{
  const int iThread = (int)(intptr_t)pv;
  int32_t iSeen = __atomic_load_n(&_iWakeGen, __ATOMIC_ACQUIRE);
  for (;;) {
    // wait for the next section: spin a while first (sections come in bursts, a futex wake takes
    // tens of microseconds), then sleep
    int32_t g;
    for (int k = 0; (g = __atomic_load_n(&_iWakeGen, __ATOMIC_ACQUIRE))==iSeen; k++) {
      if (k<20000) continue;
      emscripten_futex_wait(&_iWakeGen, (uint32_t)iSeen, INFINITY);
      k = 0;
    }
    iSeen = g;
    RunChunks(iThread);
  }
  return NULL;
}

static void Start(void)
{
  int ct = MAIN_THREAD_EM_ASM_INT({ return Module['se1Mt'] ? Module['se1Mt'] : 1; });
  if (ct<1) ct = 1;
  if (ct>SE1JOBS_MAX) ct = SE1JOBS_MAX;
  _ctThreads = 1;
  for (int i = 1; i<ct; i++) {
    pthread_t th;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 1<<20);
    if (pthread_create(&th, &attr, Helper, (void *)(intptr_t)i)!=0) break;
    pthread_detach(th);
    _ctThreads++;
  }
  EM_ASM({ console.log('se1jobs: ' + $0 + ' thread(s)'); }, _ctThreads);
}

extern "C" int SE1Jobs_Threads(void)
{
  if (_ctThreads==0) Start();
  return _ctThreads;
}

extern "C" void SE1Jobs_ParallelFor(int ct, int iGrain, SE1JobFn fn, void *pvCtx)
{
  if (ct<=0) return;
  if (iGrain<1) iGrain = 1;
  if (SE1Jobs_Threads()<=1 || ct<=iGrain || _iJobThread>=0) {
    // serial (also a nested call from inside a job)
    const int iOld = _iJobThread;
    _iJobThread = iOld>=0 ? iOld : 0;
    fn(pvCtx, 0, ct, _iJobThread);
    _iJobThread = iOld;
    return;
  }
  const uint32_t g = ++_ulGen;
  Section &sec = _asec[g&1];
  sec.fn = fn; sec.pv = pvCtx; sec.ct = ct; sec.iGrain = iGrain;
  __atomic_store_n(&sec.ctDone, 0, __ATOMIC_RELAXED);
  // publish: parameters first, then the generation with index 0
  __atomic_store_n(&_ullNext, (uint64_t)g<<32, __ATOMIC_RELEASE);
  __atomic_store_n(&_iWakeGen, (int32_t)g, __ATOMIC_RELEASE);
  emscripten_futex_wake(&_iWakeGen, INT_MAX);
  RunChunks(0);
  // the rest is running on helpers: wait for it
  while (__atomic_load_n(&sec.ctDone, __ATOMIC_ACQUIRE)<ct) {}
}
#endif
