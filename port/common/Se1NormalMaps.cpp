// Normal-mapped lighting for brush polygons (WebGL2 only).
//
// The engine lights brushes with baked light maps (shadow maps), which carry no light direction,
// so a normal map has nothing to shade against. This file adds a second texture next to each
// shadow map: per light-map texel, the direction the static light arrives from and how
// directional it is.
//   RGB = dominant light direction in the shadow map's frame (StepU, StepV, plane normal), *0.5+0.5
//   A   = directionality: |sum of w*L| / max(texel brightness, sum of w). Ambient, GI and
//         clamping lower it, so a flat-lit wall gets no normal-map shading.
// The direction is recomputed from the same layers LayerMixer mixes (static point and
// directional lights, with their shadow masks).
//
// Base textures with an HD normal map (`<name>_nh.tex` next to them, from tools/hdtex.py:
// RGB = tangent-space normal, A = height) get it uploaded alongside. gl1shim.c binds the pair to
// texture units 4 and 5 when a draw has a base texture on unit 0 and the shadow map on a
// COMBINE-MODULATE unit, and its shader scales the shadow by
//   f = (1-k) + k * max(dot(n, l), 0) / max(l.z, 0.25)
// which is 1 for a flat normal.
//
// Console: gfx_bNormalMaps (set before a level loads; NM_Refresh() re-mixes the light maps),
// gfx_fNormalStrength (2: the PBRify maps are flat, mean n.z 0.97), gfx_fNormalMaxBoost,
// gfx_fNormalFlipY (+1: green points along +v, image rows down, as PBRify writes it; -1 flips).
// Page: ?nm=1 (port/web/pre.js). Hooks: Graphics/Texture.cpp, Light/LayerMixer.cpp,
// Graphics/ShadowMap.cpp (all __EMSCRIPTEN__).

#include <Engine/Engine.h>
#include <Engine/Brushes/Brush.h>
#include <Engine/Brushes/BrushArchive.h>
#include <Engine/World/World.h>
#include <Engine/Network/Network.h>
#include <Engine/Entities/Entity.h>
#include <Engine/Graphics/ShadowMap.h>
#include <Engine/Graphics/Texture.h>
#include <Engine/Graphics/GfxLibrary.h>
#include <Engine/Light/LightSource.h>
#include <Engine/Templates/Stock_CTextureData.h>
#include <Engine/Templates/DynamicArray.cpp>
#include <Engine/Templates/StaticArray.cpp>
#include <Engine/Templates/DynamicContainer.cpp>
#include <emscripten.h>
#include <math.h>
#include <vector>
#include <unordered_map>

// read by gl1shim.c each draw
extern "C" {
INDEX gfx_bNormalMaps = 0;
FLOAT gfx_fNormalStrength = 2.0f;
FLOAT gfx_fNormalFlipY = 1.0f;
FLOAT gfx_fNormalMaxBoost = 2.5f;
void SE1_GL1Shim_SetCompanion(unsigned int tex, unsigned int companion);
}

static INDEX _ctNormalMaps = 0;      // HD normal maps loaded
INDEX gfx_bNormalMapsVerbose = 0;     // log each texture checked for a normal map
static INDEX _ctDirMaps = 0;         // direction maps uploaded
static double _tmDirs = 0;           // ms spent computing directions

struct DirMap {
  std::vector<ULONG> aul;   // same layout as sm_pulCachedShadowMap
  ULONG ulObject = NONE;    // GL texture
  ULONG ulCompanionOf = NONE;
  PIX pixUploadW = 0, pixUploadH = 0;
  BOOL bDirty = FALSE;
};
static std::unordered_map<CShadowMap *, DirMap> _dirs;

static const ULONG NEUTRAL = 0x00FF8080;   // bytes R=128 G=128 B=255 A=0: straight out, not directional

// ---------- base textures: attach the HD normal map ----------

static void Attach(CTextureData *ptd, const CTFileName &fn)
{
  const CTString strBase = fn.FileName();
  const size_t len = strlen(strBase.str_String);
  if (len >= 3 && strcasecmp(strBase.str_String + len - 3, "_nh") == 0) return;
  const CTFileName fnNH = fn.NoExt() + "_nh.tex";
  const BOOL bExists = FileExists(fnNH);
  if (gfx_bNormalMapsVerbose) CPrintF("NM: %s -> %s\n", (const char *)fnNH, bExists ? "found" : "none");
  if (!bExists) return;
  CTextureData *pnh = NULL;
  try {
    pnh = _pTextureStock->Obtain_t(fnNH);
  } catch (char *strError) {
    CPrintF("NM: %s\n", strError);
    return;
  }
  // a constant texture is never probed or LOD-biased: it uploads in full on this one bind
  pnh->td_ulFlags |= TEX_CONSTANT | TEX_KEEPCOLOR;
  pnh->SetAsCurrent();
  const ULONG ulNH = pnh->td_ctFrames > 1 ? pnh->td_pulObjects[0] : pnh->td_ulObject;
  if (ulNH == NONE) return;
  if (ptd->td_ctFrames > 1) {
    if (ptd->td_pulObjects != NULL)
      for (INDEX i = 0; i < ptd->td_ctFrames; i++) SE1_GL1Shim_SetCompanion(ptd->td_pulObjects[i], ulNH);
  } else if (ptd->td_ulObject != NONE) {
    SE1_GL1Shim_SetCompanion(ptd->td_ulObject, ulNH);
  }
  if (ptd->td_ulProbeObject != NONE) SE1_GL1Shim_SetCompanion(ptd->td_ulProbeObject, ulNH);
  _ctNormalMaps++;
}

// A texture loading from a file gets its GL objects inside Read_t, before CSerial::Load_t stores
// its file name: those wait here until a later hook call, when the name is known.
static std::vector<CTextureData *> _ptdPending;

static void AttachPending(void)
{
  if (_ptdPending.empty()) return;
  std::vector<CTextureData *> ptds;
  ptds.swap(_ptdPending);
  for (CTextureData *ptd : ptds) {
    if (!_pTextureStock->st_ctObjects.IsMember(ptd)) continue;   // freed meanwhile, or not from the stock
    const CTFileName fn = ptd->GetName();
    if (fn == "") continue;   // never named (made in memory): nothing to look up
    Attach(ptd, fn);
  }
}

// Graphics/Texture.cpp CTextureData::SetAsCurrent, right after the GL objects are generated
void SE1NM_TextureCreated(CTextureData *ptd)
{
  if (!gfx_bNormalMaps || ptd->td_ptegEffect != NULL) return;
  AttachPending();
  const CTFileName fn = ptd->GetName();
  if (fn == "") { _ptdPending.push_back(ptd); return; }
  Attach(ptd, fn);
}

// ---------- light maps: the direction map ----------

static inline FLOAT Lum(COLOR col)
{
  UBYTE r, g, b; ColorToRGB(col, r, g, b);
  return 0.30f * r + 0.59f * g + 0.11f * b;
}

// Light/LayerMixer.cpp MixOneMipmap, after the static layers and baked GI are mixed into pul
void SE1NM_MixDirections(CBrushShadowMap *pbsm, INDEX iMip, ULONG *pul, PIX pixPolyU, PIX pixPolyV,
                         PIX pixCanvasU, PIX pixCanvasV, const FLOAT3D &vO, const FLOAT3D &vStepU,
                         const FLOAT3D &vStepV)
{
  if (!gfx_bNormalMaps || pbsm->sm_pulCachedShadowMap == NULL) return;
  const SLONG slTexels = pbsm->sm_slMemoryUsed / BYTES_PER_TEXEL;
  const SLONG slOff = (SLONG)(pul - pbsm->sm_pulCachedShadowMap);
  if (slOff < 0 || slOff + pixCanvasU * pixCanvasV > slTexels) return;   // not the static map
  const double tmStart = emscripten_get_now();

  DirMap &dm = _dirs[pbsm];
  if ((SLONG)dm.aul.size() != slTexels) dm.aul.assign(slTexels, NEUTRAL);
  ULONG *pulDir = &dm.aul[slOff];
  for (SLONG i = 0; i < pixCanvasU * pixCanvasV; i++) pulDir[i] = NEUTRAL;
  dm.bDirty = TRUE;

  CBrushPolygon *pbpo = pbsm->GetBrushPolygon();
  const FLOATplane3D &pl = pbpo->bpo_pbplPlane->bpl_plAbsolute;
  const FLOAT3D vN = (FLOAT3D &)pl;
  const FLOAT fLU = vStepU.Length(), fLV = vStepV.Length();
  if (fLU <= 0 || fLV <= 0) return;
  const FLOAT3D vSU = vStepU / fLU, vSV = vStepV / fLV;
  const INDEX iMipShift = iMip - pbsm->sm_iFirstMipLevel;
  const ULONG ulPolyFlags = pbpo->bpo_ulFlags;

  // per texel: sum of w*L (world) and of w
  const PIX ctTex = pixPolyU * pixPolyV;
  std::vector<FLOAT> af(ctTex * 4, 0.0f);

  FOREACHINLIST(CBrushShadowLayer, bsl_lnInShadowMap, pbsm->bsm_lhLayers, itbsl) {
    CBrushShadowLayer &bsl = *itbsl;
    CLightSource *pls = bsl.bsl_plsLightSource;
    if (pls == NULL || pls->ls_penEntity == NULL) continue;
    const ULONG ulLF = pls->ls_ulFlags;
    if (ulLF & (LSF_DYNAMIC | LSF_DARKLIGHT | LSF_LENSFLAREONLY)) continue;
    const UBYTE *pubMask = NULL;
    SLONG slBit0 = 0;
    if (bsl.bsl_pubLayer != NULL) {
      MipmapTable mmt;
      MakeMipmapTable(bsl.bsl_pixSizeU, bsl.bsl_pixSizeV, mmt);
      pubMask = bsl.bsl_pubLayer;
      slBit0 = mmt.mmt_aslOffsets[iMipShift];
    } else if ((bsl.bsl_ulFlags & BSLF_CALCULATED) && !(bsl.bsl_ulFlags & BSLF_ALLLIGHT)) {
      continue;   // all dark
    }
    const FLOAT fCol = Lum(pls->GetLightColor());
    if (fCol <= 0.0f) continue;
    const PIX pixSizeU = bsl.bsl_pixSizeU >> iMipShift, pixSizeV = bsl.bsl_pixSizeV >> iMipShift;
    if (pixSizeU <= 0 || pixSizeV <= 0) continue;
    const PIX pixMinU = bsl.bsl_pixMinU >> iMipShift, pixMinV = bsl.bsl_pixMinV >> iMipShift;
    const PIX pixU1 = Min(pixMinU + pixSizeU, pixPolyU), pixV1 = Min(pixMinV + pixSizeV, pixPolyV);
    const CPlacement3D &plLight = pls->ls_penEntity->GetPlacement();

    if (ulLF & LSF_DIRECTIONAL) {
      if (!(ulPolyFlags & BPOF_HASDIRECTIONALLIGHT)) continue;
      FLOAT3D vDir;
      AnglesToDirectionVector(plLight.pl_OrientationAngle, vDir);
      FLOAT fI = 1.0f;
      if (!(ulPolyFlags & BPOF_NOPLANEDIFFUSION)) fI = ClampDn(-(pl % vDir), 0.0f);
      const FLOAT w = fI * fCol;
      if (w <= 0.0f) continue;
      const FLOAT3D vL = -vDir;
      for (PIX v = pixMinV; v < pixV1; v++) for (PIX u = pixMinU; u < pixU1; u++) {
        if (pubMask != NULL) {
          const SLONG b = slBit0 + (v - pixMinV) * pixSizeU + (u - pixMinU);
          if (!(pubMask[b >> 3] & (1 << (b & 7)))) continue;
        }
        FLOAT *p = &af[(v * pixPolyU + u) * 4];
        p[0] += vL(1) * w; p[1] += vL(2) * w; p[2] += vL(3) * w; p[3] += w;
      }
    } else {
      const FLOAT3D &vLight = plLight.pl_PositionVector;
      const FLOAT fF = pls->ls_rFallOff, fH = Min(pls->ls_rHotSpot, fF * 0.999f);
      if (fF <= 0) continue;
      const BOOL bDiffusion = (ulLF & LSF_DIFFUSION) && !(ulPolyFlags & BPOF_NOPLANEDIFFUSION);
      const FLOAT fD = pl.PointDistance(vLight);
      for (PIX v = pixMinV; v < pixV1; v++) for (PIX u = pixMinU; u < pixU1; u++) {
        if (pubMask != NULL) {
          const SLONG b = slBit0 + (v - pixMinV) * pixSizeU + (u - pixMinU);
          if (!(pubMask[b >> 3] & (1 << (b & 7)))) continue;
        }
        FLOAT3D vL = vLight - (vO + vStepU * (FLOAT)u + vStepV * (FLOAT)v);
        const FLOAT fL = vL.Length();
        if (fL >= fF || fL <= 1e-4f) continue;
        // LayerMixer's falloff: full inside the hot spot, then ~1/L down to 0 at the falloff
        FLOAT fI = fL <= fH ? 1.0f : (fF / fL - 1.0f) / (fF / Max(fH, 1e-3f) - 1.0f);
        fI = Clamp(fI, 0.0f, 1.0f);
        if (bDiffusion) fI *= ClampDn(fD / fL, 0.0f);
        const FLOAT w = fI * fCol;
        if (w <= 0.0f) continue;
        vL /= fL;
        FLOAT *p = &af[(v * pixPolyU + u) * 4];
        p[0] += vL(1) * w; p[1] += vL(2) * w; p[2] += vL(3) * w; p[3] += w;
      }
    }
  }

  // encode against the mixed brightness
  for (PIX v = 0; v < pixPolyV; v++) for (PIX u = 0; u < pixPolyU; u++) {
    const FLOAT *p = &af[(v * pixPolyU + u) * 4];
    if (p[3] <= 0.0f) continue;
    const FLOAT3D vS(p[0], p[1], p[2]);
    const FLOAT fLen = vS.Length();
    if (fLen <= 1e-6f) continue;
    const UBYTE *pubT = (const UBYTE *)&pul[v * pixCanvasU + u];
    const FLOAT fLum = 0.30f * pubT[0] + 0.59f * pubT[1] + 0.11f * pubT[2];
    const FLOAT k = Clamp(fLen / Max(fLum, p[3]), 0.0f, 1.0f);
    const FLOAT3D vL = vS / fLen;
    const FLOAT x = vL % vSU, y = vL % vSV, z = vL % vN;
    UBYTE *pubD = (UBYTE *)&pulDir[v * pixCanvasU + u];
    pubD[0] = (UBYTE)Clamp(x * 127.5f + 128.0f, 0.0f, 255.0f);
    pubD[1] = (UBYTE)Clamp(y * 127.5f + 128.0f, 0.0f, 255.0f);
    pubD[2] = (UBYTE)Clamp(z * 127.5f + 128.0f, 0.0f, 255.0f);
    pubD[3] = (UBYTE)(k * 255.0f + 0.5f);
  }
  _tmDirs += emscripten_get_now() - tmStart;
}

// Graphics/ShadowMap.cpp CShadowMap::SetAsCurrent, after the shadow map was uploaded and bound
void SE1NM_UploadShadowDirs(CShadowMap *psm, PIX pixWidth, PIX pixHeight)
{
  if (!gfx_bNormalMaps) return;
  if (!_ptdPending.empty()) { AttachPending(); gfxSetTexture(psm->sm_ulObject, psm->sm_tpLocal); }
  auto it = _dirs.find(psm);
  if (it == _dirs.end()) return;
  DirMap &dm = it->second;
  if ((SLONG)dm.aul.size() != psm->sm_slMemoryUsed / BYTES_PER_TEXEL) return;
  if (dm.bDirty || dm.pixUploadW != pixWidth || dm.pixUploadH != pixHeight || dm.ulObject == NONE) {
    if (dm.ulObject == NONE) gfxGenerateTexture(dm.ulObject);
    CTexParams tp = psm->sm_tpLocal;
    tp.tp_bSingleMipmap = FALSE;
    gfxSetTexture(dm.ulObject, tp);
    ULONG *pul = &dm.aul[0] + psm->sm_slMemoryUsed / BYTES_PER_TEXEL - GetMipmapOffset(15, pixWidth, pixHeight);
    gfxUploadTexture(pul, pixWidth, pixHeight, TS.ts_tfRGBA8, FALSE);
    gfxSetTexture(psm->sm_ulObject, psm->sm_tpLocal);
    dm.pixUploadW = pixWidth; dm.pixUploadH = pixHeight; dm.bDirty = FALSE;
    _ctDirMaps++;
  }
  if (dm.ulCompanionOf != psm->sm_ulObject) {
    SE1_GL1Shim_SetCompanion(psm->sm_ulObject, dm.ulObject);
    dm.ulCompanionOf = psm->sm_ulObject;
  }
}

// port/common/Se1GI.cpp SE1GI_WorldCleared
void SE1NM_WorldCleared(void)
{
  AttachPending();
  for (auto &kv : _dirs) if (kv.second.ulObject != NONE) gfxDeleteTexture(kv.second.ulObject);
  _dirs.clear();
}

// re-mix every light map (after switching gfx_bNormalMaps on in a loaded level)
void NM_Refresh(void)
{
  CWorld &wo = _pNetwork->ga_World;
  FOREACHINDYNAMICARRAY(wo.wo_baBrushes.ba_abrBrushes, CBrush3D, itbr) {
    FOREACHINLIST(CBrushMip, bm_lnInBrush, itbr->br_lhBrushMips, itbm) {
      FOREACHINDYNAMICARRAY(itbm->bm_abscSectors, CBrushSector, itbsc) itbsc->UncacheLightMaps();
    }
  }
}

void NM_Stats(void)
{
  AttachPending();
  CPrintF("NM: %d normal maps, %d direction maps (%d light maps), %.1f ms computing directions\n",
          _ctNormalMaps, _ctDirMaps, (INDEX)_dirs.size(), _tmDirs);
}

// port/common/Se1GI.cpp SE1GI_DeclareSymbols
void SE1NM_DeclareSymbols(void)
{
  // ?nm=1 (port/web/pre.js) switches it on before the first level loads
  const int iNM = MAIN_THREAD_EM_ASM_INT({ return Module['se1NormalMaps'] | 0; });
  if (iNM > 0) gfx_bNormalMaps = 1;
  if (iNM > 1) gfx_bNormalMapsVerbose = 1;   // ?nm=2
  _pShell->DeclareSymbol("user INDEX gfx_bNormalMaps;", &gfx_bNormalMaps);
  _pShell->DeclareSymbol("user FLOAT gfx_fNormalStrength;", &gfx_fNormalStrength);
  _pShell->DeclareSymbol("user FLOAT gfx_fNormalFlipY;", &gfx_fNormalFlipY);
  _pShell->DeclareSymbol("user FLOAT gfx_fNormalMaxBoost;", &gfx_fNormalMaxBoost);
  _pShell->DeclareSymbol("user INDEX gfx_bNormalMapsVerbose;", &gfx_bNormalMapsVerbose);
  _pShell->DeclareSymbol("user void NM_Refresh(void);", (void *)&NM_Refresh);
  _pShell->DeclareSymbol("user void NM_Stats(void);", (void *)&NM_Stats);
}
