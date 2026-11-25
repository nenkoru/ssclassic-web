/* GPU model animation (?gpuanim=0|1, console var mdl_bGpuAnim; WebGL2 replayer only).
 *
 * The CPU path (Models/RenderModel_View.cpp) unpacks and lerps every vertex of every model every
 * frame, shades it against the model light, builds a colour and texcoord per surface vertex and
 * draws each model with its own drawElements. With thousands of monsters that is most of the
 * engine worker's frame, and the vertex arena it fills is uploaded again by the main thread.
 *
 * Here a model's frames go to the GPU once (one RGBA16I texel per frame vertex: the compressed
 * position and the normal code), a mip once (per surface vertex: model vertex, surface, texcoord;
 * the elements), and per frame each model only adds a 112-byte instance record (frame bases, lerp
 * ratio, colour mask, modelview, stretch, model colour, light). The vertex shader (port/web/gfx.js,
 * GA_VS) does UnpackFrame + ShadesToColors + the diffuse colour setup with the same formulas.
 * Instances of the same mesh/texture are queued and drawn with one instanced draw per pass when the
 * model view ends, or earlier, before a model the CPU path draws with blending.
 *
 * Only the plain case is taken: an opaque mip (MMI_OPAQUE) whose diffuse surfaces are opaque or
 * alpha-tested, textured, without fog, haze, bump, detail, reflection or specular layers, outside
 * mirrors, no forced translucency, no wireframe/debug modes. Everything else returns FALSE and
 * renders on the CPU path as before. Simulation state is never touched. */
#include <Engine/Engine.h>
#include <Engine/Models/ModelObject.h>
#include <Engine/Models/ModelData.h>
#include <Engine/Models/RenderModel.h>
#include <Engine/Models/Model_internal.h>
#include <Engine/Models/Normals.h>
#include <Engine/Graphics/GfxLibrary.h>
#include <Engine/Graphics/Color.h>
#include <Engine/Graphics/Vertex.h>
#include <Engine/Math/Projection.h>
#include <Engine/Templates/StaticArray.cpp>
#include <emscripten.h>
#include <string.h>
#include <vector>
#include <unordered_map>

extern "C" {
void SE1_GL1Shim_GATables(const void *p, int len);
void SE1_GL1Shim_GAFrames(int h, const void *p, int len, int texW, int texH);
void SE1_GL1Shim_GAMesh(int h, int hFrames, const void *verts, int vertsLen, const void *idx, int idxLen);
void SE1_GL1Shim_GAFree(int h);
void *SE1_GL1Shim_GAAlloc(int n, int *off);
void SE1_GL1Shim_GADraw(int h, int instOff, int ctInst, int elemFirst, int ctElem, int flags,
                        const float *texCorr, const float *offset, int ctSrf, const uint32_t *srf);
}

extern const FLOAT *pfSinTable;
extern const FLOAT *pfCosTable;
extern INDEX mdl_bAllowOverbright;
extern INDEX mdl_bRenderBump;
extern INDEX mdl_bRenderDetail;
extern INDEX mdl_bRenderReflection;
extern INDEX mdl_bRenderSpecular;
extern INDEX mdl_bShowStrips;
extern INDEX mdl_bShowTriangles;
extern CAnyProjection3D _aprProjection;

INDEX mdl_bGpuAnim = 1;

#define GA_MAXSRF   64      // gfx.js GA_MAXSRF
#define GA_TEXW     2048
#define GA_MAXTEXH  2048    // WebGL2 guarantees 2048
#define GA_KEEP     8       // frames a blob stays alive after its upload (replays lag <= 2 batches)
#define GA_IDLE     600     // frames without use before a model's GPU copy is dropped

struct GARecord { ULONG u[28]; };   // 7 uvec4, gfx.js GA_REC

struct GAFrames {
  const void *pv; INDEX ctFrames, ctVx; BOOL b16;
  int h;                    // 0: not uploaded (or unsupported, bBad)
  BOOL bBad;
};
struct GAMesh {
  const void *pSrfToMip, *pMipToMdl, *pTex, *pEl;
  INDEX ctSrfVx, ctEl, ctMipVx;
  int h; BOOL bBad;
  INDEX ctSrf, ctElem;      // drawn surface prefix and its elements
  BOOL bDoubleSided;
};
struct GAModel {
  GAFrames fr;
  GAMesh mesh[MAX_MODELMIPS];
  INDEX iLastUsed;
};
struct GABatch {
  CModelData *md; GAModel *pgm; INDEX iMip;
  CTextureData *ptd; INDEX iTexFrame; BOOL bInverted, bOverbright;
  std::vector<GARecord> recs;
};

static int _iState = 0;      // 0: not initialised, 1: on, -1: unavailable (not WebGL2)
static int _hNext = 1;
static std::unordered_map<CModelData*, GAModel*> _models;
static std::vector<GABatch> _batches;
static INDEX _ctBatches = 0;  // used entries of _batches
static INDEX _iLastBatch = -1;
struct GABlob { void *p; INDEX iFrame; };
static std::vector<GABlob> _blobs;
static INDEX _iHouseFrame = -1;
static FLOAT _afTables[256 * 2 * 4];

static void KeepBlob(void *p) { GABlob b = { p, _pGfx->gl_iFrameNumber }; _blobs.push_back(b); }

static BOOL Init(void)
{
  if (_iState != 0) return _iState > 0;
  const int i = MAIN_THREAD_EM_ASM_INT({
    var g = Module['se1gfx'];
    if (!g || g.backend !== 'webgl2') return -2;
    return Module['se1GpuAnim'] === undefined ? -1 : Module['se1GpuAnim'];
  });
  _pShell->DeclareSymbol("user INDEX mdl_bGpuAnim;", &mdl_bGpuAnim);
  if (i == -2) { _iState = -1; return FALSE; }
  if (i >= 0) mdl_bGpuAnim = i;
  // normal tables: row 0 (sin, cos) of the 16-bit normal codes, row 1 the gouraud normals
  for (INDEX j = 0; j < 256; j++) {
    FLOAT *p = &_afTables[j * 4];
    p[0] = pfSinTable[j]; p[1] = pfCosTable[j]; p[2] = 0; p[3] = 0;
    FLOAT *q = &_afTables[(256 + j) * 4];
    q[0] = avGouraudNormals[j](1); q[1] = avGouraudNormals[j](2); q[2] = avGouraudNormals[j](3); q[3] = 0;
  }
  SE1_GL1Shim_GATables(_afTables, sizeof(_afTables));
  _iState = 1;
  return TRUE;
}

static void FreeModel(GAModel *pgm)
{
  for (INDEX i = 0; i < MAX_MODELMIPS; i++) if (pgm->mesh[i].h) SE1_GL1Shim_GAFree(pgm->mesh[i].h);
  if (pgm->fr.h) SE1_GL1Shim_GAFree(pgm->fr.h);
  delete pgm;
}

// the model data is being cleared or freed (Models/Model.cpp CModelData::Clear): drop its GPU copy
// and any queued instances, so data loaded later at the same address never draws stale frames
void SE1_GpuAnim_Forget(CModelData *md)
{
  for (INDEX i = 0; i < _ctBatches; i++) {
    GABatch &b = _batches[i];
    if (b.md == md) { b.recs.clear(); b.md = NULL; b.pgm = NULL; }
  }
  if (_iLastBatch >= 0 && _iLastBatch < _ctBatches && _batches[_iLastBatch].md == NULL) _iLastBatch = -1;
  auto it = _models.find(md);
  if (it == _models.end()) return;
  if (it->second) FreeModel(it->second);
  _models.erase(it);
}

// once a frame: free uploaded blobs the replayer is done with, drop models not drawn for a while
static void Housekeeping(void)
{
  const INDEX iFrame = _pGfx->gl_iFrameNumber;
  if (iFrame == _iHouseFrame) return;
  _iHouseFrame = iFrame;
  size_t j = 0;
  for (size_t i = 0; i < _blobs.size(); i++) {
    if (iFrame - _blobs[i].iFrame > GA_KEEP || iFrame < _blobs[i].iFrame) free(_blobs[i].p);
    else _blobs[j++] = _blobs[i];
  }
  _blobs.resize(j);
  if ((iFrame & 63) == 0) {
    for (auto it = _models.begin(); it != _models.end(); ) {
      if (iFrame - it->second->iLastUsed > GA_IDLE) { FreeModel(it->second); it = _models.erase(it); }
      else ++it;
    }
  }
}

// frames texture of a model (uploaded on first use, again if the frame data changed)
static BOOL PrepareFrames(CModelData *md, GAModel *pgm)
{
  GAFrames &fr = pgm->fr;
  const BOOL b16 = (md->md_Flags & MF_COMPRESSED_16BIT) != 0;
  const INDEX ctFrames = md->md_FramesCt, ctVx = md->md_VerticesCt;
  const void *pv = NULL;
  if (b16) { if (md->md_FrameVertices16.Count() > 0) pv = &md->md_FrameVertices16[0]; }
  else     { if (md->md_FrameVertices8.Count()  > 0) pv = &md->md_FrameVertices8[0]; }
  if (fr.pv == pv && fr.ctFrames == ctFrames && fr.ctVx == ctVx && fr.b16 == b16 && (fr.h || fr.bBad)) return !fr.bBad;
  // (re)build: meshes refer to the frames handle, so they go too
  for (INDEX i = 0; i < MAX_MODELMIPS; i++) {
    if (pgm->mesh[i].h) SE1_GL1Shim_GAFree(pgm->mesh[i].h);
    memset(&pgm->mesh[i], 0, sizeof(GAMesh));
  }
  if (fr.h) SE1_GL1Shim_GAFree(fr.h);
  fr.pv = pv; fr.ctFrames = ctFrames; fr.ctVx = ctVx; fr.b16 = b16; fr.h = 0; fr.bBad = FALSE;
  const SLONG ctTexels = ctFrames * ctVx;
  if (pv == NULL || ctTexels <= 0 || ctVx > 65535) { fr.bBad = TRUE; return FALSE; }
  const INDEX w = ctTexels < GA_TEXW ? ctTexels : GA_TEXW;
  const INDEX h = (ctTexels + w - 1) / w;
  if (h > GA_MAXTEXH) { fr.bBad = TRUE; return FALSE; }
  SWORD *pTex = (SWORD*)calloc((size_t)w * h, 8);
  if (pTex == NULL) { fr.bBad = TRUE; return FALSE; }
  if (b16) {
    const ModelFrameVertex16 *pf = (const ModelFrameVertex16 *)pv;
    for (SLONG i = 0; i < ctTexels; i++) {
      SWORD *t = &pTex[i * 4];
      t[0] = pf[i].mfv_SWPoint(1); t[1] = pf[i].mfv_SWPoint(2); t[2] = pf[i].mfv_SWPoint(3);
      t[3] = (SWORD)(UWORD)(pf[i].mfv_ubNormH | (pf[i].mfv_ubNormP << 8));
    }
  } else {
    const ModelFrameVertex8 *pf = (const ModelFrameVertex8 *)pv;
    for (SLONG i = 0; i < ctTexels; i++) {
      SWORD *t = &pTex[i * 4];
      t[0] = pf[i].mfv_SBPoint(1); t[1] = pf[i].mfv_SBPoint(2); t[2] = pf[i].mfv_SBPoint(3);
      t[3] = pf[i].mfv_NormIndex;
    }
  }
  fr.h = _hNext++;
  SE1_GL1Shim_GAFrames(fr.h, pTex, w * h * 8, w, h);
  KeepBlob(pTex);
  return TRUE;
}

// static mesh of one mip (uploaded on first use, again if the mip was rebuilt)
static GAMesh *PrepareMesh(GAModel *pgm, INDEX iMip, ModelMipInfo &mmi)
{
  GAMesh &me = pgm->mesh[iMip];
  const INDEX ctSrfVx = mmi.mmpi_ctSrfVx, ctEl = mmi.mmpi_aiElements.Count(), ctMipVx = mmi.mmpi_ctMipVx;
  const void *pSrfToMip = mmi.mmpi_auwSrfToMip.Count() ? (const void*)&mmi.mmpi_auwSrfToMip[0] : NULL;
  const void *pMipToMdl = mmi.mmpi_auwMipToMdl.Count() ? (const void*)&mmi.mmpi_auwMipToMdl[0] : NULL;
  const void *pTex = mmi.mmpi_avmexTexCoord.Count() ? (const void*)&mmi.mmpi_avmexTexCoord[0] : NULL;
  const void *pEl = ctEl ? (const void*)&mmi.mmpi_aiElements[0] : NULL;
  if (me.pSrfToMip == pSrfToMip && me.pMipToMdl == pMipToMdl && me.pTex == pTex && me.pEl == pEl &&
      me.ctSrfVx == ctSrfVx && me.ctEl == ctEl && me.ctMipVx == ctMipVx && (me.h || me.bBad)) {
    return me.bBad ? NULL : &me;
  }
  if (me.h) SE1_GL1Shim_GAFree(me.h);
  memset(&me, 0, sizeof(me));
  me.pSrfToMip = pSrfToMip; me.pMipToMdl = pMipToMdl; me.pTex = pTex; me.pEl = pEl;
  me.ctSrfVx = ctSrfVx; me.ctEl = ctEl; me.ctMipVx = ctMipVx;
  if (!pSrfToMip || !pMipToMdl || !pTex || !pEl || ctSrfVx <= 0) { me.bBad = TRUE; return NULL; }
  // surface prefix the CPU path draws (it stops at the first invisible or empty surface)
  INDEX ctSrf = 0, ctElem = 0;
  const INDEX ctAllSrf = mmi.mmpi_MappingSurfaces.Count();
  for (; ctSrf < ctAllSrf; ctSrf++) {
    const MappingSurface &ms = mmi.mmpi_MappingSurfaces[ctSrf];
    if ((ms.ms_ulRenderingFlags & SRF_INVISIBLE) || ms.ms_ctSrfVx == 0) break;
    ctElem += ms.ms_ctSrfEl;
  }
  if (ctSrf == 0 || ctSrf > GA_MAXSRF || ctElem <= 0 || ctElem > ctEl) { me.bBad = TRUE; return NULL; }
  ULONG *pul = (ULONG*)calloc((size_t)ctSrfVx, 16);
  ULONG *pel = (ULONG*)malloc((size_t)ctElem * 4);
  if (!pul || !pel) { free(pul); free(pel); me.bBad = TRUE; return NULL; }
  for (INDEX iSrf = 0; iSrf < ctSrf; iSrf++) {
    const MappingSurface &ms = mmi.mmpi_MappingSurfaces[iSrf];
    for (INDEX i = ms.ms_iSrfVx0; i < ms.ms_iSrfVx0 + ms.ms_ctSrfVx && i < ctSrfVx; i++) {
      const UWORD uwMip = mmi.mmpi_auwSrfToMip[i];
      const ULONG ulMdl = uwMip < ctMipVx ? mmi.mmpi_auwMipToMdl[uwMip] : 0;
      const FLOAT2D &mex = mmi.mmpi_avmexTexCoord[i];
      FLOAT fU = mex(1), fV = mex(2);
      pul[i * 4 + 0] = ulMdl | ((ULONG)iSrf << 16);
      memcpy(&pul[i * 4 + 1], &fU, 4);
      memcpy(&pul[i * 4 + 2], &fV, 4);
    }
  }
  for (INDEX i = 0; i < ctElem; i++) {
    const INDEX iEl = mmi.mmpi_aiElements[i];
    if (iEl < 0 || iEl >= ctSrfVx) { free(pul); free(pel); me.bBad = TRUE; return NULL; }
    pel[i] = (ULONG)iEl;
  }
  me.ctSrf = ctSrf; me.ctElem = ctElem;
  me.bDoubleSided = (mmi.mmpi_ulLayerFlags & SRF_DOUBLESIDED) != 0;
  me.h = _hNext++;
  SE1_GL1Shim_GAMesh(me.h, pgm->fr.h, pul, ctSrfVx * 16, pel, ctElem * 4);
  KeepBlob(pul); KeepBlob(pel);
  return &me;
}

static inline ULONG FBits(FLOAT f) { ULONG ul; memcpy(&ul, &f, 4); return ul; }

// draw every queued instance; leaves the GL state as the CPU path leaves it after a model
void GpuAnim_Flush(void)
{
  if (_ctBatches == 0) return;
  for (INDEX iBatch = 0; iBatch < _ctBatches; iBatch++) {
    GABatch &b = _batches[iBatch];
    const INDEX ctInst = (INDEX)b.recs.size();
    if (ctInst == 0) continue;
    ModelMipInfo &mmi = b.md->md_MipInfos[b.iMip];
    GAMesh &me = b.pgm->mesh[b.iMip];
    // per-surface table: colour, flags (1 diffuse layer, 2 double sided, 4 fullbright,
    // 8 alpha tested), on and off colour masks
    uint32_t aSrf[GA_MAXSRF * 4];
    for (INDEX iSrf = 0; iSrf < me.ctSrf; iSrf++) {
      const MappingSurface &ms = mmi.mmpi_MappingSurfaces[iSrf];
      const ULONG ulFlags = ms.ms_ulRenderingFlags;
      GFXColor col(AdjustColor(ms.ms_colDiffuse, _slTexHueShift, _slTexSaturation));
      aSrf[iSrf * 4 + 0] = col.ul.abgr;
      aSrf[iSrf * 4 + 1] = ((ulFlags & SRF_DIFFUSE) ? 1 : 0) | ((ulFlags & SRF_DOUBLESIDED) ? 2 : 0)
                         | (ms.ms_sstShadingType == SST_FULLBRIGHT ? 4 : 0)
                         | (ms.ms_sttTranslucencyType == STT_TRANSPARENT ? 8 : 0);
      aSrf[iSrf * 4 + 2] = ms.ms_ulOnColor;
      aSrf[iSrf * 4 + 3] = ms.ms_ulOffColor;
    }
    const FLOAT afTexCorr[2] = { 1.0f / b.ptd->GetWidth(), 1.0f / b.ptd->GetHeight() };
    const FLOAT3D &vOff = b.md->md_vCompressedCenter;
    const FLOAT afOff[3] = { vOff(1), vOff(2), vOff(3) };
    // state of SetRenderingParameters(STT_OPAQUE) / (STT_TRANSPARENT): the alpha test is per surface in the shader
    gfxEnableDepthTest();
    gfxDepthFunc(GFX_LESS_EQUAL);
    gfxEnableDepthWrite();
    gfxDisableBlend();
    gfxDisableAlphaTest();
    gfxFrontFace(b.bInverted ? GFX_CW : GFX_CCW);
    gfxSetTextureWrapping(GFX_REPEAT, GFX_REPEAT);
    b.ptd->SetAsCurrent(b.iTexFrame);
    // instance records last: a texture upload above may flush the batch (single-threaded build)
    int iOff = 0;
    void *pInst = SE1_GL1Shim_GAAlloc(ctInst * (int)sizeof(GARecord), &iOff);
    memcpy(pInst, &b.recs[0], ctInst * sizeof(GARecord));
    const int iFlags = (b.md->md_Flags & MF_COMPRESSED_16BIT ? 1 : 0) | (b.bOverbright ? 2 : 0);
    if (me.bDoubleSided) {
      gfxCullFace(GFX_FRONT);
      SE1_GL1Shim_GADraw(me.h, iOff, ctInst, 0, me.ctElem, iFlags | 4, afTexCorr, afOff, me.ctSrf, aSrf);
    }
    gfxCullFace(GFX_BACK);
    SE1_GL1Shim_GADraw(me.h, iOff, ctInst, 0, me.ctElem, iFlags, afTexCorr, afOff, me.ctSrf, aSrf);
    b.recs.clear();
  }
  _ctBatches = 0;
  _iLastBatch = -1;
  // what RenderModel_View leaves behind
  gfxDepthFunc(GFX_LESS_EQUAL);
  gfxDisableDepthWrite();
  gfxDisableAlphaTest();
  gfxEnableBlend();
  gfxCullFace(GFX_BACK);
}

// TRUE: the model is queued for the GPU path; FALSE: render it on the CPU path (queued models
// are drawn first if this one blends, so translucent pixels land on top of them)
BOOL GpuAnim_RenderModel(CModelObject &mo, CRenderModel &rm)
{
  if (!Init()) return FALSE;
  ModelMipInfo &mmi = *rm.rm_pmmiMip;
  const BOOL bForceTrans = ((rm.rm_colBlend & CT_AMASK) >> CT_ASHIFT) != CT_OPAQUE;
  const ULONG ulLayers = mmi.mmpi_ulLayerFlags;
  const BOOL bBlends = bForceTrans || !(ulLayers & MMI_OPAQUE);
  BOOL bOK = mdl_bGpuAnim && !bBlends && _pGfx->gl_eCurrentAPI == GAT_OGL;
  if (bOK) {
    const ULONG rt = rm.rm_rtRenderType;
    CTextureData *ptdDiff = (CTextureData *)mo.mo_toTexture.GetData();
    const BOOL bBump = mo.mo_toBump.GetData() != NULL;
    if (ptdDiff == NULL || !(ulLayers & SRF_DIFFUSE)
     || !(rt & RT_TEXTURE) || (rt & (RT_WHITE_TEXTURE | RT_NO_POLYGON_FILL | RT_WIRE_ON | RT_HIDDEN_LINES))
     || (rm.rm_ulFlags & (RMF_FOG | RMF_HAZE))
     || _pGfx->gl_iTessellationLevel > 0
     || mdl_bShowStrips || mdl_bShowTriangles
     || _aprProjection->pr_bMirror || _aprProjection->pr_bWarp
     || ((ulLayers & SRF_BUMP) && mdl_bRenderBump && bBump)
     || ((ulLayers & SRF_DETAIL) && mdl_bRenderDetail && bBump)
     || ((ulLayers & SRF_REFLECTIONS) && mdl_bRenderReflection && mo.mo_toReflection.GetData() != NULL)
     || ((ulLayers & SRF_SPECULAR) && mdl_bRenderSpecular && mo.mo_toSpecular.GetData() != NULL)) {
      bOK = FALSE;
    }
  }
  if (!bOK) {
    if (bBlends) GpuAnim_Flush();
    return FALSE;
  }
  Housekeeping();
  CModelData *md = rm.rm_pmdModelData;
  const INDEX iMip = (INDEX)(rm.rm_pmmiMip - &md->md_MipInfos[0]);
  if (iMip < 0 || iMip >= MAX_MODELMIPS) return FALSE;
  GAModel *&pgm = _models[md];
  if (pgm == NULL) { pgm = new GAModel; memset(pgm, 0, sizeof(GAModel)); }
  pgm->iLastUsed = _pGfx->gl_iFrameNumber;
  if (!PrepareFrames(md, pgm)) return FALSE;
  GAMesh *pme = PrepareMesh(pgm, iMip, mmi);
  if (pme == NULL) return FALSE;
  // every drawn diffuse surface must be opaque or alpha tested (others need blending)
  for (INDEX iSrf = 0; iSrf < pme->ctSrf; iSrf++) {
    const MappingSurface &ms = mmi.mmpi_MappingSurfaces[iSrf];
    if (!(ms.ms_ulRenderingFlags & SRF_DIFFUSE)) continue;
    const SurfaceTranslucencyType stt = ms.ms_sttTranslucencyType;
    if (stt != STT_OPAQUE && stt != STT_TRANSPARENT) { GpuAnim_Flush(); return FALSE; }
  }

  // batch of this mesh + texture
  CTextureData *ptd = (CTextureData *)mo.mo_toTexture.GetData();
  const INDEX iTexFrame = mo.mo_toTexture.GetFrame();
  const BOOL bInverted = (rm.rm_ulFlags & RMF_INVERTED) != 0;
  const BOOL bOverbright = mdl_bAllowOverbright && _pGfx->gl_ctTextureUnits > 1;
  GABatch *pb = NULL;
  if (_iLastBatch >= 0) {
    GABatch &b = _batches[_iLastBatch];
    if (b.md == md && b.iMip == iMip && b.ptd == ptd && b.iTexFrame == iTexFrame && b.bInverted == bInverted && b.bOverbright == bOverbright) pb = &b;
  }
  if (pb == NULL) {
    for (INDEX i = 0; i < _ctBatches; i++) {
      GABatch &b = _batches[i];
      if (b.md == md && b.iMip == iMip && b.ptd == ptd && b.iTexFrame == iTexFrame && b.bInverted == bInverted && b.bOverbright == bOverbright) {
        pb = &b; _iLastBatch = i; break;
      }
    }
  }
  if (pb == NULL) {
    if ((size_t)_ctBatches == _batches.size()) _batches.push_back(GABatch());
    _iLastBatch = _ctBatches++;
    pb = &_batches[_iLastBatch];
    pb->md = md; pb->pgm = pgm; pb->iMip = iMip; pb->ptd = ptd; pb->iTexFrame = iTexFrame;
    pb->bInverted = bInverted; pb->bOverbright = bOverbright;
    pb->recs.clear();
  }

  // instance record: the per-model inputs of UnpackFrame / ShadesToColors / the diffuse colour
  pb->recs.push_back(GARecord());
  ULONG *u = pb->recs.back().u;
  const INDEX ctVx = md->md_VerticesCt;
  u[0] = (ULONG)(rm.rm_iFrame0 * ctVx);
  u[1] = (ULONG)(rm.rm_iFrame1 * ctVx);
  u[2] = FBits(rm.rm_fRatio);
  u[3] = mo.mo_ColorMask;
  const FLOATmatrix3D &m = rm.rm_mObjectToView;
  const FLOAT3D &v = rm.rm_vObjectToView;
  for (INDEX r = 1; r <= 3; r++) {
    u[4 * r + 0] = FBits(m(r, 1)); u[4 * r + 1] = FBits(m(r, 2));
    u[4 * r + 2] = FBits(m(r, 3)); u[4 * r + 3] = FBits(v(r));
  }
  u[16] = FBits(rm.rm_vStretch(1)); u[17] = FBits(rm.rm_vStretch(2)); u[18] = FBits(rm.rm_vStretch(3));
  GFXColor colMdlDiff;
  colMdlDiff.MultiplyRGBA(AdjustColor(md->md_colDiffuse, _slTexHueShift, _slTexSaturation),
                          AdjustColor(rm.rm_colBlend, _slTexHueShift, _slTexSaturation));
  u[19] = colMdlDiff.ul.abgr;
  u[20] = FBits(rm.rm_vLightObj(1) * -255.0f);
  u[21] = FBits(rm.rm_vLightObj(2) * -255.0f);
  u[22] = FBits(rm.rm_vLightObj(3) * -255.0f);
  const COLOR colL = AdjustColor(rm.rm_colLight, _slShdHueShift, _slShdSaturation);
  const COLOR colA = AdjustColor(rm.rm_colAmbient, _slShdHueShift, _slShdSaturation);
  const INDEX iBright = bOverbright ? 0 : 1;
  const SLONG slLR = (colL & CT_RMASK) >> (CT_RSHIFT - iBright);
  const SLONG slLG = (colL & CT_GMASK) >> (CT_GSHIFT - iBright);
  const SLONG slLB = (colL & CT_BMASK) >> (CT_BSHIFT - iBright);
  SLONG slAR = (colA & CT_RMASK) >> (CT_RSHIFT - iBright);
  SLONG slAG = (colA & CT_GMASK) >> (CT_GSHIFT - iBright);
  SLONG slAB = (colA & CT_BMASK) >> (CT_BSHIFT - iBright);
  if (bOverbright) { slAR = ClampUp(slAR, (SLONG)127); slAG = ClampUp(slAG, (SLONG)127); slAB = ClampUp(slAB, (SLONG)127); }
  u[23] = (ULONG)slLR | ((ULONG)slLG << 10) | ((ULONG)slLB << 20);
  u[24] = (ULONG)slAR | ((ULONG)slAG << 10) | ((ULONG)slAB << 20);
  u[25] = u[26] = u[27] = 0;
  _pGfx->gl_ctModelTriangles += pme->ctElem / 3;
  return TRUE;
}
