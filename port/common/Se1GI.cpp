/* Baked indirect light ("radiosity from lightmaps"), prototype. Design: notes/gi-plan.md.
 *
 * After a level is loaded its static shadow maps (direct light) exist. Here every lit brush
 * polygon gets a coarse grid aligned with its shadow map (one cell = a shadow-map texel at a coarser
 * mip, about gi_fCellSize metres). For every cell we gather the indirect irradiance over the
 * hemisphere with cosine-weighted rays against a BVH of the static brush triangles: a ray that hits
 * polygon P brings back albedo(P) x (direct + indirect light of P at the hit). Repeating the gather
 * gives more bounces. The result is added to the shadow map when the engine mixes it
 * (Light/LayerMixer.cpp) and to the ambient light of models standing on the polygon
 * (Rendering/RenderModels.cpp FindModelLights).
 *
 * Units: E = 1.0 is a shadow-map byte of 128, i.e. the texture shown unchanged (shadow maps
 * modulate at 2x). Albedo is the average colour of the polygon's first texture layer (0..1).
 *
 * Console: GI_Compute() bakes for the current world, GI_Clear() drops it, GI_Refresh() re-mixes
 * the shadow maps after changing a cvar (gi_bEnable, gi_fStrength, gi_fAmbient).
 * Visual only: nothing here touches simulation state. */
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
#include <Engine/Templates/DynamicArray.cpp>
#include <Engine/Templates/StaticArray.cpp>
#include <emscripten.h>
#include <math.h>
#include <string.h>
#include <vector>
#include <unordered_map>
#include <algorithm>
#include <atomic>
#include <thread>

INDEX gi_bEnable = TRUE;      // apply the baked result (GI_Refresh() after changing)
INDEX gi_iRays = 64;          // rays per cell per bounce
INDEX gi_iBounces = 2;        // gather passes
FLOAT gi_fCellSize = 1.0f;    // target cell size in metres (rounded to a shadow-map mip)
FLOAT gi_fStrength = 1.0f;    // scale of the indirect term when applied
FLOAT gi_fAmbient = 0.5f;     // scale of the sector ambient when GI is applied (the mappers' flat
                              // ambient stood in for bounce; at 1.0 sunlit outdoor areas wash out)
FLOAT gi_fFullbright = 0.5f;  // emission of full-bright polygons (sky, lava): albedo x this
FLOAT gi_fAlbedo = 1.0f;      // albedo scale (gamma-space albedo is high; < 1 tames bleeding)
INDEX gi_bVerbose = FALSE;
INDEX gi_iThreads = 4;        // gather threads (wasm pthreads; 1 = on the engine thread only)
FLOAT gi_fSky = 0.0f;         // light from rays that escape the level (sky), x gi_colSky
INDEX gi_colSky = (INDEX)0x8CA8D0FF;  // sky colour (RGBA)

namespace {

struct GIPoly {
  CBrushPolygon *pbpo;
  INDEX iMip;            // grid mip level (shadow-map mip)
  int w, h;              // grid size
  int iFirst;            // first cell in the cell arrays
  FLOAT3D vO, vSU, vSV;  // world position of cell (0,0) centre, step per cell in u and v
  FLOAT3D vDU, vDV;      // dual vectors: cell u = vDU.(p-vO), v = vDV.(p-vO)
  FLOAT3D vN;            // front-facing normal
  float alb[3];          // albedo
  float emit;            // > 0 for full-bright polygons: radiance = alb*emit, no grid
  bool receiver;         // has a grid (lit by a shading shadow map)
  ULONG key[3];          // brush entity ID, sector (first brush mip), polygon index: the bake file's key
};

struct Tri { float v0[3], e1[3], e2[3]; int poly; };
struct Node { float mn[3], mx[3]; int left, count; };  // count>0: leaf, left = first tri

static std::vector<GIPoly> _polys;
static std::vector<float> _dir, _ind, _tmp;   // 3 floats per cell
static std::vector<unsigned char> _valid;
static std::unordered_map<CBrushPolygon *, int> _map;
static std::vector<Tri> _tris;
static std::vector<Node> _nodes;
static CWorld *_pwoBaked = NULL;
static BOOL _bComputing = FALSE;
static BOOL _bLoadPending = FALSE;   // a world was (re)loaded: look for its bake on the next lookup
static std::vector<unsigned char> _blob;   // GI_Save() output, read by the page (SE1GI_Blob*)
static float _afSky[3];

// ---------- BVH ----------

struct BuildRef { float c[3], mn[3], mx[3]; int tri; };

static void BoxOf(const Tri &t, float *mn, float *mx)
{
  for (int a = 0; a < 3; a++) {
    float p0 = t.v0[a], p1 = t.v0[a] + t.e1[a], p2 = t.v0[a] + t.e2[a];
    mn[a] = std::min(p0, std::min(p1, p2));
    mx[a] = std::max(p0, std::max(p1, p2));
  }
}

static float Area(const float *mn, const float *mx)
{
  float dx = mx[0] - mn[0], dy = mx[1] - mn[1], dz = mx[2] - mn[2];
  return dx * dy + dy * dz + dz * dx;
}

// right child index: we store it explicitly in a parallel array
static std::vector<int> _right;

static int BuildNodeR(std::vector<BuildRef> &refs, int b, int e, std::vector<Tri> &out);

static void BuildBVH(void)
{
  std::vector<BuildRef> refs(_tris.size());
  for (size_t i = 0; i < _tris.size(); i++) {
    BoxOf(_tris[i], refs[i].mn, refs[i].mx);
    for (int a = 0; a < 3; a++) refs[i].c[a] = 0.5f * (refs[i].mn[a] + refs[i].mx[a]);
    refs[i].tri = (int)i;
  }
  _nodes.clear(); _right.clear();
  std::vector<Tri> out; out.reserve(_tris.size());
  if (!refs.empty()) BuildNodeR(refs, 0, (int)refs.size(), out);
  _tris.swap(out);
}

static int BuildNodeR(std::vector<BuildRef> &refs, int b, int e, std::vector<Tri> &out)
{
  int iNode = (int)_nodes.size();
  _nodes.push_back(Node()); _right.push_back(-1);
  Node nd;
  for (int a = 0; a < 3; a++) { nd.mn[a] = 1e30f; nd.mx[a] = -1e30f; }
  float cmn[3] = {1e30f, 1e30f, 1e30f}, cmx[3] = {-1e30f, -1e30f, -1e30f};
  for (int i = b; i < e; i++) for (int a = 0; a < 3; a++) {
    nd.mn[a] = std::min(nd.mn[a], refs[i].mn[a]); nd.mx[a] = std::max(nd.mx[a], refs[i].mx[a]);
    cmn[a] = std::min(cmn[a], refs[i].c[a]); cmx[a] = std::max(cmx[a], refs[i].c[a]);
  }
  const int n = e - b;
  int iSplit = -1;
  if (n > 4) {
    int ax = 0;
    for (int a = 1; a < 3; a++) if (cmx[a] - cmn[a] > cmx[ax] - cmn[ax]) ax = a;
    const float ext = cmx[ax] - cmn[ax];
    if (ext > 1e-6f) {
      enum { NB = 16 };
      int cnt[NB] = {0};
      float bmn[NB][3], bmx[NB][3];
      for (int k = 0; k < NB; k++) for (int a = 0; a < 3; a++) { bmn[k][a] = 1e30f; bmx[k][a] = -1e30f; }
      for (int i = b; i < e; i++) {
        int k = std::min(NB - 1, (int)((refs[i].c[ax] - cmn[ax]) / ext * NB));
        cnt[k]++;
        for (int a = 0; a < 3; a++) { bmn[k][a] = std::min(bmn[k][a], refs[i].mn[a]); bmx[k][a] = std::max(bmx[k][a], refs[i].mx[a]); }
      }
      float best = 1e30f; int bestK = -1;
      for (int k = 1; k < NB; k++) {
        float lmn[3] = {1e30f, 1e30f, 1e30f}, lmx[3] = {-1e30f, -1e30f, -1e30f};
        float rmn[3] = {1e30f, 1e30f, 1e30f}, rmx[3] = {-1e30f, -1e30f, -1e30f};
        int nl = 0, nr = 0;
        for (int j = 0; j < k; j++) if (cnt[j]) { nl += cnt[j]; for (int a = 0; a < 3; a++) { lmn[a] = std::min(lmn[a], bmn[j][a]); lmx[a] = std::max(lmx[a], bmx[j][a]); } }
        for (int j = k; j < NB; j++) if (cnt[j]) { nr += cnt[j]; for (int a = 0; a < 3; a++) { rmn[a] = std::min(rmn[a], bmn[j][a]); rmx[a] = std::max(rmx[a], bmx[j][a]); } }
        if (!nl || !nr) continue;
        float c = nl * Area(lmn, lmx) + nr * Area(rmn, rmx);
        if (c < best) { best = c; bestK = k; }
      }
      if (bestK > 0 && (best < n * Area(nd.mn, nd.mx) || n > 8)) {
        BuildRef *mid = std::partition(&refs[b], &refs[b] + n, [&](const BuildRef &r) {
          return std::min(NB - 1, (int)((r.c[ax] - cmn[ax]) / ext * NB)) < bestK; });
        iSplit = (int)(mid - &refs[0]);
        if (iSplit == b || iSplit == e) iSplit = -1;
      }
    }
    if (iSplit < 0 && n > 16) {
      std::nth_element(&refs[b], &refs[b] + n / 2, &refs[b] + n,
        [&](const BuildRef &p, const BuildRef &q) { return p.c[ax] < q.c[ax]; });
      iSplit = b + n / 2;
    }
  }
  if (iSplit < 0) {
    nd.left = (int)out.size(); nd.count = n;
    for (int i = b; i < e; i++) out.push_back(_tris[refs[i].tri]);
    _nodes[iNode] = nd;
    return iNode;
  }
  nd.count = 0;
  _nodes[iNode] = nd;
  int l = BuildNodeR(refs, b, iSplit, out);
  int r = BuildNodeR(refs, iSplit, e, out);
  _nodes[iNode].left = l;
  _right[iNode] = r;
  return iNode;
}

static inline bool RayBox(const Node &nd, const float *o, const float *inv, float tmax)
{
  float t0 = 0.0f, t1 = tmax;
  for (int a = 0; a < 3; a++) {
    float ta = (nd.mn[a] - o[a]) * inv[a], tb = (nd.mx[a] - o[a]) * inv[a];
    if (ta > tb) std::swap(ta, tb);
    t0 = ta > t0 ? ta : t0;
    t1 = tb < t1 ? tb : t1;
    if (t0 > t1) return false;
  }
  return true;
}

// closest hit; returns poly index or -1, t in *pt
static int Trace(const float *o, const float *d, float *pt, int iSkipPoly)
{
  if (_nodes.empty()) return -1;
  float inv[3];
  for (int a = 0; a < 3; a++) inv[a] = 1.0f / (fabsf(d[a]) > 1e-12f ? d[a] : (d[a] < 0 ? -1e-12f : 1e-12f));
  float tBest = 1e30f; int iHit = -1;
  int stack[64]; int sp = 0;
  stack[sp++] = 0;
  while (sp) {
    const int in = stack[--sp];
    const Node &nd = _nodes[in];
    if (!RayBox(nd, o, inv, tBest)) continue;
    if (nd.count) {
      for (int i = nd.left; i < nd.left + nd.count; i++) {
        const Tri &t = _tris[i];
        if (t.poly == iSkipPoly) continue;
        // Moller-Trumbore, two-sided
        float p[3] = { d[1]*t.e2[2]-d[2]*t.e2[1], d[2]*t.e2[0]-d[0]*t.e2[2], d[0]*t.e2[1]-d[1]*t.e2[0] };
        float det = t.e1[0]*p[0] + t.e1[1]*p[1] + t.e1[2]*p[2];
        if (fabsf(det) < 1e-12f) continue;
        float id = 1.0f / det;
        float s[3] = { o[0]-t.v0[0], o[1]-t.v0[1], o[2]-t.v0[2] };
        float u = (s[0]*p[0] + s[1]*p[1] + s[2]*p[2]) * id;
        if (u < 0.0f || u > 1.0f) continue;
        float q[3] = { s[1]*t.e1[2]-s[2]*t.e1[1], s[2]*t.e1[0]-s[0]*t.e1[2], s[0]*t.e1[1]-s[1]*t.e1[0] };
        float v = (d[0]*q[0] + d[1]*q[1] + d[2]*q[2]) * id;
        if (v < 0.0f || u + v > 1.0f) continue;
        float tt = (t.e2[0]*q[0] + t.e2[1]*q[1] + t.e2[2]*q[2]) * id;
        if (tt > 1e-3f && tt < tBest) { tBest = tt; iHit = t.poly; }
      }
    } else if (sp < 62) {
      stack[sp++] = _right[in];
      stack[sp++] = nd.left;
    }
  }
  *pt = tBest;
  return iHit;
}

// ---------- helpers ----------

static inline uint32_t Hash(uint32_t x)
{
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
  return x;
}

static void Bilinear(const std::vector<float> &a, const GIPoly &gp, float u, float v, float *out)
{
  u = std::max(0.0f, std::min(u, (float)(gp.w - 1)));
  v = std::max(0.0f, std::min(v, (float)(gp.h - 1)));
  int u0 = (int)u, v0 = (int)v;
  int u1 = std::min(u0 + 1, gp.w - 1), v1 = std::min(v0 + 1, gp.h - 1);
  float fu = u - u0, fv = v - v0;
  const float *p00 = &a[(gp.iFirst + v0 * gp.w + u0) * 3], *p10 = &a[(gp.iFirst + v0 * gp.w + u1) * 3];
  const float *p01 = &a[(gp.iFirst + v1 * gp.w + u0) * 3], *p11 = &a[(gp.iFirst + v1 * gp.w + u1) * 3];
  for (int c = 0; c < 3; c++)
    out[c] = (p00[c] * (1 - fu) + p10[c] * fu) * (1 - fv) + (p01[c] * (1 - fu) + p11[c] * fu) * fv;
}

// world position of the centre of shadow-map texel (u,v) at mip iMip (as CLayerMixer::CalculateData)
static FLOAT3D TexelPos(CBrushPolygon &bpo, INDEX iMip, FLOAT fU, FLOAT fV)
{
  CBrushShadowMap &bsm = bpo.bpo_smShadowMap;
  CEntity *pen = bpo.bpo_pbscSector->bsc_pbmBrushMip->bm_pbrBrush->br_penEntity;
  MEX2D vmex;
  vmex(1) = (MEX)(fU * (1 << iMip)) - bsm.sm_mexOffsetX + (iMip > 0 ? (1 << (iMip - 1)) : 0);
  vmex(2) = (MEX)(fV * (1 << iMip)) - bsm.sm_mexOffsetY + (iMip > 0 ? (1 << (iMip - 1)) : 0);
  FLOAT3D v;
  bpo.bpo_mdShadow.GetSpaceCoordinates(bpo.bpo_pbplPlane->bpl_pwplWorking->wpl_mvRelative, vmex, v);
  return v * pen->en_mRotation + pen->GetPlacement().pl_PositionVector;
}

struct AlbedoCache { std::unordered_map<CTextureData *, COLOR> m; };

static COLOR TextureAverage(CTextureData *ptd, AlbedoCache &ac)
{
  auto it = ac.m.find(ptd);
  if (it != ac.m.end()) return it->second;
  COLOR col = 0x808080FF;
  ULONG *pulFrames = ptd->td_pulFrames;
  CTextureData tdTmp;
  BOOL bTmp = FALSE;
  if (pulFrames == NULL) {
    // frames were freed after upload: load a private copy
    try { tdTmp.Load_t(ptd->GetName()); pulFrames = tdTmp.td_pulFrames; bTmp = TRUE; }
    catch (char *strError) { (void)strError; pulFrames = NULL; }
  }
  if (pulFrames != NULL) {
    CTextureData &td = bTmp ? tdTmp : *ptd;
    PIX w = td.GetPixWidth(), h = td.GetPixHeight();
    INDEX ctMips = GetNoOfMipmaps(w, h), iMip = 0;
    while (iMip + 1 < ctMips && (w >> iMip) * (h >> iMip) > 32 * 32
        && GetMipmapOffset(iMip + 2, w, h) * BYTES_PER_TEXEL <= td.td_slFrameSize) iMip++;
    const UBYTE *pub = (const UBYTE *)(pulFrames + GetMipmapOffset(iMip, w, h));
    const PIX ct = (w >> iMip) * (h >> iMip);
    double r = 0, g = 0, b = 0, wsum = 0;
    for (PIX i = 0; i < ct; i++) {
      const double a = pub[i * 4 + 3] / 255.0;  // alpha-tested texels don't reflect
      r += pub[i * 4 + 0] * a; g += pub[i * 4 + 1] * a; b += pub[i * 4 + 2] * a; wsum += a;
    }
    if (wsum > 0) col = RGBToColor((UBYTE)(r / wsum), (UBYTE)(g / wsum), (UBYTE)(b / wsum)) | 0xFF;
  }
  ac.m[ptd] = col;
  return col;
}

static bool IsSolid(const CBrushPolygon &bpo)
{
  const ULONG f = bpo.bpo_ulFlags;
  if (f & (BPOF_INVISIBLE | BPOF_DOESNOTCASTSHADOW)) return false;
  if ((f & BPOF_PORTAL) || (f & BPOF_TRANSLUCENT)) return false;
  return true;
}

static void Dilate(void)
{
  // cells whose rays mostly hit back faces sit inside walls: fill them from valid neighbours
  for (size_t ip = 0; ip < _polys.size(); ip++) {
    GIPoly &gp = _polys[ip];
    if (!gp.receiver) continue;
    for (int pass = 0; pass < 6; pass++) {
      bool bAny = false;
      for (int y = 0; y < gp.h; y++) for (int x = 0; x < gp.w; x++) {
        const int i = gp.iFirst + y * gp.w + x;
        if (_valid[i]) continue;
        float s[3] = {0, 0, 0}; int n = 0;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
          int xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gp.w || yy >= gp.h) continue;
          int j = gp.iFirst + yy * gp.w + xx;
          if (_valid[j] != 1) continue;
          for (int c = 0; c < 3; c++) s[c] += _ind[j * 3 + c];
          n++;
        }
        if (n) { for (int c = 0; c < 3; c++) _ind[i * 3 + c] = s[c] / n; _valid[i] = 2; bAny = true; }
      }
      for (int i = gp.iFirst; i < gp.iFirst + gp.w * gp.h; i++) if (_valid[i] == 2) _valid[i] = 1;
      if (!bAny) break;
    }
  }
}

static void Blur(void)
{
  // 3x3 binomial filter inside each grid, against ray noise
  _tmp = _ind;
  for (size_t ip = 0; ip < _polys.size(); ip++) {
    const GIPoly &gp = _polys[ip];
    if (!gp.receiver || gp.w * gp.h < 2) continue;
    for (int y = 0; y < gp.h; y++) for (int x = 0; x < gp.w; x++) {
      float s[3] = {0, 0, 0}, ws = 0;
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
        int xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= gp.w || yy >= gp.h) continue;
        float w = (dx ? 1.0f : 2.0f) * (dy ? 1.0f : 2.0f);
        int j = gp.iFirst + yy * gp.w + xx;
        for (int c = 0; c < 3; c++) s[c] += _tmp[j * 3 + c] * w;
        ws += w;
      }
      int i = gp.iFirst + y * gp.w + x;
      for (int c = 0; c < 3; c++) _ind[i * 3 + c] = s[c] / ws;
    }
  }
}

static void UncacheAll(void)
{
  for (size_t ip = 0; ip < _polys.size(); ip++) _polys[ip].pbpo->bpo_smShadowMap.Uncache();
}

// gather one bounce for every cell of polygon ip; returns the number of rays
static long long GatherPoly(int ip, int iB, int sq, const std::vector<float> &eTot, std::vector<float> &indNew)
{
  const GIPoly &gp = _polys[ip];
  if (!gp.receiver) return 0;
  const int ctR = sq * sq;
  // tangent frame
  FLOAT3D n = gp.vN;
  FLOAT3D t = gp.vSU; t = t - n * (t % n);
  FLOAT tl = t.Length();
  if (tl < 1e-6f) { t = (fabsf(n(1)) < 0.9f) ? FLOAT3D(1, 0, 0) : FLOAT3D(0, 1, 0); t = t - n * (t % n); tl = t.Length(); }
  t /= tl;
  FLOAT3D bt = n * t;
  for (int y = 0; y < gp.h; y++) for (int x = 0; x < gp.w; x++) {
    const int ic = gp.iFirst + y * gp.w + x;
    FLOAT3D p = gp.vO + gp.vSU * (FLOAT)x + gp.vSV * (FLOAT)y + n * 0.05f;
    const float o[3] = { p(1), p(2), p(3) };
    uint32_t h = Hash((uint32_t)ic * 9781u + (uint32_t)iB * 6271u + 1u);
    const float ou = (h & 0xFFFF) / 65536.0f, ov = (h >> 16) / 65536.0f;
    float acc[3] = {0, 0, 0};
    int ctBack = 0;
    for (int k = 0; k < ctR; k++) {
      float r1 = ((k % sq) + ou) / sq, r2 = ((k / sq) + ov) / sq;
      if (r1 >= 1.0f) r1 -= 1.0f;
      if (r2 >= 1.0f) r2 -= 1.0f;
      const float rr = sqrtf(r1), phi = 6.2831853f * r2;
      const float lx = rr * cosf(phi), ly = rr * sinf(phi), lz = sqrtf(std::max(0.0f, 1.0f - r1));
      FLOAT3D dv = t * lx + bt * ly + n * lz;
      const float d[3] = { dv(1), dv(2), dv(3) };
      float th;
      const int iHit = Trace(o, d, &th, ip);
      if (iHit < 0) {  // sky / void
        for (int c = 0; c < 3; c++) acc[c] += _afSky[c];
        continue;
      }
      const GIPoly &hp = _polys[iHit];
      const float cosH = d[0] * hp.vN(1) + d[1] * hp.vN(2) + d[2] * hp.vN(3);
      if (cosH > 0.0f) { ctBack++; continue; }  // back face
      if (hp.emit > 0.0f) {
        for (int c = 0; c < 3; c++) acc[c] += hp.alb[c] * hp.emit;
      } else if (hp.receiver) {
        FLOAT3D ph(o[0] + d[0] * th, o[1] + d[1] * th, o[2] + d[2] * th);
        FLOAT3D rel = ph - hp.vO;
        float e[3];
        Bilinear(eTot, hp, rel % hp.vDU, rel % hp.vDV, e);
        for (int c = 0; c < 3; c++) acc[c] += hp.alb[c] * e[c];
      }
    }
    for (int c = 0; c < 3; c++) indNew[ic * 3 + c] = acc[c] / ctR;
    if (iB == 0) _valid[ic] = (ctBack * 4 < ctR) ? 1 : 0;
  }
  return (long long)gp.w * gp.h * ctR;
}

}  // namespace

// ---------- console ----------

static FLOAT _fBakeCell = 0; static int _iBakeRays = 0, _iBakeBounces = 0;   // last bake's settings

void GI_Clear(void)
{
  UncacheAll();
  _polys.clear(); _dir.clear(); _ind.clear(); _tmp.clear(); _valid.clear(); _map.clear();
  _tris.clear(); _nodes.clear(); _right.clear();
  _pwoBaked = NULL;
}

void GI_Refresh(void)
{
  UncacheAll();
  CPrintF("GI: refreshed %d shadow maps (enable=%d strength=%.2f ambient=%.2f)\n",
          (int)_polys.size(), (int)gi_bEnable, gi_fStrength, gi_fAmbient);
}

void GI_Compute(void)
{
  CWorld &wo = _pNetwork->ga_World;
  GI_Clear();
  const double t0 = emscripten_get_now();
  _bComputing = TRUE;
  wo.CalculateNonDirectionalShadows();  // what the first render would do anyway

  // 1. polygons, triangles, grids
  AlbedoCache ac;
  long long ctLightmapTexels = 0, ctUsedTexels = 0;
  int ctFlat = 0;
  FOREACHINDYNAMICARRAY(wo.wo_baBrushes.ba_abrBrushes, CBrush3D, itbr) {
    CEntity *pen = itbr->br_penEntity;
    if (pen == NULL || pen->en_RenderType != CEntity::RT_BRUSH) continue;
    if (pen->en_ulFlags & ENF_HIDDEN) continue;
    CBrushMip *pbm = itbr->GetFirstMip();
    if (pbm == NULL) continue;
    int iKeyS = -1;
    FOREACHINDYNAMICARRAY(pbm->bm_abscSectors, CBrushSector, itbsc) {
      iKeyS++;
      int iKeyP = -1;
      FOREACHINSTATICARRAY(itbsc->bsc_abpoPolygons, CBrushPolygon, itbpo) {
        iKeyP++;
        CBrushPolygon &bpo = *itbpo;
        const ULONG f = bpo.bpo_ulFlags;
        const bool bSolid = IsSolid(bpo);
        CBrushShadowMap &bsm = bpo.bpo_smShadowMap;
        const bool bRecv = bSolid && !(f & (BPOF_FULLBRIGHT | BPOF_DYNAMICLIGHTSONLY))
                        && bsm.sm_mexWidth > 0 && bsm.sm_mexHeight > 0
                        && bpo.bpo_bppProperties.bpp_ubShadowBlend == BPT_BLEND_SHADE;
        if (!bSolid) continue;
        GIPoly gp;
        memset(&gp, 0, sizeof(gp));
        gp.pbpo = &bpo;
        gp.iFirst = -1;
        gp.key[0] = pen->en_ulID; gp.key[1] = iKeyS; gp.key[2] = iKeyP;
        const FLOATplane3D &pl = bpo.bpo_pbplPlane->bpl_plAbsolute;
        gp.vN = FLOAT3D(pl(1), pl(2), pl(3));
        // albedo: average of the base texture, tinted by the layer colour
        CTextureData *ptd = (CTextureData *)bpo.bpo_abptTextures[0].bpt_toTexture.GetData();
        COLOR colT = ptd != NULL ? TextureAverage(ptd, ac) : 0x808080FF;
        COLOR colL = bpo.bpo_abptTextures[0].s.bpt_colColor;
        UBYTE r, g, b, lr, lg, lb;
        ColorToRGB(colT, r, g, b); ColorToRGB(colL, lr, lg, lb);
        gp.alb[0] = std::min(1.0f, r / 255.0f * lr / 255.0f * gi_fAlbedo);
        gp.alb[1] = std::min(1.0f, g / 255.0f * lg / 255.0f * gi_fAlbedo);
        gp.alb[2] = std::min(1.0f, b / 255.0f * lb / 255.0f * gi_fAlbedo);
        if (f & BPOF_FULLBRIGHT) gp.emit = gi_fFullbright;
        gp.receiver = bRecv;
        if (bRecv) {
          // grid mip: coarsest mip whose cell is still <= gi_fCellSize
          const INDEX iFirst = bsm.sm_iFirstMipLevel;
          FLOAT3D v00 = TexelPos(bpo, iFirst, 0, 0), v10 = TexelPos(bpo, iFirst, 1, 0);
          FLOAT fTexel = (v10 - v00).Length();
          INDEX iMip = iFirst;
          while (iMip < bsm.sm_iLastMipLevel && fTexel * 2.0f <= gi_fCellSize * 1.001f
                 && (bsm.sm_mexWidth >> (iMip + 1)) >= 1 && (bsm.sm_mexHeight >> (iMip + 1)) >= 1) {
            fTexel *= 2.0f; iMip++;
          }
          gp.iMip = iMip;
          gp.w = std::max(1, (int)(bsm.sm_mexWidth >> iMip));
          gp.h = std::max(1, (int)(bsm.sm_mexHeight >> iMip));
          gp.vO = TexelPos(bpo, iMip, 0, 0);
          gp.vSU = TexelPos(bpo, iMip, 1, 0) - gp.vO;
          gp.vSV = TexelPos(bpo, iMip, 0, 1) - gp.vO;
          // dual basis in the plane
          const FLOAT a = gp.vSU % gp.vSU, bb = gp.vSU % gp.vSV, c = gp.vSV % gp.vSV;
          const FLOAT det = a * c - bb * bb;
          if (fabsf(det) < 1e-12f) { gp.receiver = false; }
          else {
            gp.vDU = (gp.vSU * c - gp.vSV * bb) / det;
            gp.vDV = (gp.vSV * a - gp.vSU * bb) / det;
            gp.iFirst = (int)(_dir.size() / 3);
            _dir.resize(_dir.size() + gp.w * gp.h * 3, 0.0f);
            ctLightmapTexels += (long long)(bsm.sm_mexWidth >> iFirst) * (bsm.sm_mexHeight >> iFirst);
            ctUsedTexels += (long long)(bsm.sm_pixPolygonSizeU + 1) * (bsm.sm_pixPolygonSizeV + 1);
          }
        }
        const int iPoly = (int)_polys.size();
        _polys.push_back(gp);
        _map[&bpo] = iPoly;
        // triangles
        const INDEX ctElems = bpo.bpo_aiTriangleElements.Count();
        for (INDEX ie = 0; ie + 2 < ctElems; ie += 3) {
          const FLOAT3D &p0 = bpo.bpo_apbvxTriangleVertices[bpo.bpo_aiTriangleElements[ie + 0]]->bvx_vAbsolute;
          const FLOAT3D &p1 = bpo.bpo_apbvxTriangleVertices[bpo.bpo_aiTriangleElements[ie + 1]]->bvx_vAbsolute;
          const FLOAT3D &p2 = bpo.bpo_apbvxTriangleVertices[bpo.bpo_aiTriangleElements[ie + 2]]->bvx_vAbsolute;
          Tri t;
          for (int k = 0; k < 3; k++) { t.v0[k] = p0(k + 1); t.e1[k] = p1(k + 1) - p0(k + 1); t.e2[k] = p2(k + 1) - p0(k + 1); }
          t.poly = iPoly;
          _tris.push_back(t);
        }
      }
    }
  }
  const int ctCells = (int)(_dir.size() / 3);
  const double t1 = emscripten_get_now();

  // 2. direct light per cell: let the engine mix the shadow map at the grid mip
  for (size_t ip = 0; ip < _polys.size(); ip++) {
    GIPoly &gp = _polys[ip];
    if (!gp.receiver) continue;
    CBrushShadowMap &bsm = gp.pbpo->bpo_smShadowMap;
    bsm.Uncache();
    bsm.Cache(gp.iMip);
    COLOR colAmb = gp.pbpo->bpo_pbscSector->bsc_colAmbient;
    UBYTE ar, ag, ab; ColorToRGB(colAmb, ar, ag, ab);
    const float amb[3] = { ar / 128.0f, ag / 128.0f, ab / 128.0f };
    float *pd = &_dir[gp.iFirst * 3];
    if (bsm.sm_pulCachedShadowMap == &bsm.sm_colFlat) {
      UBYTE r, g, b; ColorToRGB(bsm.sm_colFlat, r, g, b);
      ctFlat++;
      for (int i = 0; i < gp.w * gp.h; i++) {
        pd[i * 3 + 0] = r / 128.0f; pd[i * 3 + 1] = g / 128.0f; pd[i * 3 + 2] = b / 128.0f;
      }
    } else if (bsm.sm_pulCachedShadowMap != NULL) {
      const PIX pixOffset = bsm.sm_slMemoryUsed / BYTES_PER_TEXEL - GetMipmapOffset(15, gp.w, gp.h);
      const UBYTE *pub = (const UBYTE *)(bsm.sm_pulCachedShadowMap + pixOffset);
      for (int i = 0; i < gp.w * gp.h; i++)
        for (int c = 0; c < 3; c++) pd[i * 3 + c] = pub[i * 4 + c] / 128.0f;
    }
    // the sector ambient is the old stand-in for indirect light: don't re-emit it
    for (int i = 0; i < gp.w * gp.h; i++)
      for (int c = 0; c < 3; c++) pd[i * 3 + c] = std::max(0.0f, pd[i * 3 + c] - amb[c]);
    bsm.Uncache();
  }
  const double t2 = emscripten_get_now();

  // 3. BVH
  const int ctTris = (int)_tris.size();
  BuildBVH();
  const double t3 = emscripten_get_now();

  // 4. gather passes
  _ind.assign(ctCells * 3, 0.0f);
  _valid.assign(ctCells, 1);
  std::vector<float> indNew(ctCells * 3, 0.0f);
  std::vector<float> eTot(ctCells * 3, 0.0f);
  const int ctRays = std::max(4, (int)gi_iRays);
  const int sq = std::max(2, (int)floorf(sqrtf((float)ctRays)));
  const int ctR = sq * sq;
  long long ctTraced = 0;
  const int ctBounces = Clamp(gi_iBounces, (INDEX)1, (INDEX)4);
  { UBYTE r, g, b; ColorToRGB((COLOR)gi_colSky, r, g, b);
    _afSky[0] = r / 255.0f * gi_fSky; _afSky[1] = g / 255.0f * gi_fSky; _afSky[2] = b / 255.0f * gi_fSky; }
  int ctThreadsUsed = 1;
  for (int iB = 0; iB < ctBounces; iB++) {
    for (int i = 0; i < ctCells * 3; i++) eTot[i] = _dir[i] + _ind[i];
    std::atomic<int> next(0);
    std::atomic<long long> traced(0);
    auto work = [&]() {
      long long myTraced = 0;
      for (;;) {
        const int ip = next.fetch_add(1);
        if (ip >= (int)_polys.size()) break;
        myTraced += GatherPoly(ip, iB, sq, eTot, indNew);
      }
      traced += myTraced;
    };
    const int ctThreads = Clamp(gi_iThreads, (INDEX)1, (INDEX)16);
    std::vector<std::thread> threads;
    for (int i = 1; i < ctThreads; i++) {
      try { threads.push_back(std::thread(work)); } catch (...) { break; }
    }
    ctThreadsUsed = (int)threads.size() + 1;
    work();
    for (size_t i = 0; i < threads.size(); i++) threads[i].join();
    ctTraced += traced;
    _ind.swap(indNew);
    Dilate();
    CPrintF("GI: bounce %d/%d done, %.1f s\n", iB + 1, ctBounces, (emscripten_get_now() - t3) / 1000.0);
  }
  Blur();
  const double t4 = emscripten_get_now();
  _bComputing = FALSE;
  _pwoBaked = &wo;
  _bLoadPending = FALSE;
  _fBakeCell = gi_fCellSize; _iBakeRays = ctR; _iBakeBounces = ctBounces;
  UncacheAll();

  int ctRecv = 0, ctInvalid = 0;
  double sumE = 0, sumD = 0;
  for (size_t ip = 0; ip < _polys.size(); ip++) if (_polys[ip].receiver) ctRecv++;
  for (int i = 0; i < ctCells; i++) {
    if (!_valid[i]) ctInvalid++;
    sumE += (_ind[i * 3] + _ind[i * 3 + 1] + _ind[i * 3 + 2]) / 3.0;
    sumD += (_dir[i * 3] + _dir[i * 3 + 1] + _dir[i * 3 + 2]) / 3.0;
  }
  CPrintF("GI: %d polygons (%d receivers, %d flat), %d triangles, %d BVH nodes\n",
          (int)_polys.size(), ctRecv, ctFlat, ctTris, (int)_nodes.size());
  CPrintF("GI: shadow-map texels %lld (polygon area %lld), GI cells %d (%d inside walls), %d rays/cell x %d bounces = %lld rays\n",
          ctLightmapTexels, ctUsedTexels, ctCells, ctInvalid, ctR, ctBounces, ctTraced);
  CPrintF("GI: mean direct %.3f, mean indirect %.3f (1.0 = shadow byte 128)\n",
          ctCells ? sumD / ctCells : 0.0, ctCells ? sumE / ctCells : 0.0);
  CPrintF("GI: time setup %.0f ms, direct %.0f ms, bvh %.0f ms, gather %.0f ms on %d threads (%.2f Mrays/s), total %.0f ms\n",
          t1 - t0, t2 - t1, t3 - t2, t4 - t3, ctThreadsUsed, ctTraced / std::max(1.0, (t4 - t3) * 1000.0), t4 - t0);
}

// ---------- bake files ----------
// GI/<world path without extension>.gi in the game data, e.g. GI/Levels/12_Karnak.gi. Written by
// GI_Save() (the page uploads the bytes: tools/gibake.mjs), read on the first lookup after a world
// loads. Little-endian:
//   "SGI1", u32 version, u32 reserved (0), f32 cell size, u32 rays, u32 bounces, u32 records, u32 cells,
//   records x { u32 brush entity ID, u32 sector, u32 polygon, u32 mip | w << 8 | h << 20 },
//   cells x u32 RGB9E5 (indirect irradiance, 1.0 = shadow byte 128)
// Entity IDs come from the world file, so they survive FilterEntitiesBySpawnFlags (whose deletions
// would shift brush indices). Records of entities missing in this session are skipped; a polygon
// whose shadow map size differs from the bake means the world changed, and the file is refused.
INDEX gi_bLoad = TRUE;   // load prebaked GI files when a world loads
static const ULONG GI_FILE_VERSION = 1;

static uint32_t ToRGB9E5(const float *c)
{
  const float fMax = 65408.0f;
  float r = Clamp(c[0], 0.0f, fMax), g = Clamp(c[1], 0.0f, fMax), b = Clamp(c[2], 0.0f, fMax);
  const float m = std::max(r, std::max(g, b));
  if (m < 1e-7f) return 0;
  int e = std::max(-16, (int)floorf(log2f(m))) + 16;
  float denom = ldexpf(1.0f, e - 24);
  if ((int)floorf(m / denom + 0.5f) == 512) { denom *= 2.0f; e++; }
  const uint32_t rm = (uint32_t)floorf(r / denom + 0.5f), gm = (uint32_t)floorf(g / denom + 0.5f), bm = (uint32_t)floorf(b / denom + 0.5f);
  return std::min(rm, 511u) | (std::min(gm, 511u) << 9) | (std::min(bm, 511u) << 18) | ((uint32_t)e << 27);
}

static void FromRGB9E5(uint32_t v, float *c)
{
  const float f = ldexpf(1.0f, (int)(v >> 27) - 24);
  c[0] = (v & 511) * f; c[1] = ((v >> 9) & 511) * f; c[2] = ((v >> 18) & 511) * f;
}

static CTFileName BakeFileName(CWorld &wo)
{
  CTString str = wo.wo_fnmFileName.NoExt();
  for (char *pch = (char *)(const char *)str; *pch; pch++) if (*pch == '/') *pch = '\\';
  return CTFileName(CTString("GI\\") + str + ".gi");
}

static void Put32(ULONG ul) { for (int i = 0; i < 4; i++) _blob.push_back((unsigned char)(ul >> (i * 8))); }

void GI_Save(void)
{
  CWorld &wo = _pNetwork->ga_World;
  _blob.clear();
  if (_pwoBaked != &wo || _ind.empty()) { CPrintF("GI: nothing baked to save\n"); return; }
  ULONG ctRec = 0, ctCells = 0;
  for (size_t ip = 0; ip < _polys.size(); ip++) if (_polys[ip].receiver) { ctRec++; ctCells += _polys[ip].w * _polys[ip].h; }
  _blob.reserve(32 + ctRec * 16 + ctCells * 4);
  _blob.push_back('S'); _blob.push_back('G'); _blob.push_back('I'); _blob.push_back('1');
  Put32(GI_FILE_VERSION); Put32(0);
  { FLOAT f = _fBakeCell; ULONG ul; memcpy(&ul, &f, 4); Put32(ul); }
  Put32(_iBakeRays); Put32(_iBakeBounces); Put32(ctRec); Put32(ctCells);
  for (size_t ip = 0; ip < _polys.size(); ip++) {
    const GIPoly &gp = _polys[ip];
    if (!gp.receiver) continue;
    Put32(gp.key[0]); Put32(gp.key[1]); Put32(gp.key[2]);
    Put32((ULONG)gp.iMip | ((ULONG)gp.w << 8) | ((ULONG)gp.h << 20));
  }
  for (size_t ip = 0; ip < _polys.size(); ip++) {
    const GIPoly &gp = _polys[ip];
    if (!gp.receiver) continue;
    for (int i = 0; i < gp.w * gp.h; i++) Put32(ToRGB9E5(&_ind[(gp.iFirst + i) * 3]));
  }
  CPrintF("GI: saved %d bytes for %s (%d polygons, %d cells) -> %s\n", (int)_blob.size(),
          (const char *)wo.wo_fnmFileName, (int)ctRec, (int)ctCells, (const char *)BakeFileName(wo));
}

extern "C" EMSCRIPTEN_KEEPALIVE unsigned char *SE1GI_BlobData(void) { return _blob.empty() ? NULL : &_blob[0]; }
extern "C" EMSCRIPTEN_KEEPALIVE int SE1GI_BlobSize(void) { return (int)_blob.size(); }
extern "C" EMSCRIPTEN_KEEPALIVE void SE1GI_BlobFree(void) { std::vector<unsigned char>().swap(_blob); }

static void DropBake(void)
{
  _polys.clear(); _dir.clear(); _ind.clear(); _tmp.clear(); _valid.clear(); _map.clear();
  _tris.clear(); _nodes.clear(); _right.clear();
  _pwoBaked = NULL;
}

// returns an error, or NULL when the bake was taken
static const char *LoadBake(CWorld &wo, const CTFileName &fnm)
{
  std::vector<unsigned char> buf;
  try {
    CTFileStream strm;
    strm.Open_t(fnm);
    const SLONG sl = strm.GetStreamSize();
    if (sl < 32) return "file too short";
    buf.resize(sl);
    strm.Read_t(&buf[0], sl);
    strm.Close();
  } catch (const char *strError) {
    static char ach[256]; snprintf(ach, sizeof(ach), "%s", strError); return ach;
  }
  size_t at = 0;
  auto get = [&](void) -> ULONG {
    if (at + 4 > buf.size()) { at = buf.size() + 1; return 0; }
    ULONG ul = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | ((ULONG)buf[at + 3] << 24);
    at += 4; return ul;
  };
  if (memcmp(&buf[0], "SGI1", 4) != 0) return "not a GI file";
  at = 4;
  if (get() != GI_FILE_VERSION) return "other version";
  get();   // reserved
  ULONG ulCell = get(); FLOAT fCell; memcpy(&fCell, &ulCell, 4);
  const ULONG ctRays = get(), ctBounces = get(), ctRec = get(), ctCells = get();
  if (buf.size() != 32 + (size_t)ctRec * 16 + (size_t)ctCells * 4) return "wrong size";
  // index the world's brushes by their entity's ID; sectors of a brush's first mip on demand
  std::unordered_map<ULONG, CBrush3D *> mapBrushes;
  FOREACHINDYNAMICARRAY(wo.wo_baBrushes.ba_abrBrushes, CBrush3D, itbr) {
    if (itbr->br_penEntity != NULL) mapBrushes[itbr->br_penEntity->en_ulID] = &*itbr;
  }
  std::unordered_map<ULONG, std::vector<CBrushSector *> > mapSectors;
  DropBake();
  _polys.reserve(ctRec);
  std::vector<float> ind;
  ind.reserve((size_t)ctCells * 3);
  const size_t atCells = 32 + (size_t)ctRec * 16;
  int iCellFile = 0, ctSkipped = 0;
  for (ULONG ir = 0; ir < ctRec; ir++) {
    const ULONG iB = get(), iS = get(), iP = get(), ulG = get();
    const int w = (ulG >> 8) & 0xFFF, h = (ulG >> 20) & 0xFFF;
    const int iFirstFile = iCellFile;
    iCellFile += w * h;
    auto itB = mapBrushes.find(iB);
    if (itB == mapBrushes.end()) { ctSkipped++; continue; }   // entity not in this session
    std::vector<CBrushSector *> &asc = mapSectors[iB];
    if (asc.empty()) {
      CBrushMip *pbm = itB->second->GetFirstMip();
      if (pbm != NULL) { FOREACHINDYNAMICARRAY(pbm->bm_abscSectors, CBrushSector, itbsc) asc.push_back(&*itbsc); }
    }
    if (iS >= asc.size() || (INDEX)iP >= asc[iS]->bsc_abpoPolygons.Count()) { DropBake(); return "polygon out of range"; }
    CBrushPolygon &bpo = asc[iS]->bsc_abpoPolygons[iP];
    GIPoly gp;
    memset(&gp, 0, sizeof(gp));
    gp.pbpo = &bpo;
    gp.iMip = ulG & 0xFF; gp.w = w; gp.h = h;
    const CBrushShadowMap &bsm = bpo.bpo_smShadowMap;
    if (gp.w != std::max(1, (int)(bsm.sm_mexWidth >> gp.iMip)) || gp.h != std::max(1, (int)(bsm.sm_mexHeight >> gp.iMip))) {
      DropBake(); return "shadow map size differs";
    }
    gp.key[0] = iB; gp.key[1] = iS; gp.key[2] = iP;
    gp.receiver = true;
    gp.iFirst = (int)(ind.size() / 3);
    if (atCells + (size_t)(iFirstFile + w * h) * 4 > buf.size()) { DropBake(); return "cells out of range"; }
    for (int i = 0; i < w * h; i++) {
      const unsigned char *pub = &buf[atCells + (size_t)(iFirstFile + i) * 4];
      float c[3]; FromRGB9E5(pub[0] | (pub[1] << 8) | (pub[2] << 16) | ((ULONG)pub[3] << 24), c);
      ind.push_back(c[0]); ind.push_back(c[1]); ind.push_back(c[2]);
    }
    _map[&bpo] = (int)_polys.size();
    _polys.push_back(gp);
  }
  if ((ULONG)iCellFile != ctCells) { DropBake(); return "cell count differs"; }
  if (ctSkipped > 0) CPrintF("GI: %d baked polygons belong to entities not in this session\n", ctSkipped);
  _ind.swap(ind);
  _pwoBaked = &wo;
  _fBakeCell = fCell; _iBakeRays = ctRays; _iBakeBounces = ctBounces;
  return NULL;
}

static void TryLoad(void)
{
  _bLoadPending = FALSE;
  CWorld &wo = _pNetwork->ga_World;
  if (!gi_bLoad || wo.wo_fnmFileName == "") return;
  const CTFileName fnm = BakeFileName(wo);
  if (!FileExists(fnm)) {
    if (gi_bVerbose) CPrintF("GI: no bake %s\n", (const char *)fnm);
    return;
  }
  const double t0 = emscripten_get_now();
  const char *strError = LoadBake(wo, fnm);
  if (strError != NULL) { CPrintF("GI: not using %s: %s\n", (const char *)fnm, strError); return; }
  CPrintF("GI: loaded %s: %d polygons, %d cells (%.2f m, %d rays, %d bounces) in %.0f ms\n",
          (const char *)fnm, (int)_polys.size(), (int)(_ind.size() / 3), _fBakeCell, _iBakeRays,
          _iBakeBounces, emscripten_get_now() - t0);
}

void GI_Load(void)
{
  _bLoadPending = FALSE;
  UncacheAll();
  DropBake();
  const BOOL bOld = gi_bVerbose; gi_bVerbose = TRUE;
  TryLoad();
  gi_bVerbose = bOld;
  UncacheAll();
}

// World/World.cpp CWorld::Clear: the polygons are about to go away
void SE1GI_WorldCleared(CWorld *pwo)
{
  if (pwo != &_pNetwork->ga_World) return;
  DropBake();
  _bLoadPending = TRUE;
}

// ---------- engine hooks ----------

static inline const GIPoly *Lookup(CBrushPolygon *pbpo)
{
  if (_bLoadPending && !_bComputing) TryLoad();
  if (_bComputing || !gi_bEnable || _pwoBaked == NULL || _polys.empty()) return NULL;
  auto it = _map.find(pbpo);
  if (it == _map.end()) return NULL;
  const GIPoly &gp = _polys[it->second];
  return gp.receiver ? &gp : NULL;
}

// Light/LayerMixer.cpp MixOneMipmap: scale the sector ambient
void SE1GI_AdjustAmbient(CBrushPolygon *pbpo, COLOR &colAmbient)
{
  if (gi_fAmbient == 1.0f || Lookup(pbpo) == NULL) return;
  UBYTE r, g, b; ColorToRGB(colAmbient, r, g, b);
  const float f = Clamp(gi_fAmbient, 0.0f, 4.0f);
  colAmbient = RGBToColor((UBYTE)Clamp(r * f, 0.0f, 255.0f), (UBYTE)Clamp(g * f, 0.0f, 255.0f),
                          (UBYTE)Clamp(b * f, 0.0f, 255.0f)) | (colAmbient & CT_AMASK);
}

// Light/LayerMixer.cpp MixOneMipmap: add the indirect term to one mixed mip
void SE1GI_AddIndirect(CBrushShadowMap *pbsm, INDEX iMip, ULONG *pul, PIX pixSizeU, PIX pixSizeV, PIX pixCanvasU)
{
  const GIPoly *pgp = Lookup(pbsm->GetBrushPolygon());
  if (pgp == NULL || gi_fStrength <= 0.0f) return;
  const GIPoly &gp = *pgp;
  const float fScale = (float)(1 << iMip) / (float)(1 << gp.iMip);  // target texel -> grid cell
  const float k = 128.0f * gi_fStrength;
  for (PIX y = 0; y < pixSizeV; y++) {
    UBYTE *pub = (UBYTE *)(pul + y * pixCanvasU);
    const float v = (y + 0.5f) * fScale - 0.5f;
    for (PIX x = 0; x < pixSizeU; x++, pub += 4) {
      float e[3];
      Bilinear(_ind, gp, (x + 0.5f) * fScale - 0.5f, v, e);
      for (int c = 0; c < 3; c++) {
        int s = pub[c] + (int)(e[c] * k + 0.5f);
        pub[c] = (UBYTE)(s > 255 ? 255 : s);
      }
    }
  }
}

// Brushes/BrushShadows.cpp IsShadowFlat: a polygon with indirect light is not flat
BOOL SE1GI_PreventsFlat(CBrushPolygon *pbpo)
{
  return Lookup(pbpo) != NULL && gi_fStrength > 0.0f;
}

// Rendering/RenderModels.cpp FindModelLights: indirect light under the model goes to its ambient
void SE1GI_AddModelAmbient(CBrushPolygon *pbpo, FLOAT fpixU, FLOAT fpixV, SLONG &slR, SLONG &slG, SLONG &slB)
{
  const GIPoly *pgp = Lookup(pbpo);
  if (pgp == NULL) return;
  const GIPoly &gp = *pgp;
  const INDEX iFirst = pbpo->bpo_smShadowMap.sm_iFirstMipLevel;
  const float fScale = (float)(1 << iFirst) / (float)(1 << gp.iMip);
  float e[3];
  Bilinear(_ind, gp, fpixU * fScale - 0.5f, fpixV * fScale - 0.5f, e);
  const float k = 128.0f * gi_fStrength;
  if (gi_fAmbient != 1.0f) {
    const float f = Clamp(gi_fAmbient, 0.0f, 4.0f);
    slR = (SLONG)(slR * f); slG = (SLONG)(slG * f); slB = (SLONG)(slB * f);
  }
  slR += (SLONG)(e[0] * k); slG += (SLONG)(e[1] * k); slB += (SLONG)(e[2] * k);
}

// viewpoints for before/after screenshots: GI_Where() prints the local player's placement,
// GI_Pose(x, y, z, heading) puts it there (as Se1ModHost's debug teleport)
static CEntity *LocalPlayer(void)
{
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (!(pen->GetFlags() & ENF_DELETED) && (pen->GetFlags() & ENF_ALIVE) && IsDerivedFromClass(pen, "Player")) return pen;
  }
  return NULL;
}

void GI_Where(void)
{
  CEntity *pen = LocalPlayer();
  if (pen == NULL) { CPrintF("GI: no player\n"); return; }
  const CPlacement3D &pl = pen->GetPlacement();
  CPrintF("GI: player at %.2f %.2f %.2f heading %.1f\n", pl.pl_PositionVector(1), pl.pl_PositionVector(2),
          pl.pl_PositionVector(3), pl.pl_OrientationAngle(1));
}

void GI_Pose(FLOAT fX, FLOAT fY, FLOAT fZ, FLOAT fHeading)
{
  CEntity *pen = LocalPlayer();
  if (pen == NULL) return;
  pen->Teleport(CPlacement3D(FLOAT3D(fX, fY, fZ), ANGLE3D(fHeading, 0, 0)), FALSE);
}

void SE1GI_DeclareSymbols(void)
{
  _pShell->DeclareSymbol("user INDEX gi_bEnable;", &gi_bEnable);
  _pShell->DeclareSymbol("user INDEX gi_bLoad;", &gi_bLoad);
  _pShell->DeclareSymbol("user void GI_Save(void);", (void *)&GI_Save);
  _pShell->DeclareSymbol("user void GI_Load(void);", (void *)&GI_Load);
  _pShell->DeclareSymbol("user INDEX gi_iRays;", &gi_iRays);
  _pShell->DeclareSymbol("user INDEX gi_iBounces;", &gi_iBounces);
  _pShell->DeclareSymbol("user FLOAT gi_fCellSize;", &gi_fCellSize);
  _pShell->DeclareSymbol("user FLOAT gi_fStrength;", &gi_fStrength);
  _pShell->DeclareSymbol("user FLOAT gi_fAmbient;", &gi_fAmbient);
  _pShell->DeclareSymbol("user FLOAT gi_fFullbright;", &gi_fFullbright);
  _pShell->DeclareSymbol("user FLOAT gi_fAlbedo;", &gi_fAlbedo);
  _pShell->DeclareSymbol("user INDEX gi_bVerbose;", &gi_bVerbose);
  _pShell->DeclareSymbol("user INDEX gi_iThreads;", &gi_iThreads);
  _pShell->DeclareSymbol("user FLOAT gi_fSky;", &gi_fSky);
  _pShell->DeclareSymbol("user INDEX gi_colSky;", &gi_colSky);
  _pShell->DeclareSymbol("user void GI_Compute(void);", (void *)&GI_Compute);
  _pShell->DeclareSymbol("user void GI_Clear(void);", (void *)&GI_Clear);
  _pShell->DeclareSymbol("user void GI_Refresh(void);", (void *)&GI_Refresh);
  _pShell->DeclareSymbol("user void GI_Where(void);", (void *)&GI_Where);
  _pShell->DeclareSymbol("user void GI_Pose(FLOAT, FLOAT, FLOAT, FLOAT);", (void *)&GI_Pose);
}
