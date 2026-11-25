/* Se1Jobs: a small fork-join job pool for the engine thread (scale track L, notes/perf/threads.md).
 *
 * The engine runs on one pthread (PROXY_TO_PTHREAD). SE1Jobs_ParallelFor() splits an index range
 * over that thread and a few helper pthreads and returns when every index is done, so the caller
 * stays the only thread that runs engine code outside a parallel section. Jobs must only read
 * shared engine state and write their own output slot: results are then applied by the caller in
 * index order, which keeps the simulation deterministic whatever the thread count.
 *
 * Off by default; the page's ?mt=N (Module.se1Mt) asks for N threads in all (the engine thread
 * included), so ?mt=1 is the serial path. Only the threaded build (SE1_THREADS) has helpers; the
 * single-threaded build always runs jobs inline. */
#ifndef SE1_JOBS_H
#define SE1_JOBS_H

#ifdef __cplusplus
extern "C" {
#endif

/* Job body: handle indices [iBegin, iEnd); iThread is 0 on the calling thread, 1..N-1 on helpers
   (for per-thread scratch). */
typedef void (*SE1JobFn)(void *pvCtx, int iBegin, int iEnd, int iThread);

/* Threads that take part in a parallel section (1 = serial). Starts the helpers on first use,
   from the ?mt=N page option. */
int SE1Jobs_Threads(void);
/* Run fn over [0, ct) in chunks of iGrain indices on all threads; returns when all are done. */
void SE1Jobs_ParallelFor(int ct, int iGrain, SE1JobFn fn, void *pvCtx);
/* Nonzero while the current thread runs a job (the engine thread too, inside ParallelFor). */
int SE1Jobs_InJob(void);

#ifdef __cplusplus
}
#endif
#endif
