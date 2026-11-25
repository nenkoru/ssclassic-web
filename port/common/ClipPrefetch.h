/* ClipPrefetch: movers' first collision test of a tick, computed ahead on helper threads
 * (scale track L, notes/perf/threads.md). Threaded build only (SE1_CLIPPREFETCH), and only with
 * ?mt=N above 1; otherwise nothing here runs. The engine files call these at a few marked points. */
#ifndef SE1_CLIPPREFETCH_H
#define SE1_CLIPPREFETCH_H

class CWorld;
class CClipMove;
class CListHead;

/* CSessionState::HandleMovers(), after every active mover's PreMoving(): compute each mover's
   first ClipMove of the tick in parallel on the world as it is now. */
void SE1Clip_BeginMoveLoop(CWorld *pwo, CListHead &lhActiveMovers, int bPredicting);
/* HandleMovers(), after the move loop: drop what was not used. */
void SE1Clip_EndMoveLoop(void);
/* CWorld::ClipMove(): nonzero when cm was answered from a prefetched result that is still exact. */
int SE1Clip_ClipMove(CWorld *pwo, CClipMove &cm);
/* On a prefetch job thread: mark the result being computed unusable and return nonzero (the job
   must not send events or change other entities); zero elsewhere. */
int SE1Clip_InJobSideEffect(void);
/* Something the prefetched brush results read changed (a brush moved, collision info was
   rebuilt): drop them all. */
void SE1Clip_WorldChanged(void);

#endif
