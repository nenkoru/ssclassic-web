/* Copyright (c) 2002-2012 Croteam Ltd. 
This program is free software; you can redistribute it and/or modify
it under the terms of version 2 of the GNU General Public License as published by
the Free Software Foundation


This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA. */

#include <Engine/StdH.h>
//#pragma GCC optimize 0
#include <Engine/World/World.h>
#include <Engine/World/PhysicsProfile.h>
#include <Engine/Templates/StaticStackArray.cpp>
#include <Engine/Templates/AllocationArray.h>
#include <Engine/Templates/AllocationArray.cpp>
#ifdef __EMSCRIPTEN__
#include <unordered_map>
#include <vector>
#include <algorithm>
#if defined(__EMSCRIPTEN__) && defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif
#endif

#define DEBUG_COLLIDEWITHALL 0

#if DEBUG_COLLIDEWITHALL
  #include <Engine/Templates/DynamicContainer.h>
  #include <Engine/Templates/DynamicContainer.cpp>
#endif

// allowed grid dimensions (meters)
#define GRID_MIN (-32000)
#define GRID_MAX (+32000)

#define GRID_CELLSIZE  2.0 // size of one grid cell (meters)
// number of hash table entries for grid cells
#define GRID_HASHTABLESIZE_LOG2  12 // must be even for bit-shuffling
#define GRID_HASHTABLESIZE (1<<GRID_HASHTABLESIZE_LOG2)

//#pragma inline_depth(0)

// find grid box from float coordinates
static inline void BoxToGrid(
  const FLOATaabbox3D &boxEntity, INDEX &iMinX, INDEX &iMaxX, INDEX &iMinZ, INDEX &iMaxZ)
{
  FLOAT fMinX = boxEntity.Min()(1);
  FLOAT fMinZ = boxEntity.Min()(3);
  FLOAT fMaxX = boxEntity.Max()(1);
  FLOAT fMaxZ = boxEntity.Max()(3);
#if defined(__EMSCRIPTEN__)
  // wasm float->int conversion saturates (+inf -> INT_MAX), but the engine relies on x86
  // cvttsd2si semantics, where any non-finite/out-of-range value becomes INT_MIN. Movers with
  // an infinite box then clamp to one cell on x86, but to a 64001x64001-cell scan in wasm
  // (multi-second freezes). Reproduce x86 exactly.
  #define SE1_X86FloatToIndex(d) (((d) >= -2147483648.0 && (d) < 2147483648.0) ? (INDEX)(d) : (INDEX)0x80000000)
  iMinX = Clamp(SE1_X86FloatToIndex(floor(fMinX/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMinZ = Clamp(SE1_X86FloatToIndex(floor(fMinZ/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxX = Clamp(SE1_X86FloatToIndex(ceil(fMaxX/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxZ = Clamp(SE1_X86FloatToIndex(ceil(fMaxZ/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
#elif defined(__arm__)
#if defined(PLATFORM_PANDORA) || defined(PLATFORM_PYRA)
  #define Isinf(a) (((*(unsigned int*)&a)&0x7fffffff)==0x7f800000)
#else
  #define Isinf isinff
#endif
  iMinX = (Isinf(fMinX))?INDEX(GRID_MIN):Clamp(INDEX(floor(fMinX/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMinZ = (Isinf(fMinZ))?INDEX(GRID_MIN):Clamp(INDEX(floor(fMinZ/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxX = (Isinf(fMaxX))?INDEX(GRID_MIN):Clamp(INDEX(ceil(fMaxX/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxZ = (Isinf(fMaxZ))?INDEX(GRID_MIN):Clamp(INDEX(ceil(fMaxZ/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
#else
  iMinX = INDEX(floor(fMinX/GRID_CELLSIZE));
  iMinZ = INDEX(floor(fMinZ/GRID_CELLSIZE));
  iMaxX = INDEX(ceil(fMaxX/GRID_CELLSIZE));
  iMaxZ = INDEX(ceil(fMaxZ/GRID_CELLSIZE));

  iMinX = Clamp(iMinX, (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMinZ = Clamp(iMinZ, (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxX = Clamp(iMaxX, (INDEX)GRID_MIN, (INDEX)GRID_MAX);
  iMaxZ = Clamp(iMaxZ, (INDEX)GRID_MIN, (INDEX)GRID_MAX);
#endif
}

// key calculations
static inline ULONG MakeCode(INDEX iX, INDEX iZ)
{
  return (iX<<16)|(iZ&0xffff);
}

static inline INDEX MakeKey(INDEX iX, INDEX iZ)
{
  //INDEX iKey = (iX+iZ)&(GRID_HASHTABLESIZE-1);  // x+z
  // use absolute x and z, swap upper and lower bits in z, xor x and z
  INDEX iZ2 = abs(iZ);
  INDEX iKey = (iZ2>>(GRID_HASHTABLESIZE_LOG2/2));
  iKey |= ((iZ2&(GRID_HASHTABLESIZE/2-1))<<(GRID_HASHTABLESIZE_LOG2/2));
  iKey ^= abs(iX);
  iKey &= (GRID_HASHTABLESIZE-1);
  return iKey;
}

static inline INDEX MakeKeyFromCode(ULONG ulCode)
{
  INDEX iX = SLONG(ulCode)>>16;
  INDEX iZ = SLONG(SWORD(ulCode&0xffff));
  return MakeKey(iX, iZ);
}

#ifdef __EMSCRIPTEN__
// web port perf: bumped on every change to any grid's cell lists. FindEntitiesNearBox()'s result
// depends only on the cell range it scans and on those lists, so while neither changes it can
// return its previous result again (see there).
static ULONG _ulGridChanges = 0;
#define GRID_CHANGED() (_ulGridChanges++)
#else
#define GRID_CHANGED()
#endif

// collision grid classes
class CGridCell {
public:
  ULONG gc_ulCode;      // 32 bit uid of the cell (from its coordinates in grid)
  INDEX gc_iNextCell;   // next cell with this hash code
  INDEX gc_iFirstEntry; // first entry in this cell
};
class CGridEntry {
public:
  CEntity *ge_penEntity;    // entity pointed to
  INDEX ge_iNextEntry;      // next entry in same cell
#ifdef __EMSCRIPTEN__
  INDEX ge_iObject;         // the entity's CGridObject
#endif
};

#ifdef __EMSCRIPTEN__
// web port perf: one compact record per entity in the grid, shared by all its entries. A search
// visits ~110 entries for ~43 distinct entities in a stress500 crowd (each entity spans ~2x2 cells),
// and the original deduplicates them by setting and clearing ENF_FOUNDINGRIDSEARCH in each entity,
// a cache miss per entry. An entity occupies exactly the cells of its rectangle from BoxToGrid(), so
// in the scan order (x outer, z inner) its first entry inside a searched rectangle is in the cell
// (max(its min x, search min x), max(its min z, search min z)): taking an entity only there gives
// the same entities in the same order without touching them. The box lets the collision query skip
// entities whose box misses the movement box without touching them either.
class CGridObject {
public:
  CEntity *go_penEntity;
  FLOATaabbox3D go_box;     // the box last given to Add/MoveEntityInCollisionGrid (= ci_boxCurrent)
  INDEX go_iMinX, go_iMinZ; // first cell of that box
};
static inline BOOL SameBox(const FLOATaabbox3D &box1, const FLOATaabbox3D &box2)
{
  return memcmp(&box1, &box2, sizeof(FLOATaabbox3D))==0;
}
#endif

class CCollisionGrid {
public:
  CStaticArray<INDEX> cg_aiFirstCells;     // first cell for each hash entry
  CAllocationArray<CGridCell> cg_agcCells;     // all cells
  CAllocationArray<CGridEntry> cg_ageEntries;  // all entries

  CCollisionGrid(void);
  ~CCollisionGrid(void);
  void Clear(void);
  // create a new grid cell in given hash table entry
  INDEX CreateCell(INDEX iKey, ULONG ulCode);
  // remove a cell
  void RemoveCell(INDEX igc);
  // get grid cell for its coordinates
  INDEX FindCell(INDEX iX, INDEX iZ, BOOL bCreate);
  // add entry to a given cell
  void AddEntry(INDEX igc, CEntity *pen);
  // remove entry from a given cell
  void RemoveEntry(INDEX igc, CEntity *pen);
#ifdef __EMSCRIPTEN__
  CAllocationArray<CGridObject> cg_agoObjects;  // records of the entities in the grid
  std::unordered_map<CEntity*, INDEX> cg_mapObjects; // entity -> its record
  // set when the grid is used in a way that breaks the record invariants (an entity added twice,
  // moved or removed with a box other than the one it was added with, an entry missing); the
  // collision searches then use the original algorithm until the next Clear()
  BOOL cg_bInconsistent;
  INDEX cg_igoAdding;   // record for the entries AddEntry() creates
  INDEX NewObject(CEntity *pen, const FLOATaabbox3D &box, INDEX iMinX, INDEX iMinZ);
  INDEX GetObject(CEntity *pen, const FLOATaabbox3D &boxOld);
#endif
};


// collision grid class implementation

CCollisionGrid::CCollisionGrid(void)
{
  Clear();
}

CCollisionGrid::~CCollisionGrid(void)
{
  Clear();
}

void CCollisionGrid::Clear(void)
{
  GRID_CHANGED();
  cg_aiFirstCells.Clear();
  cg_agcCells.Clear();
  cg_ageEntries.Clear();
#ifdef __EMSCRIPTEN__
  cg_agoObjects.Clear();
  cg_agoObjects.SetAllocationStep(256);
  cg_mapObjects.clear();
  cg_bInconsistent = FALSE;
  cg_igoAdding = -1;
#endif

  cg_aiFirstCells.New(GRID_HASHTABLESIZE);
  cg_agcCells.SetAllocationStep(1024);
  cg_ageEntries.SetAllocationStep(1024);

  // mark all cells as unused
  for(INDEX iKey=0; iKey<GRID_HASHTABLESIZE; iKey++) {
    cg_aiFirstCells[iKey] = -1;
  }
}

// create a new grid cell in given hash table entry
INDEX CCollisionGrid::CreateCell(INDEX iKey, ULONG ulCode)
{
  // find an empty cell
  INDEX igc = cg_agcCells.Allocate();
  CGridCell &gc = cg_agcCells[igc];

  // set up the cell
  gc.gc_ulCode = ulCode;
  gc.gc_iFirstEntry = -1;

  // link it by hash key
  gc.gc_iNextCell = cg_aiFirstCells[iKey];
  cg_aiFirstCells[iKey] = igc;

  return igc;
}

// remove a cell
void CCollisionGrid::RemoveCell(INDEX igc)
{
  // get key of the cell
  CGridCell &gc = cg_agcCells[igc];
  INDEX iKey = MakeKeyFromCode(gc.gc_ulCode);

  // find the cell's index pointer
  INDEX *pigc = &cg_aiFirstCells[iKey];
  ASSERT(*pigc>=0);
  while(*pigc>=0) {
    CGridCell &gc = cg_agcCells[*pigc];
    if (*pigc==igc) {
      *pigc = gc.gc_iNextCell;
      gc.gc_iNextCell = -2;
      gc.gc_iFirstEntry = -1;
      gc.gc_ulCode = 0x12345678;
      cg_agcCells.Free(igc);
      return;
    }
    pigc = &gc.gc_iNextCell;
  }
  ASSERT(FALSE);
}

// get grid cell for its coordinates
INDEX CCollisionGrid::FindCell(INDEX iX, INDEX iZ, BOOL bCreate)
{
  // make uid of the cell
  ASSERT(iX>=GRID_MIN && iX<=GRID_MAX);
  ASSERT(iZ>=GRID_MIN && iZ<=GRID_MAX);
  ULONG ulCode = MakeCode(iX, iZ);
  // get the hash key for the cell
  INDEX iKey = MakeKey(iX, iZ);  // x+z, use lower bits
  ASSERT(iKey==MakeKeyFromCode(ulCode));
  // find the cell in list of cells with that key
  INDEX igcFound = -1;
  for (INDEX igc=cg_aiFirstCells[iKey]; igc>=0; igc = cg_agcCells[igc].gc_iNextCell) {
    if (cg_agcCells[igc].gc_ulCode==ulCode) {
      igcFound = igc;
      break;
    }
  }

  // if the cell is found
  if (igcFound>=0) {
    // use existing one
    return igcFound;
  // if the cell is not found
  } else {
    // if new one may be created
    if (bCreate) {
      // create a new one
      return CreateCell(iKey, ulCode);
    // if new one may not be created
    } else {
      // return nothing
      return -1;
    }
  }
}

// add entry to a given cell
void CCollisionGrid::AddEntry(INDEX igc, CEntity *pen)
{
  // find an empty entry
  INDEX ige = cg_ageEntries.Allocate();
  CGridEntry &ge = cg_ageEntries[ige];

  // init the entry and link it in its cell
  GRID_CHANGED();
  ge.ge_penEntity = pen;
#ifdef __EMSCRIPTEN__
  ge.ge_iObject = cg_igoAdding;
#endif
  CGridCell &gc = cg_agcCells[igc];
  ge.ge_iNextEntry = gc.gc_iFirstEntry;
  gc.gc_iFirstEntry = ige;
}

// remove entry from a given cell
void CCollisionGrid::RemoveEntry(INDEX igc, CEntity *pen)
{
  CGridCell &gc = cg_agcCells[igc];

  // find the entry's index pointer
  INDEX *pige = &gc.gc_iFirstEntry;
  ASSERT(*pige>=0);
  while(*pige>=0) {
    CGridEntry &ge = cg_ageEntries[*pige];
    if (ge.ge_penEntity==pen) {
      GRID_CHANGED();
      // remove the entry from the list
      cg_ageEntries.Free(*pige);
      *pige = ge.ge_iNextEntry;
      ge.ge_iNextEntry = -2;
      ge.ge_penEntity = NULL;
      // if the cell becomes empty
      if (gc.gc_iFirstEntry<0) {
        // remove the cell
        RemoveCell(igc);
      }
      return;
    }
    pige = &ge.ge_iNextEntry;
  }
  ASSERT(FALSE);
#ifdef __EMSCRIPTEN__
  cg_bInconsistent = TRUE;
#endif
}

#ifdef __EMSCRIPTEN__
// make the record of an entity being added
INDEX CCollisionGrid::NewObject(CEntity *pen, const FLOATaabbox3D &box, INDEX iMinX, INDEX iMinZ)
{
  GRID_CHANGED();
  INDEX igo = cg_agoObjects.Allocate();
  CGridObject &go = cg_agoObjects[igo];
  go.go_penEntity = pen;
  go.go_box = box;
  go.go_iMinX = iMinX;
  go.go_iMinZ = iMinZ;
  std::pair<std::unordered_map<CEntity*, INDEX>::iterator, bool> res =
    cg_mapObjects.insert(std::make_pair(pen, igo));
  if (!res.second) {
    // already in the grid
    cg_bInconsistent = TRUE;
    res.first->second = igo;
  }
  return igo;
}
// find the record of an entity in the grid, which must have the given box
INDEX CCollisionGrid::GetObject(CEntity *pen, const FLOATaabbox3D &boxOld)
{
  std::unordered_map<CEntity*, INDEX>::iterator it = cg_mapObjects.find(pen);
  if (it==cg_mapObjects.end()) {
    cg_bInconsistent = TRUE;
    return -1;
  }
  if (!SameBox(cg_agoObjects[it->second].go_box, boxOld)) {
    cg_bInconsistent = TRUE;
  }
  return it->second;
}
#endif



/* Initialize collision grid. */
void CWorld::InitCollisionGrid(void)
{
  wo_pcgCollisionGrid = new CCollisionGrid;
}
/* Destroy collision grid. */
void CWorld::DestroyCollisionGrid(void)
{
  delete wo_pcgCollisionGrid;
  wo_pcgCollisionGrid = NULL;
}
// clear collision grid
void CWorld::ClearCollisionGrid(void)
{
  wo_pcgCollisionGrid->Clear();
}


/* Add an entity to cell(s) in collision grid. */
void CWorld::AddEntityToCollisionGrid(CEntity *pen, const FLOATaabbox3D &boxEntity)
{
  _pfPhysicsProfile.StartTimer(CPhysicsProfile::PTI_ADDENTITYTOGRID);
  // find grid coordinates
  INDEX iMinX, iMaxX, iMinZ, iMaxZ;
  BoxToGrid(boxEntity, iMinX, iMaxX, iMinZ, iMaxZ);
#ifdef __EMSCRIPTEN__
  wo_pcgCollisionGrid->cg_igoAdding = wo_pcgCollisionGrid->NewObject(pen, boxEntity, iMinX, iMinZ);
#endif
  // for each cell spanned by the entity
  for(INDEX iX=iMinX; iX<=iMaxX; iX++) {
    for(INDEX iZ=iMinZ; iZ<=iMaxZ; iZ++) {
      // find that cell
      INDEX igc = wo_pcgCollisionGrid->FindCell(iX, iZ, TRUE);
      // add the entity to the cell
      wo_pcgCollisionGrid->AddEntry(igc, pen);
    }
  }
  _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_ADDENTITYTOGRID);
}


/* Remove an entity from cell(s) in collision grid. */
void CWorld::RemoveEntityFromCollisionGrid(CEntity *pen, const FLOATaabbox3D &boxEntity)
{
  _pfPhysicsProfile.StartTimer(CPhysicsProfile::PTI_REMENTITYFROMGRID);
  // find grid coordinates
  INDEX iMinX, iMaxX, iMinZ, iMaxZ;
  BoxToGrid(boxEntity, iMinX, iMaxX, iMinZ, iMaxZ);
#ifdef __EMSCRIPTEN__
  {CCollisionGrid *pcg = wo_pcgCollisionGrid;
  INDEX igo = pcg->GetObject(pen, boxEntity);
  if (igo>=0) {
    GRID_CHANGED();
    pcg->cg_agoObjects.Free(igo);
    pcg->cg_mapObjects.erase(pen);
  }}
#endif
  // for each cell spanned by the entity
  for(INDEX iX=iMinX; iX<=iMaxX; iX++) {
    for(INDEX iZ=iMinZ; iZ<=iMaxZ; iZ++) {
      // find that cell
      INDEX igc = wo_pcgCollisionGrid->FindCell(iX, iZ, FALSE);
      ASSERT(igc>=0);
      // remove the entity from the cell
      if (igc>=0) {
        wo_pcgCollisionGrid->RemoveEntry(igc, pen);
      }
#ifdef __EMSCRIPTEN__
      else {
        wo_pcgCollisionGrid->cg_bInconsistent = TRUE;
      }
#endif
    }
  }
  _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_REMENTITYFROMGRID);
}

/* Move an entity inside cell(s) in collision grid. */
void CWorld::MoveEntityInCollisionGrid(CEntity *pen,
  const FLOATaabbox3D &boxOld, const FLOATaabbox3D &boxNew)
{
  _pfPhysicsProfile.StartTimer(CPhysicsProfile::PTI_MOVEENTITYINGRID);

  // find grid coordinates
  INDEX iOldMinX, iOldMaxX, iOldMinZ, iOldMaxZ;
  BoxToGrid(boxOld, iOldMinX, iOldMaxX, iOldMinZ, iOldMaxZ);
  INDEX iNewMinX, iNewMaxX, iNewMinZ, iNewMaxZ;
  BoxToGrid(boxNew, iNewMinX, iNewMaxX, iNewMinZ, iNewMaxZ);
#ifdef __EMSCRIPTEN__
  {CCollisionGrid *pcg = wo_pcgCollisionGrid;
  INDEX igo = pcg->GetObject(pen, boxOld);
  if (igo>=0) {
    CGridObject &go = pcg->cg_agoObjects[igo];
    go.go_box = boxNew;
    go.go_iMinX = iNewMinX;
    go.go_iMinZ = iNewMinZ;
  }
  pcg->cg_igoAdding = igo;}
#endif

  // for each cell spanned by the entity before moving but not after moving
  {for(INDEX iX=iOldMinX; iX<=iOldMaxX; iX++) {
    for(INDEX iZ=iOldMinZ; iZ<=iOldMaxZ; iZ++) {
      if (iX>=iNewMinX && iX<=iNewMaxX
        &&iZ>=iNewMinZ && iZ<=iNewMaxZ) {
        continue;
      }
      // find that cell
      INDEX igc = wo_pcgCollisionGrid->FindCell(iX, iZ, FALSE);
      ASSERT(igc>=0);
      // remove the entity from the cell
      if (igc>=0) {
        wo_pcgCollisionGrid->RemoveEntry(igc, pen);
      }
#ifdef __EMSCRIPTEN__
      else {
        wo_pcgCollisionGrid->cg_bInconsistent = TRUE;
      }
#endif
    }
  }}

  // for each cell spanned by the entity after moving but not before moving
  {for(INDEX iX=iNewMinX; iX<=iNewMaxX; iX++) {
    for(INDEX iZ=iNewMinZ; iZ<=iNewMaxZ; iZ++) {
      if (iX>=iOldMinX && iX<=iOldMaxX
        &&iZ>=iOldMinZ && iZ<=iOldMaxZ) {
        continue;
      }
      // find that cell
      INDEX igc = wo_pcgCollisionGrid->FindCell(iX, iZ, TRUE);
      wo_pcgCollisionGrid->AddEntry(igc, pen);
    }
  }}
  _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_MOVEENTITYINGRID);
}


/* Find all entities in collision grid near given box. */
void CWorld::FindEntitiesNearBox(const FLOATaabbox3D &boxNear,
  CStaticStackArray<CEntity*> &apenNearEntities)
{

#if DEBUG_COLLIDEWITHALL
  apenNearEntities.PopAll();
  // for each entity
  {FOREACHINDYNAMICCONTAINER(wo_cenEntities, CEntity, iten) {
    CEntity &en = *iten;
    if (en.GetRenderType()==CEntity::RT_MODEL && en.en_pciCollisionInfo!=NULL) {
      apenNearEntities.Push() = &en;
    }
  }}

  return;
#endif

  _pfPhysicsProfile.StartTimer(CPhysicsProfile::PTI_FINDENTITIESNEARBOX);
  _pfPhysicsProfile.IncrementCounter(CPhysicsProfile::PCI_FINDINGNEARENTITIES);

  // find grid coordinates
  INDEX iMinX, iMaxX, iMinZ, iMaxZ;
  BoxToGrid(boxNear, iMinX, iMaxX, iMinZ, iMaxZ);
  apenNearEntities.PopAll();

#ifdef __EMSCRIPTEN__
  // web port perf: a mover whose move is clipped retries (sliding, stairs) from the same place,
  // so ~60% of the searches in a stress500 crowd scan the same cells as the search before, with
  // no grid change in between. The scan order (cells by x then z, each cell's list, first
  // occurrence wins) gives the same entities in the same order then, so copy the last result.
  static CStaticStackArray<CEntity*> apenLast;
  static CCollisionGrid *pcgLast = NULL;
  static ULONG ulLastChanges = 0;
  static INDEX iLastMinX, iLastMaxX, iLastMinZ, iLastMaxZ;
  if (pcgLast==wo_pcgCollisionGrid && ulLastChanges==_ulGridChanges
    && iLastMinX==iMinX && iLastMaxX==iMaxX && iLastMinZ==iMinZ && iLastMaxZ==iMaxZ) {
    const INDEX ct = apenLast.Count();
    if (ct>0) {
      CEntity **ppen = apenNearEntities.Push(ct);
      memcpy(ppen, &apenLast[0], ct*sizeof(CEntity*));
    }
    _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_FINDENTITIESNEARBOX);
    return;
  }
#endif

  // for each cell spanned by the box
  {for(INDEX iX=iMinX; iX<=iMaxX; iX++) {
    for(INDEX iZ=iMinZ; iZ<=iMaxZ; iZ++) {
      _pfPhysicsProfile.IncrementCounter(CPhysicsProfile::PCI_NEARCELLSFOUND);
      // find that cell
      INDEX igc = wo_pcgCollisionGrid->FindCell(iX, iZ, FALSE);
      // if the cell is empty
      if (igc<0) {
        // skip it
        continue;
      }
      _pfPhysicsProfile.IncrementCounter(CPhysicsProfile::PCI_NEAROCCUPIEDCELLSFOUND);
      // for each entity in the cell
      for(INDEX iEntry = wo_pcgCollisionGrid->cg_agcCells[igc].gc_iFirstEntry;
          iEntry>=0;
          iEntry = wo_pcgCollisionGrid->cg_ageEntries[iEntry].ge_iNextEntry) {
        CEntity *penEntity = wo_pcgCollisionGrid->cg_ageEntries[iEntry].ge_penEntity;
        // if it is not already found
        if (!(penEntity->en_ulFlags&ENF_FOUNDINGRIDSEARCH)) {
          // add it
          apenNearEntities.Push() = penEntity;
          // mark it as found
          penEntity->en_ulFlags|=ENF_FOUNDINGRIDSEARCH;
        }
      }
    }
  }}


  _pfPhysicsProfile.IncrementCounter(
    CPhysicsProfile::PCI_NEARENTITIESFOUND, apenNearEntities.Count());
  // for each of the found entities
  for(INDEX ienFound=0; ienFound<apenNearEntities.Count(); ienFound++) {
    // clear found flag
    apenNearEntities[ienFound]->en_ulFlags&=~ENF_FOUNDINGRIDSEARCH;
  }
#ifdef __EMSCRIPTEN__
  // remember this result for the next search (see above)
  apenLast.PopAll();
  {const INDEX ct = apenNearEntities.Count();
  if (ct>0) {
    CEntity **ppen = apenLast.Push(ct);
    memcpy(ppen, &apenNearEntities[0], ct*sizeof(CEntity*));
  }}
  pcgLast = wo_pcgCollisionGrid;
  ulLastChanges = _ulGridChanges;
  iLastMinX = iMinX; iLastMaxX = iMaxX; iLastMinZ = iMinZ; iLastMaxZ = iMaxZ;
#endif
  _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_FINDENTITIESNEARBOX);
}



#ifdef __EMSCRIPTEN__
// web port perf: the near entities for CClipMove::ClipMoveToModels(), which acts only on those whose
// ci_boxCurrent touches its movement box (CClipMove::ClipMoveToModel() returns at once for the
// others). In a stress500 crowd that is ~3 of the ~43 FindEntitiesNearBox() finds. Returns the same
// entities in the same order as FindEntitiesNearBox() minus those that the box test in
// ClipMoveToModel() rejects, tested on the records' copies of ci_boxCurrent (see CGridObject).
// A movement retry (sliding, stairs) searches the same cells again, so the record list of the last
// scan is kept while the grid doesn't change; the boxes are read anew each time.
void SE1_FindEntitiesTouchingBox(CWorld *pwo, const FLOATaabbox3D &boxNear,
  CStaticStackArray<CEntity*> &apenNearEntities)
{
  CCollisionGrid *pcg = pwo->wo_pcgCollisionGrid;
  if (pcg->cg_bInconsistent) {
    pwo->FindEntitiesNearBox(boxNear, apenNearEntities);
    return;
  }
  _pfPhysicsProfile.StartTimer(CPhysicsProfile::PTI_FINDENTITIESNEARBOX);
  _pfPhysicsProfile.IncrementCounter(CPhysicsProfile::PCI_FINDINGNEARENTITIES);

  INDEX iMinX, iMaxX, iMinZ, iMaxZ;
  BoxToGrid(boxNear, iMinX, iMaxX, iMinZ, iMaxZ);
  // Round 3: BoxToGrid() rounds the max edges up (ceil), so a box inside one cell scans 2x2 cells.
  // A record is taken in the cell of its first entry inside the rectangle, (max(go_iMinX, iMinX),
  // max(go_iMinZ, iMinZ)); one with go_iMinX > floor(max x/cell) has floor(min x/cell) >= that + 1,
  // so its min x > the query's max x (exact: a float halved, floored, in double) and the box test
  // below rejects it. The same holds for z. So the last column and row, when ceil and floor differ,
  // hold first entries of rejected records only and are not scanned; the order of the others is
  // unchanged. Non-finite edges convert as in BoxToGrid() (both give GRID_MIN), and clamping only
  // keeps more. Measured at stress4000: see notes/perf/collision3.md.
  {
    const FLOAT fMaxX = boxNear.Max()(1), fMaxZ = boxNear.Max()(3);
    const INDEX iFloorMaxX = Clamp(SE1_X86FloatToIndex(floor(fMaxX/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
    const INDEX iFloorMaxZ = Clamp(SE1_X86FloatToIndex(floor(fMaxZ/GRID_CELLSIZE)), (INDEX)GRID_MIN, (INDEX)GRID_MAX);
    if (iFloorMaxX<iMaxX) iMaxX = iFloorMaxX;
    if (iFloorMaxZ<iMaxZ) iMaxZ = iFloorMaxZ;
  }
  apenNearEntities.PopAll();

  static CStaticStackArray<INDEX> aigoLast;
  static CCollisionGrid *pcgLast = NULL;
  static ULONG ulLastChanges = 0;
  static INDEX iLastMinX, iLastMaxX, iLastMinZ, iLastMaxZ;
  if (!(pcgLast==pcg && ulLastChanges==_ulGridChanges
    && iLastMinX==iMinX && iLastMaxX==iMaxX && iLastMinZ==iMinZ && iLastMaxZ==iMaxZ)) {
    aigoLast.PopAll();
    for(INDEX iX=iMinX; iX<=iMaxX; iX++) {
      for(INDEX iZ=iMinZ; iZ<=iMaxZ; iZ++) {
        INDEX igc = pcg->FindCell(iX, iZ, FALSE);
        if (igc<0) {
          continue;
        }
        for(INDEX iEntry = pcg->cg_agcCells[igc].gc_iFirstEntry; iEntry>=0;
            iEntry = pcg->cg_ageEntries[iEntry].ge_iNextEntry) {
          const CGridEntry &ge = pcg->cg_ageEntries[iEntry];
          const CGridObject &go = pcg->cg_agoObjects[ge.ge_iObject];
          if (Max(go.go_iMinX, iMinX)==iX && Max(go.go_iMinZ, iMinZ)==iZ) {
            aigoLast.Push() = ge.ge_iObject;
          }
        }
      }
    }
    pcgLast = pcg;
    ulLastChanges = _ulGridChanges;
    iLastMinX = iMinX; iLastMaxX = iMaxX; iLastMinZ = iMinZ; iLastMaxZ = iMaxZ;
  }

  // keep those whose box touches (the test in CClipMove::ClipMoveToModel())
  const INDEX ct = aigoLast.Count();
#if defined(__wasm_simd128__)
  // Round 3: at stress4000 every search box-tests ~112 records to keep ~14, and the scalar test's
  // six data-dependent branches mispredict. The same six float comparisons, branch-free: a box is
  // (min x, y, z, max x, y, z) in memory, loaded as [mnx mny mnz mxx] and [mnz mxx mxy mxz]. A lane
  // that holds NaN in the query vector compares false, as an unused test would. "a > b" is
  // computed as "b < a", which is the same IEEE comparison (false for NaN as well).
  {
    const FLOAT fNaN = __builtin_nanf("");
    const FLOAT *pfQ = &boxNear.Min()(1);
    // reject when the query's max < the box's min (x, y, z) ...
    const v128_t vQMax = wasm_f32x4_make(pfQ[3], pfQ[4], pfQ[5], fNaN);
    // ... or the box's max x < the query's min x (lane 3 of the first load) ...
    const v128_t vQMinX = wasm_f32x4_make(fNaN, fNaN, fNaN, pfQ[0]);
    // ... or the box's max y, z < the query's min y, z (lanes 2, 3 of the second load)
    const v128_t vQMinYZ = wasm_f32x4_make(fNaN, fNaN, pfQ[1], pfQ[2]);
    for(INDEX i=0; i<ct; i++) {
      const CGridObject &go = pcg->cg_agoObjects[aigoLast[i]];
      const FLOAT *pfB = &go.go_box.Min()(1);
      const v128_t v0 = wasm_v128_load(pfB);
      const v128_t v1 = wasm_v128_load(pfB+2);
      const v128_t vOut = wasm_v128_or(wasm_v128_or(
        wasm_f32x4_lt(vQMax, v0), wasm_f32x4_lt(v0, vQMinX)), wasm_f32x4_lt(v1, vQMinYZ));
      if (wasm_v128_any_true(vOut)) {
        continue;
      }
      apenNearEntities.Push() = go.go_penEntity;
    }
  }
  if (0)
#endif
  for(INDEX i=0; i<ct; i++) {
    const CGridObject &go = pcg->cg_agoObjects[aigoLast[i]];
    const FLOATaabbox3D &boxModel = go.go_box;
    if (
      (boxNear.Min()(1)>boxModel.Max()(1)) ||
      (boxNear.Max()(1)<boxModel.Min()(1)) ||
      (boxNear.Min()(2)>boxModel.Max()(2)) ||
      (boxNear.Max()(2)<boxModel.Min()(2)) ||
      (boxNear.Min()(3)>boxModel.Max()(3)) ||
      (boxNear.Max()(3)<boxModel.Min()(3))) {
      continue;
    }
    apenNearEntities.Push() = go.go_penEntity;
  }
  _pfPhysicsProfile.StopTimer(CPhysicsProfile::PTI_FINDENTITIESNEARBOX);
}

// web port perf (notes/perf/rays3.md): how many entities the grid holds
INDEX SE1_CollisionGridRecordCount(CWorld *pwo)
{
  CCollisionGrid *pcg = pwo->wo_pcgCollisionGrid;
  return pcg==NULL ? 0 : (INDEX)pcg->cg_mapObjects.size();
}

// web port perf (notes/perf/rays3.md): the entities in the grid whose box, grown by dGrow on every
// side, meets the segment X(t) = adO + t*adDir, t in [dT0, dT1] (double). Each once, in no
// particular order. A point of a box lies in a cell the entity occupies (BoxToGrid() spans
// floor(min/cell) .. ceil(max/cell)), and a point within dGrow of the segment in x and z lies in a
// column of cells this scans; per column only the z range the grown segment covers in that column's
// x slab is scanned, so a long diagonal ray scans a thin band of cells, not its bounding rectangle.
// Returns FALSE (and nothing) if the grid can't answer: its records are inconsistent, or the scan
// would visit more than ctMaxCells cells. The caller then does what it would do without the grid.
BOOL SE1_FindEntitiesNearSegment(CWorld *pwo, const DOUBLE adO[3], const DOUBLE adDir[3],
  DOUBLE dT0, DOUBLE dT1, DOUBLE dGrow, INDEX ctMaxCells, CStaticStackArray<CEntity*> &apenFound)
{
  apenFound.PopAll();
  CCollisionGrid *pcg = pwo->wo_pcgCollisionGrid;
  if (pcg==NULL || pcg->cg_bInconsistent || !(dT0<=dT1) || !(dGrow>=0)) {
    return FALSE;
  }
  const DOUBLE dLimit = (GRID_MAX-2)*GRID_CELLSIZE;
  const DOUBLE dX0 = adO[0]+dT0*adDir[0], dX1 = adO[0]+dT1*adDir[0];
  const DOUBLE dZ0 = adO[2]+dT0*adDir[2], dZ1 = adO[2]+dT1*adDir[2];
  // a little more than dGrow, so that rounding in the slab arithmetic can only add cells
  const DOUBLE dG = dGrow*(1.0+1e-9)+1e-6;
  const DOUBLE dXLo = Min(dX0, dX1)-dG, dXHi = Max(dX0, dX1)+dG;
  const DOUBLE dZLo = Min(dZ0, dZ1)-dG, dZHi = Max(dZ0, dZ1)+dG;
  if (!(dXLo>-dLimit && dXHi<dLimit && dZLo>-dLimit && dZHi<dLimit)) {
    return FALSE;   // (also catches NaN)
  }
  const INDEX iX0 = INDEX(floor(dXLo/GRID_CELLSIZE)), iX1 = INDEX(floor(dXHi/GRID_CELLSIZE));
  // z cells of each column: those that a point within dG of the segment, with x in the column, can be in
  static CStaticStackArray<INDEX> aiZ;
  aiZ.PopAll();
  INDEX ctCells = 0;
  const BOOL bAlongZ = Abs(adDir[0])<1e-12;
  for (INDEX iX=iX0; iX<=iX1; iX++) {
    DOUBLE dTa = dT0, dTb = dT1;
    if (!bAlongZ) {
      const DOUBLE dTs = (iX*GRID_CELLSIZE-dG-adO[0])/adDir[0];
      const DOUBLE dTe = ((iX+1)*GRID_CELLSIZE+dG-adO[0])/adDir[0];
      dTa = Max(dT0, Min(dTs, dTe));
      dTb = Min(dT1, Max(dTs, dTe));
      // the slab arithmetic can round a touching column to empty; keep it as a point then
      if (dTa>dTb) {
        dTa = dTb = (dTa+dTb)*0.5;
      }
    }
    const DOUBLE dZa = adO[2]+dTa*adDir[2], dZb = adO[2]+dTb*adDir[2];
    const INDEX iZa = INDEX(floor((Min(dZa, dZb)-dG)/GRID_CELLSIZE));
    const INDEX iZb = INDEX(floor((Max(dZa, dZb)+dG)/GRID_CELLSIZE));
    aiZ.Push() = iZa;
    aiZ.Push() = iZb;
    ctCells += iZb-iZa+1;
    if (ctCells>ctMaxCells) {
      return FALSE;
    }
  }

  // each record once: a stamp per record index
  static std::vector<ULONG> aulStamp;
  static ULONG ulStamp = 0;
  // (the pool size: CAllocationArray::Count() is the number in use, and indices go past it)
  const INDEX ctRecords = pcg->cg_agoObjects.sa_Count;
  if ((INDEX)aulStamp.size()<ctRecords) {
    aulStamp.resize(ctRecords+256, 0);
  }
  if (++ulStamp==0) {
    std::fill(aulStamp.begin(), aulStamp.end(), 0);
    ulStamp = 1;
  }
  static CStaticStackArray<INDEX> aigo;
  aigo.PopAll();
  for (INDEX iX=iX0; iX<=iX1; iX++) {
    const INDEX iZa = aiZ[2*(iX-iX0)], iZb = aiZ[2*(iX-iX0)+1];
    for (INDEX iZ=iZa; iZ<=iZb; iZ++) {
      const INDEX igc = pcg->FindCell(iX, iZ, FALSE);
      if (igc<0) {
        continue;
      }
      for (INDEX iEntry = pcg->cg_agcCells[igc].gc_iFirstEntry; iEntry>=0;
          iEntry = pcg->cg_ageEntries[iEntry].ge_iNextEntry) {
        const INDEX igo = pcg->cg_ageEntries[iEntry].ge_iObject;
        if (aulStamp[igo]!=ulStamp) {
          aulStamp[igo] = ulStamp;
          aigo.Push() = igo;
        }
      }
    }
  }

  // keep those whose grown box meets the segment (slab test, in double, with the margin dG)
  for (INDEX i=0; i<aigo.Count(); i++) {
    const CGridObject &go = pcg->cg_agoObjects[aigo[i]];
    DOUBLE dTa = dT0, dTb = dT1;
    INDEX iAxis = 0;
    for (; iAxis<3; iAxis++) {
      const DOUBLE dLo = DOUBLE(go.go_box.Min()(iAxis+1))-dG;
      const DOUBLE dHi = DOUBLE(go.go_box.Max()(iAxis+1))+dG;
      const DOUBLE dO = adO[iAxis], dD = adDir[iAxis];
      if (Abs(dD)<1e-12) {
        // (nearly) parallel: the coordinate changes by at most 1e-12*|t| along the segment
        const DOUBLE dSlack = 1e-12*Max(Abs(dT0), Abs(dT1));
        if (!(dO+dSlack>=dLo && dO-dSlack<=dHi)) break;
        continue;
      }
      const DOUBLE dTs = (dLo-dO)/dD, dTe = (dHi-dO)/dD;
      dTa = Max(dTa, Min(dTs, dTe));
      dTb = Min(dTb, Max(dTs, dTe));
      // (a relative slack for the division: keeps boxes the segment just touches)
      if (!(dTa<=dTb+1e-9*(1.0+Abs(dTb)))) break;
    }
    if (iAxis==3) {
      apenFound.Push() = go.go_penEntity;
    }
  }
  return TRUE;
}
#endif

// get amount of memory used by this object
extern SLONG GetCollisionGridMemory( CCollisionGrid *pcg)
{
  // no collision grid?
  if( pcg==NULL) return 0;

  // phew, it's here!
  SLONG slUsedMemory = pcg->cg_aiFirstCells.Count() * sizeof(INDEX);
  slUsedMemory += pcg->cg_agcCells.Count()   * sizeof(CGridCell);
  slUsedMemory += pcg->cg_ageEntries.Count() * sizeof(CGridEntry);
  slUsedMemory += pcg->cg_agcCells.aa_aiFreeElements.sa_Count   * sizeof(INDEX);
  slUsedMemory += pcg->cg_ageEntries.aa_aiFreeElements.sa_Count * sizeof(INDEX);
  return slUsedMemory;
}
