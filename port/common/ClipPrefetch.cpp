/* ClipPrefetch: the movers' first collision test of a tick, computed ahead on helper threads.
 * Scale track L (notes/perf/threads.md); the API is in ClipPrefetch.h.
 *
 * The mover loop (CSessionState::HandleMovers) is serial: each mover's TryToMove() clips its move
 * against the world as the movers before it left it, then moves. CWorld::ClipMove() is ~45% of a
 * stress1000 frame. Before the loop, every mover's intended move is known (PreMoving), so its
 * first ClipMove can be computed ahead on the frozen world, on several threads at once:
 *
 *  - the brush part (the mover's near-polygon cache, then its brush sectors) depends only on the
 *    mover's own placement, move and spheres and on static brushes;
 *  - the model part is a sequence of independent per-model tests (ClipMoveToModel), each of which
 *    can only lower the hit fraction (strictly, the first lowest wins). A job runs each model's
 *    test on its own, from the brush result, and keeps its local hit with the model's state.
 *
 * When the loop reaches the mover and its ClipMove has exactly the predicted inputs (bitwise), the
 * serial code takes the brush part as is and walks the real model list (same FindEntitiesNearBox
 * call as before) in order: a model whose state is bitwise what the job read contributes the
 * job's local hit (applied only if strictly below the running fraction, as the original update
 * does); any other model is tested serially as before. Anything a job can't do without side
 * effects (pass events, reference movers, terrain) makes it give that part up; a movable brush's end
 * position is checked like the models' state, and a brush moving, changing collision or being
 * destroyed during the loop drops everything (SE1Clip_WorldChanged).
 * The result is the same hit, fraction, plane and clipped line the serial code computes, so the
 * simulation stays bit-identical (perfbench --check).
 *
 * Measured (notes/perf/threads.md): exact (0 mismatches in ~500k ?mtverify checks) but no faster yet:
 * stress1000 5.72 -> 5.84 ms at ?mt=4, since about half the neighbours have moved by a mover's
 * turn and are retested, and the fork-join and checks cost about what the jobs save. */
#include <Engine/StdH.h>
#include <Engine/World/World.h>
#include <Engine/World/WorldCollision.h>
#include <Engine/Entities/InternalClasses.h>
#include <Engine/Entities/EntityCollision.h>
#include <Engine/Brushes/Brush.h>
#include <Engine/Base/ListIterator.inl>
#include <Engine/Base/Console.h>
#include <Engine/Templates/StaticArray.cpp>
#include <Engine/Templates/StaticStackArray.cpp>
#include <Engine/Templates/DynamicArray.cpp>
#include <string.h>
#include <stdint.h>
#include <vector>
#include <emscripten.h>
#include "Se1Jobs.h"
#include "ClipPrefetch.h"

// WorldCollisionGrid.cpp: the grid cells' entries near a box, in FindEntitiesNearBox() order but
// with repeats and without touching shared state (callable from helper threads)
void SE1Clip_GridEntitiesNearBox(CWorld *pwo, const FLOATaabbox3D &box, CStaticStackArray<CEntity*> &apen);

#define MAXTHREADS 16   // = SE1JOBS_MAX

/* A small open-addressing pointer set. */
struct PtrSet {
  std::vector<void*> ap;
  int ct = 0;
  static inline uint32_t Hash(const void *p) {
    uint32_t x = (uint32_t)(uintptr_t)p;
    x ^= x>>16; x *= 0x7feb352dU; x ^= x>>15;
    return x;
  }
  void Clear(void) {
    if (ap.empty()) ap.assign(64, NULL);
    else if (ct>0) memset(&ap[0], 0, ap.size()*sizeof(void*));
    ct = 0;
  }
  // nonzero if p was not there (and is now)
  int Insert(void *p) {
    if ((ct+1)*2>(int)ap.size()) Grow();
    const size_t m = ap.size()-1;
    for (size_t i = Hash(p)&m;; i = (i+1)&m) {
      if (ap[i]==p) return 0;
      if (ap[i]==NULL) { ap[i] = p; ct++; return 1; }
    }
  }
  void Grow(void) {
    std::vector<void*> apOld;
    apOld.swap(ap);
    ap.assign(apOld.size()*2, NULL);
    ct = 0;
    for (size_t i = 0; i<apOld.size(); i++) if (apOld[i]!=NULL) Insert(apOld[i]);
  }
};

/* Active brush sectors of a job (the cm_lhActiveSectors list: append order, each sector once).
   The serial code links the sectors' own list nodes, which jobs on several threads can't share. */
struct ActiveSectors {
  std::vector<CBrushSector*> a;
  PtrSet set;
  void Clear(void) { a.clear(); set.Clear(); }
  void Add(CBrushSector *pbsc) { if (set.Insert(pbsc)) a.push_back(pbsc); }
};

/* One model a job tested, with what the test read of it and its hit from the brush fraction. */
struct Cand {
  CEntity *pen;
  ULONG ulID;
  ULONG ulCollisionFlags;   // (pass events)
  int bUnsafe;       // the test had a side effect to do: don't reuse it
  int bMovable;
  int bHit;
  int iSph, ctSph;   // its spheres (centre, radius) in the arena's floats
  FLOATaabbox3D box;
  FLOAT3D v0, v1;
  FLOATmatrix3D m0, m1;
  FLOAT fFraction;
  FLOAT3D vLine;
  FLOATplane3D pl;
};

/* A movable brush a job's brush part tested: its end position for this tick can change during the
   move loop without a placement change (its own TryToMove sets it, a blocked move leaves it). */
struct MovBrush {
  CEntity *pen;
  FLOAT3D v1;
  FLOATmatrix3D m1;
};

/* Per-thread storage for the jobs' variable-size records; cleared before each loop. */
struct Arena {
  std::vector<Cand> acand;
  std::vector<MovBrush> amb;
  std::vector<FLOAT> afl;
  std::vector<void*> aptr;
  CStaticStackArray<CEntity*> apenGrid;
  PtrSet setGrid;
  ActiveSectors act;
};

/* One mover's prefetched first ClipMove. */
struct Pre {
  CMovableEntity *pen;
  int iThread;
  int bOk;              // brush part done and usable
  int bUsed;
  int iWhy;             // (statistics) why not bOk: 1 no prediction, 2 terrain, 3 movable brush, 4 brush pass event
  // inputs the job assumed
  FLOAT3D vA0, vA1;
  FLOATmatrix3D mA0, mA1;
  FLOATaabbox3D boxPath;
  ULONG ulCollisionFlags;
  FLOATaabbox3D boxNearBefore, boxEstimate;
  int iSph, ctSph;      // the mover's spheres (arena floats)
  int iSec, ctSec;      // the mover's sectors (arena pointers)
  // the brush part's result
  CEntity *penHit;
  CBrushPolygon *pbpoHit;
  FLOAT fFraction;
  FLOAT3D vLine;
  FLOATplane3D pl;
  // the near-polygon cache, if the job had to rebuild it
  int bCacheRebuilt;
  FLOATaabbox3D boxCache;
  int iPoly, ctPoly;    // (arena pointers)
  // the model part
  int iCand, ctCand;
  // movable brushes the brush part read
  int iMovBrush, ctMovBrush;
};

static Arena _aar[MAXTHREADS];
static std::vector<Pre> _apre;
static std::vector<int> _aiLookup;     // open addressing over _apre: index+1, 0 = empty
static CWorld *_pwo = NULL;
static int _bArmed = 0;
static ULONG _ulEpoch = 0, _ulEpochPrefetch = 0;
static thread_local int *_pbJobUnsafe = NULL;   // set while a job runs on this thread

// statistics (?mt=N&mtstats=1): printed every 100 move loops
static int _iStats = -1;
static int _ctMinMovers = 32;   // fewer movers run serially (?mtmin=N, for tests)
static long _ctStatPre, _ctStatUsed, _ctStatMiss, _ctStatCandReused, _ctStatCandRetested, _ctLoops;
// ?mtverify=1: every prefetched answer is also computed serially and compared (test mode; its
// double pass events can change the game, but each comparison is on the same state)
static int _bVerify = 0;
static long _ctVerified, _ctVerifyBad, _ctStatOk, _ctStatUnreached, _actStatWhy[5];
static double _tStatJobs;

int SE1Clip_InJobSideEffect(void)
{
  if (_pbJobUnsafe==NULL) return 0;
  *_pbJobUnsafe = 1;
  return 1;
}

void SE1Clip_WorldChanged(void)
{
  _ulEpoch++;
}

static inline int IsModel(CEntity *pen)
{
  return pen->en_RenderType==CEntity::RT_MODEL || pen->en_RenderType==CEntity::RT_EDITORMODEL
      || pen->en_RenderType==CEntity::RT_SKAMODEL || pen->en_RenderType==CEntity::RT_SKAEDITORMODEL;
}

static inline int Same(const void *pv0, const void *pv1, size_t sz) { return memcmp(pv0, pv1, sz)==0; }

/* CClipMove::ClipMoveToModel()'s first test: the model's box misses the movement path, so the test
   does nothing. Most models near a mover in a crowd end there, so the jobs keep records only of
   the others and the serial side repeats this test (it reads only the path, which is checked, and
   the model's current box). */
static inline int BoxMisses(const FLOATaabbox3D &boxPath, CEntity *penModel)
{
  const FLOATaabbox3D &boxModel = penModel->en_pciCollisionInfo->ci_boxCurrent;
  return (boxPath.Min()(1)>boxModel.Max()(1)) || (boxPath.Max()(1)<boxModel.Min()(1))
      || (boxPath.Min()(2)>boxModel.Max()(2)) || (boxPath.Max()(2)<boxModel.Min()(2))
      || (boxPath.Min()(3)>boxModel.Max()(3)) || (boxPath.Max()(3)<boxModel.Min()(3));
}

/* The placement CMovableEntity::DoMoving() asks its first TryToMove() for (next position, next
   rotation), computed the same way. A wrong guess only means the prefetch goes unused. */
static int PredictFirstMove(CMovableEntity *pen, FLOAT3D &vNext, FLOATmatrix3D &mNext)
{
  if (pen->en_pciCollisionInfo==NULL || (pen->en_ulPhysicsFlags&EPF_FORCEADDED)) return 0;
  const FLOAT3D vMove = pen->en_vIntendedTranslation-pen->en_vAppliedTranslation;
  vNext = pen->en_plPlacement.pl_PositionVector+vMove;
  if ((pen->en_ulPhysicsFlags&EPF_RT_SYNCHRONIZED) || pen->en_penReference==NULL) {
    // translation and rotation together
    const FLOATmatrix3D mMove = pen->en_mIntendedRotation*!pen->en_mAppliedRotation;
    mNext = mMove*pen->en_mRotation;
  } else {
    // translation first
    mNext = pen->en_mRotation;
  }
  return 1;
}

static void PushSpheres(Arena &ar, CCollisionInfo *pci, int &iSph, int &ctSph)
{
  iSph = (int)ar.afl.size();
  ctSph = pci->ci_absSpheres.Count();
  for (INDEX i = 0; i<ctSph; i++) {
    const CMovingSphere &ms = pci->ci_absSpheres[i];
    ar.afl.push_back(ms.ms_vCenter(1)); ar.afl.push_back(ms.ms_vCenter(2));
    ar.afl.push_back(ms.ms_vCenter(3)); ar.afl.push_back(ms.ms_fR);
  }
}

static int SameSpheres(const Arena &ar, CCollisionInfo *pci, int iSph, int ctSph)
{
  if (pci->ci_absSpheres.Count()!=ctSph) return 0;
  const FLOAT *pf = &ar.afl[iSph];
  for (INDEX i = 0; i<ctSph; i++, pf += 4) {
    const CMovingSphere &ms = pci->ci_absSpheres[i];
    if (!Same(&ms.ms_vCenter, pf, 3*sizeof(FLOAT)) || !Same(&ms.ms_fR, pf+3, sizeof(FLOAT))) return 0;
  }
  return 1;
}

/* CClipMove::CacheNearPolygons() for a job: the rebuilt cache goes to the arena, not the entity. */
static void JobCacheNearPolygons(CClipMove &cm, Pre &p, Arena &ar)
{
  CMovableEntity *pen = cm.cm_penMoving;
  p.bCacheRebuilt = 0;
  if (cm.cm_boxMovementPath<=pen->en_boxNearCached) return;
  p.bCacheRebuilt = 1;
  FLOATaabbox3D box = cm.cm_boxMovementPath;
  box |= pen->en_boxMovingEstimate;
  p.boxCache = box;
  p.iPoly = (int)ar.aptr.size();

  ActiveSectors &act = ar.act;
  act.Clear();
  {FOREACHSRCOFDST(pen->en_rdSectors, CBrushSector, bsc_rsEntities, pbsc)
    act.Add(pbsc);
  ENDFOR}
  for (size_t iAct = 0; iAct<act.a.size(); iAct++) {
    CBrushSector *pbsc = act.a[iAct];
    FOREACHINSTATICARRAY(pbsc->bsc_abpoPolygons, CBrushPolygon, itbpo) {
      CBrushPolygon *pbpo = itbpo;
      if (!pbpo->bpo_boxBoundingBox.HasContactWith(box)) continue;
      ar.aptr.push_back(pbpo);
      if (pbpo->bpo_ulFlags&BPOF_PASSABLE) {
        {FOREACHDSTOFSRC(pbpo->bpo_rsOtherSideSectors, CBrushSector, bsc_rdOtherSidePortals, pbscRelated)
          act.Add(pbscRelated);
        ENDFOR}
      }
    }
    {FOREACHDSTOFSRC(pbsc->bsc_rsEntities, CEntity, en_rdSectors, penBrush)
      if (penBrush->en_RenderType==CEntity::RT_TERRAIN) continue;
      if (penBrush->en_RenderType!=CEntity::RT_BRUSH && penBrush->en_RenderType!=CEntity::RT_FIELDBRUSH) break;
      if (penBrush->en_ulPhysicsFlags&EPF_MOVABLE) continue;
      if (!cm.MustTest(penBrush)) continue;
      CBrushMip *pbm = penBrush->en_pbrBrush->GetFirstMip();
      if (pbm!=NULL) {
        {FOREACHINDYNAMICARRAY(pbm->bm_abscSectors, CBrushSector, itbscNonZoning) {
          act.Add(&*itbscNonZoning);
        }}
      }
    ENDFOR}
  }
  p.ctPoly = (int)ar.aptr.size()-p.iPoly;
}

/* CClipMove::ClipToZoningSector() for a job (reads the job's cache). */
static void JobClipToZoningSector(CClipMove &cm, CBrushSector *pbsc, Pre &p, Arena &ar)
{
  if (!pbsc->bsc_boxBoundingBox.HasContactWith(cm.cm_boxMovementPath)) return;
  CStaticStackArray<CBrushPolygon *> &apbpoEntity = cm.cm_penMoving->en_apbpoNearPolygons;
  const INDEX ct = p.bCacheRebuilt ? p.ctPoly : apbpoEntity.Count();
  for (INDEX i = 0; i<ct; i++) {
    CBrushPolygon *pbpo = p.bCacheRebuilt ? (CBrushPolygon *)ar.aptr[p.iPoly+i] : apbpoEntity[i];
    if (pbpo->bpo_pbscSector!=pbsc || !pbpo->bpo_boxBoundingBox.HasContactWith(cm.cm_boxMovementPath)) continue;
    if (!(pbpo->bpo_ulFlags&BPOF_PASSABLE)) {
      cm.ClipMoveToBrushPolygon(pbpo);
    } else {
      {FOREACHDSTOFSRC(pbpo->bpo_rsOtherSideSectors, CBrushSector, bsc_rdOtherSidePortals, pbscRelated)
        if (pbscRelated->bsc_pbmBrushMip->IsFirstMip()) ar.act.Add(pbscRelated);
      ENDFOR}
    }
  }
}

/* CClipMove::ClipMoveToBrushes() for a job. Gives up (bUnsafe) on terrain (shared buffers) and on
   movable brushes (their next position can change during the loop without a placement change). */
static void JobClipMoveToBrushes(CClipMove &cm, Pre &p, Arena &ar, int &bUnsafe)
{
  if (cm.cm_bMovingBrush) return;
  CMovableEntity *pen = cm.cm_penMoving;
  if (pen->en_ulCollisionFlags&ECF_IGNOREBRUSHES) return;

  ActiveSectors &act = ar.act;
  act.Clear();
  {FOREACHSRCOFDST(pen->en_rdSectors, CBrushSector, bsc_rsEntities, pbsc)
    if (pbsc->bsc_pbmBrushMip->IsFirstMip() &&
      pbsc->bsc_pbmBrushMip->bm_pbrBrush->br_pfsFieldSettings==NULL &&
      cm.MustTest(pbsc->bsc_pbmBrushMip->bm_pbrBrush->br_penEntity)) {
      act.Add(pbsc);
    }
  ENDFOR}

  for (size_t iAct = 0; iAct<act.a.size(); iAct++) {
    CBrushSector *pbsc = act.a[iAct];
    {FOREACHDSTOFSRC(pbsc->bsc_rsEntities, CEntity, en_rdSectors, penBrush)
      if (penBrush->en_RenderType!=CEntity::RT_BRUSH && penBrush->en_RenderType!=CEntity::RT_FIELDBRUSH &&
          penBrush->en_RenderType!=CEntity::RT_TERRAIN) {
        break;  // brushes are sorted first in list
      }
      if (!cm.MustTest(penBrush)) continue;
      if (penBrush->en_RenderType==CEntity::RT_TERRAIN) { bUnsafe = 2; return; }
      CBrushMip *pbm = penBrush->en_pbrBrush->GetFirstMip();
      if (pbm!=NULL) {
        {FOREACHINDYNAMICARRAY(pbm->bm_abscSectors, CBrushSector, itbscNonZoning) {
          act.Add(&*itbscNonZoning);
        }}
      }
    ENDFOR}

    CEntity *penBrush = pbsc->bsc_pbmBrushMip->bm_pbrBrush->br_penEntity;
    cm.cm_penTested = penBrush;
    cm.cm_penB = penBrush;
    // CClipMove::GetPositionsOfEntity()
    cm.cm_vB0 = penBrush->en_plPlacement.pl_PositionVector;
    cm.cm_mB0 = penBrush->en_mRotation;
    if (penBrush->en_ulPhysicsFlags&EPF_MOVABLE) {
      CMovableEntity *penMovable = (CMovableEntity *)penBrush;
      // (it would be added to the movers)
      if (penMovable->en_penReference==pen) { bUnsafe = 3; return; }
      cm.cm_vB1 = penMovable->en_vNextPosition;
      cm.cm_mB1 = penMovable->en_mNextRotation;
      MovBrush mb;
      mb.pen = penBrush;
      mb.v1 = cm.cm_vB1;
      mb.m1 = cm.cm_mB1;
      ar.amb.push_back(mb);
    } else {
      cm.cm_vB1 = cm.cm_vB0;
      cm.cm_mB1 = cm.cm_mB0;
    }
    cm.cm_bBrushProjectionsPending = TRUE;
    if (penBrush->en_ulFlags&ENF_ZONING) {
      JobClipToZoningSector(cm, pbsc, p, ar);
    } else {
      cm.ClipToNonZoningSector(pbsc);
    }
  }
  cm.cm_bBrushProjectionsPending = FALSE;
}

static inline void SetMasks(CClipMove &cm)
{
  // as CClipMove::ClipMoveToWorld()
  const ULONG ul = cm.cm_penMoving->en_ulCollisionFlags;
  cm.cm_ulTestMask1 = ((ul&ECF_TESTMASK)>>ECB_TEST)<<ECB_IS;
  cm.cm_ulTestMask2 = ((ul&ECF_ISMASK  )>>ECB_IS  )<<ECB_TEST;
  cm.cm_ulPassMaskA = ((ul&ECF_PASSMASK)>>ECB_PASS)<<ECB_IS;
  cm.cm_ulPassMaskB = ((ul&ECF_ISMASK  )>>ECB_IS  )<<ECB_PASS;
}

static void PrefetchOne(Pre &p, int iThread)
{
  Arena &ar = _aar[iThread];
  CMovableEntity *pen = p.pen;
  p.iThread = iThread;
  p.bOk = 0;
  p.ctCand = 0;
  FLOAT3D vNext;
  FLOATmatrix3D mNext;
  if (!PredictFirstMove(pen, vNext, mNext)) { p.iWhy = 1; return; }

  int bUnsafe = 0;
  _pbJobUnsafe = &bUnsafe;
  {
    // the ClipMove of TryToMove(): A is the mover, at its placement now and at the predicted one
    CClipMove cm(pen);
    cm.cm_vA1 = vNext;
    cm.cm_mA1 = mNext;
    FLOATaabbox3D box0, box1;
    pen->en_pciCollisionInfo->MakeBoxAtPlacement(cm.cm_vA0, cm.cm_mA0, box0);
    pen->en_pciCollisionInfo->MakeBoxAtPlacement(cm.cm_vA1, cm.cm_mA1, box1);
    cm.cm_boxMovementPath = box0;
    cm.cm_boxMovementPath |= box1;

    p.vA0 = cm.cm_vA0; p.mA0 = cm.cm_mA0; p.vA1 = cm.cm_vA1; p.mA1 = cm.cm_mA1;
    p.boxPath = cm.cm_boxMovementPath;
    p.ulCollisionFlags = pen->en_ulCollisionFlags;
    p.boxNearBefore = pen->en_boxNearCached;
    p.boxEstimate = pen->en_boxMovingEstimate;
    PushSpheres(ar, pen->en_pciCollisionInfo, p.iSph, p.ctSph);
    p.iSec = (int)ar.aptr.size();
    {FOREACHSRCOFDST(pen->en_rdSectors, CBrushSector, bsc_rsEntities, pbsc)
      ar.aptr.push_back(pbsc);
    ENDFOR}
    p.ctSec = (int)ar.aptr.size()-p.iSec;

    // CClipMove::ClipMoveToWorld()
    cm.cm_pwoWorld = _pwo;
    SetMasks(cm);
    JobCacheNearPolygons(cm, p, ar);
    p.iMovBrush = (int)ar.amb.size();
    JobClipMoveToBrushes(cm, p, ar, bUnsafe);
    p.ctMovBrush = (int)ar.amb.size()-p.iMovBrush;
    p.iWhy = bUnsafe==1 ? 4 : bUnsafe;
    if (!bUnsafe) {
      p.penHit = cm.cm_penHit;
      p.pbpoHit = cm.cm_pbpoHit;
      p.fFraction = cm.cm_fMovementFraction;
      p.vLine = cm.cm_vClippedLine;
      p.pl = cm.cm_plClippedPlane;

      // CClipMove::ClipMoveToModels(), each model on its own from the brush result
      p.iCand = (int)ar.acand.size();
      if (!(pen->en_ulCollisionFlags&ECF_IGNOREMODELS)) {
        ULONG ulSkipMask = ENF_DELETED;
        if (pen->IsPredictor()) ulSkipMask |= ENF_PREDICTED;
        ar.apenGrid.PopAll();
        SE1Clip_GridEntitiesNearBox(_pwo, cm.cm_boxMovementPath, ar.apenGrid);
        ar.setGrid.Clear();
        for (INDEX i = 0; i<ar.apenGrid.Count(); i++) {
          CEntity *penB = ar.apenGrid[i];
          if (!ar.setGrid.Insert(penB)) continue;
          if (penB==pen || (penB->en_ulFlags&ulSkipMask) || !cm.MustTest(penB) || !IsModel(penB)) continue;
          if (penB->en_pciCollisionInfo==NULL || BoxMisses(cm.cm_boxMovementPath, penB)) continue;
          Cand c;
          c.pen = penB;
          c.ulID = penB->en_ulID;
          c.ulCollisionFlags = penB->en_ulCollisionFlags;
          c.box = penB->en_pciCollisionInfo->ci_boxCurrent;
          c.v0 = penB->en_plPlacement.pl_PositionVector;
          c.m0 = penB->en_mRotation;
          c.bMovable = (penB->en_ulPhysicsFlags&EPF_MOVABLE)!=0;
          if (c.bMovable) {
            c.v1 = ((CMovableEntity *)penB)->en_vNextPosition;
            c.m1 = ((CMovableEntity *)penB)->en_mNextRotation;
          }
          PushSpheres(ar, penB->en_pciCollisionInfo, c.iSph, c.ctSph);
          int bCandUnsafe = 0;
          _pbJobUnsafe = &bCandUnsafe;
          cm.cm_fMovementFraction = p.fFraction;
          cm.cm_penHit = NULL;
          cm.cm_pbpoHit = NULL;
          cm.ClipMoveToModel(penB);
          _pbJobUnsafe = &bUnsafe;
          c.bUnsafe = bCandUnsafe;
          c.bHit = cm.cm_penHit!=NULL;
          if (c.bHit) {
            c.fFraction = cm.cm_fMovementFraction;
            c.vLine = cm.cm_vClippedLine;
            c.pl = cm.cm_plClippedPlane;
          }
          ar.acand.push_back(c);
        }
      }
      p.ctCand = (int)ar.acand.size()-p.iCand;
      p.bOk = !bUnsafe;
    }
  }
  _pbJobUnsafe = NULL;
}

static void PrefetchJob(void *pv, int iBegin, int iEnd, int iThread)
{
  for (int i = iBegin; i<iEnd; i++) PrefetchOne(_apre[i], iThread);
}

static inline uint32_t LookupSlot(const void *pen) { return PtrSet::Hash(pen); }

static Pre *Lookup(CMovableEntity *pen)
{
  if (_aiLookup.empty()) return NULL;
  const size_t m = _aiLookup.size()-1;
  for (size_t i = LookupSlot(pen)&m;; i = (i+1)&m) {
    const int j = _aiLookup[i];
    if (j==0) return NULL;
    if (_apre[j-1].pen==pen) return &_apre[j-1];
  }
}

void SE1Clip_BeginMoveLoop(CWorld *pwo, CListHead &lhActiveMovers, int bPredicting)
{
  _bArmed = 0;
  if (bPredicting || SE1Jobs_Threads()<=1) return;
  if (_iStats<0) {
    _iStats = MAIN_THREAD_EM_ASM_INT({ return Module['se1MtStats'] ? 1 : 0; });
    _ctMinMovers = MAIN_THREAD_EM_ASM_INT({ return Module['se1MtMin']!=null ? Module['se1MtMin'] : 32; });
    _bVerify = MAIN_THREAD_EM_ASM_INT({ return Module['se1MtVerify'] ? 1 : 0; });
    if (_bVerify) _iStats = 1;
  }

  _apre.clear();
  FOREACHINLIST(CMovableEntity, en_lnInMovers, lhActiveMovers, iten) {
    CMovableEntity *pen = iten;
    if (!IsModel(pen) || pen->en_pciCollisionInfo==NULL || (pen->en_ulFlags&ENF_DELETED)
      || !(pen->en_ulCollisionFlags&ECF_TESTMASK) || (pen->en_ulPhysicsFlags&EPF_FORCEADDED)) {
      continue;
    }
    Pre p;
    memset(&p, 0, sizeof(p));
    p.pen = pen;
    _apre.push_back(p);
  }
  // a few movers aren't worth waking the helpers for
  if ((int)_apre.size()<_ctMinMovers || _apre.empty()) return;

  size_t ctSlots = 64;
  while (ctSlots<_apre.size()*2) ctSlots *= 2;
  _aiLookup.assign(ctSlots, 0);
  for (size_t i = 0; i<_apre.size(); i++) {
    for (size_t j = LookupSlot(_apre[i].pen)&(ctSlots-1);; j = (j+1)&(ctSlots-1)) {
      if (_aiLookup[j]==0) { _aiLookup[j] = (int)i+1; break; }
    }
  }
  for (int i = 0; i<MAXTHREADS; i++) {
    _aar[i].acand.clear();
    _aar[i].amb.clear();
    _aar[i].afl.clear();
    _aar[i].aptr.clear();
  }
  _pwo = pwo;
  _ulEpochPrefetch = _ulEpoch;
  const double t0 = _iStats ? emscripten_get_now() : 0;
  SE1Jobs_ParallelFor((int)_apre.size(), 4, PrefetchJob, NULL);
  if (_iStats) {
    _tStatJobs += emscripten_get_now()-t0; _ctStatPre += (long)_apre.size();
    for (size_t i = 0; i<_apre.size(); i++) { _ctStatOk += _apre[i].bOk; if (!_apre[i].bOk) _actStatWhy[_apre[i].iWhy<5 ? _apre[i].iWhy : 0]++; }
  }
  _bArmed = 1;
}

void SE1Clip_EndMoveLoop(void)
{
  if (!_bArmed) return;
  _bArmed = 0;
  if (_iStats>0) for (size_t i = 0; i<_apre.size(); i++) _ctStatUnreached += _apre[i].bOk && !_apre[i].bUsed;
  if (_iStats>0 && ++_ctLoops%100==0) {
    CPrintF("clipprefetch: per loop %ld movers, %ld used, %ld missed | models reused %ld, retested %ld | jobs %.2f ms | verified %ld, bad %ld\n",
      _ctStatPre/100, _ctStatUsed/100, _ctStatMiss/100, _ctStatCandReused/100, _ctStatCandRetested/100,
      _tStatJobs/100, _ctVerified, _ctVerifyBad);
    MAIN_THREAD_EM_ASM({ Module['se1ClipStats'] = ({ loops: $0, movers: $1, used: $2, missed: $3, reused: $4,
      retested: $5, jobsMs: $6, verified: $7, bad: $8, ok: $9, unreached: $10, whyPredict: $11, whyTerrain: $12, whyMovableBrush: $13, whyPass: $14 }); }, _ctLoops, _ctStatPre/100, _ctStatUsed/100,
      _ctStatMiss/100, _ctStatCandReused/100, _ctStatCandRetested/100, _tStatJobs/100, _ctVerified, _ctVerifyBad,
      _ctStatOk/100, _ctStatUnreached/100, _actStatWhy[1]/100, _actStatWhy[2]/100, _actStatWhy[3]/100, _actStatWhy[4]/100);
    _ctStatPre = _ctStatUsed = _ctStatMiss = _ctStatCandReused = _ctStatCandRetested = 0;
    _ctStatOk = _ctStatUnreached = 0;
    memset(_actStatWhy, 0, sizeof(_actStatWhy));
    _tStatJobs = 0;
  }
}

static int CandStillSame(const Cand &c, CEntity *penB, CEntity *penMoving, const Arena &ar)
{
  if (c.bUnsafe || penB->en_ulID!=c.ulID || penB->en_ulCollisionFlags!=c.ulCollisionFlags
    || penB->en_pciCollisionInfo==NULL) return 0;
  if (!Same(&penB->en_pciCollisionInfo->ci_boxCurrent, &c.box, sizeof(c.box))) return 0;
  if (!Same(&penB->en_plPlacement.pl_PositionVector, &c.v0, sizeof(c.v0))) return 0;
  if (!Same(&penB->en_mRotation, &c.m0, sizeof(c.m0))) return 0;
  const int bMovable = (penB->en_ulPhysicsFlags&EPF_MOVABLE)!=0;
  if (bMovable!=c.bMovable) return 0;
  if (bMovable) {
    CMovableEntity *penMovable = (CMovableEntity *)penB;
    if (!Same(&penMovable->en_vNextPosition, &c.v1, sizeof(c.v1))) return 0;
    if (!Same(&penMovable->en_mNextRotation, &c.m1, sizeof(c.m1))) return 0;
    // the test would add it to the movers (CClipMove::GetPositionsOfEntity)
    if (penMovable->en_penReference==penMoving) return 0;
  }
  return SameSpheres(ar, penB->en_pciCollisionInfo, c.iSph, c.ctSph);
}

int SE1Clip_ClipMove(CWorld *pwo, CClipMove &cm)
{
  if (!_bArmed || _pbJobUnsafe!=NULL) return 0;
  CMovableEntity *pen = cm.cm_penMoving;
  // (the cases CClipMove's constructor and ClipMoveToWorld() skip)
  if ((pen->en_ulFlags&ENF_DELETED) || !(pen->en_ulCollisionFlags&ECF_TESTMASK)
    || pen->en_pciCollisionInfo==NULL || cm.cm_bMovingBrush) {
    return 0;
  }
  Pre *pp = Lookup(pen);
  if (pp==NULL || !pp->bOk || pp->bUsed) return 0;
  Arena &ar = _aar[pp->iThread];
  // exactly the move, mover and world the job assumed?
  if (_ulEpoch!=_ulEpochPrefetch
    || !Same(&cm.cm_vA0, &pp->vA0, sizeof(pp->vA0)) || !Same(&cm.cm_mA0, &pp->mA0, sizeof(pp->mA0))
    || !Same(&cm.cm_vA1, &pp->vA1, sizeof(pp->vA1)) || !Same(&cm.cm_mA1, &pp->mA1, sizeof(pp->mA1))
    || !Same(&cm.cm_boxMovementPath, &pp->boxPath, sizeof(pp->boxPath))
    || pen->en_ulCollisionFlags!=pp->ulCollisionFlags
    || !Same(&pen->en_boxNearCached, &pp->boxNearBefore, sizeof(pp->boxNearBefore))
    || !Same(&pen->en_boxMovingEstimate, &pp->boxEstimate, sizeof(pp->boxEstimate))
    || !SameSpheres(ar, pen->en_pciCollisionInfo, pp->iSph, pp->ctSph)) {
    if (_iStats>0) _ctStatMiss++;
    return 0;
  }
  {
    int iSec = 0;
    {FOREACHSRCOFDST(pen->en_rdSectors, CBrushSector, bsc_rsEntities, pbsc)
      if (iSec>=pp->ctSec || ar.aptr[pp->iSec+iSec]!=pbsc) { iSec = -1; break; }
      iSec++;
    ENDFOR}
    if (iSec!=pp->ctSec) {
      if (_iStats>0) _ctStatMiss++;
      return 0;
    }
  }
  for (int i = 0; i<pp->ctMovBrush; i++) {
    const MovBrush &mb = ar.amb[pp->iMovBrush+i];
    CMovableEntity *penMovable = (CMovableEntity *)mb.pen;
    if (!(mb.pen->en_ulPhysicsFlags&EPF_MOVABLE) || penMovable->en_penReference==pen
      || !Same(&penMovable->en_vNextPosition, &mb.v1, sizeof(mb.v1))
      || !Same(&penMovable->en_mNextRotation, &mb.m1, sizeof(mb.m1))) {
      if (_iStats>0) _ctStatMiss++;
      return 0;
    }
  }
  pp->bUsed = 1;
  if (_iStats>0) _ctStatUsed++;

  // CClipMove::ClipMoveToWorld(), with the brush part from the job
  cm.cm_pwoWorld = pwo;
  SetMasks(cm);
  if (pp->bCacheRebuilt) {
    // what CacheNearPolygons() would have built
    pen->en_boxNearCached = pp->boxCache;
    CStaticStackArray<CBrushPolygon *> &apbpo = pen->en_apbpoNearPolygons;
    apbpo.PopAll();
    if (pp->ctPoly>0) {
      CBrushPolygon **ppbpo = apbpo.Push(pp->ctPoly);
      for (int i = 0; i<pp->ctPoly; i++) ppbpo[i] = (CBrushPolygon *)ar.aptr[pp->iPoly+i];
    }
  }
  cm.cm_penHit = pp->penHit;
  cm.cm_pbpoHit = pp->pbpoHit;
  cm.cm_fMovementFraction = pp->fFraction;
  cm.cm_vClippedLine = pp->vLine;
  cm.cm_plClippedPlane = pp->pl;

  // CClipMove::ClipMoveToModels(): the same models in the same order; reuse the job's test of
  // each one that is still as the job saw it
  if (!(pen->en_ulCollisionFlags&ECF_IGNOREMODELS)) {
    ULONG ulSkipMask = ENF_DELETED;
    if (pen->IsPredictor()) ulSkipMask |= ENF_PREDICTED;
    static CStaticStackArray<CEntity*> apenNear;
    pwo->FindEntitiesNearBox(cm.cm_boxMovementPath, apenNear);
    const Cand *pcand = pp->ctCand>0 ? &ar.acand[pp->iCand] : NULL;
    int iNext = 0;
    for (INDEX ien = 0; ien<apenNear.Count(); ien++) {
      CEntity *penB = apenNear[ien];
      if (penB==pen || (penB->en_ulFlags&ulSkipMask) || !cm.MustTest(penB) || !IsModel(penB)) continue;
      // (ClipMoveToModel() would return right away)
      if (BoxMisses(cm.cm_boxMovementPath, penB)) continue;
      // the job's record of it (mostly in the same order)
      const Cand *pc = NULL;
      for (int k = 0; k<pp->ctCand; k++) {
        int j = iNext+k;
        if (j>=pp->ctCand) j -= pp->ctCand;
        if (pcand[j].pen==penB) { pc = &pcand[j]; iNext = j+1; break; }
      }
      if (pc!=NULL && CandStillSame(*pc, penB, pen, ar)) {
        if (_iStats>0) _ctStatCandReused++;
        if (pc->bHit && pc->fFraction<cm.cm_fMovementFraction) {
          cm.cm_fMovementFraction = pc->fFraction;
          cm.cm_vClippedLine = pc->vLine;
          cm.cm_plClippedPlane = pc->pl;
          cm.cm_penHit = penB;
          cm.cm_pbpoHit = NULL;
        }
      } else {
        if (_iStats>0) _ctStatCandRetested++;
        cm.ClipMoveToModel(penB);
      }
    }
    apenNear.PopAll();
  }
  if (_bVerify) {
    // the serial answer from the same state (the cache is already what it would build)
    CEntity *penHit = cm.cm_penHit;
    CBrushPolygon *pbpoHit = cm.cm_pbpoHit;
    const FLOAT fFraction = cm.cm_fMovementFraction;
    const FLOAT3D vLine = cm.cm_vClippedLine;
    const FLOATplane3D pl = cm.cm_plClippedPlane;
    cm.cm_penHit = NULL;
    cm.cm_pbpoHit = NULL;
    cm.cm_fMovementFraction = 2.0f;
    cm.ClipMoveToWorld(pwo);
    _ctVerified++;
    if (penHit!=cm.cm_penHit || pbpoHit!=cm.cm_pbpoHit || !Same(&fFraction, &cm.cm_fMovementFraction, sizeof(FLOAT))
      || (penHit!=NULL && (!Same(&vLine, &cm.cm_vClippedLine, sizeof(vLine)) || !Same(&pl, &cm.cm_plClippedPlane, sizeof(pl))))) {
      if (_ctVerifyBad++<20) {
        CPrintF("clipprefetch: MISMATCH mover %08x: prefetch hit %08x/%p f %.9g, serial hit %08x/%p f %.9g\n",
          pen->en_ulID, penHit ? penHit->en_ulID : 0, (void *)pbpoHit, fFraction,
          cm.cm_penHit ? cm.cm_penHit->en_ulID : 0, (void *)cm.cm_pbpoHit, cm.cm_fMovementFraction);
      }
    }
  }
  return 1;
}
