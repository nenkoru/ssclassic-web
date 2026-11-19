/* Web port: aim assist for gamepad and touch look (port/web/gamepad.js, port/web/touch.js).
 *
 * Built into the entities library (it needs CPlayer and the enemy classes). The engine thread
 * calls SE1Aim_Apply from CControls::CreateAction (GameMP/Game.cpp) once per action, and
 * SE1Aim_Friction / SE1Aim_NoteAssistedInput from CInput::GetInput (SDLInput.cpp). The page's
 * main thread calls SE1_SetAimAssist, so the level is atomic; everything else lives on the
 * engine thread.
 *
 * Two effects, both only while an assisted device (pad or touch) was used in the last 3 s; the
 * mouse is never assisted:
 *  - friction: assisted look input is scaled down while the target is near the crosshair;
 *  - pull: the view turns toward the target by a fraction of the remaining angle per second.
 * pa_aRotation is an angle change in degrees (CPlayer accumulates it into m_aLocalRotation;
 * heading + = left, pitch + = up), so the pull is added in degrees, scaled by real frame time.
 * Only the local player's own action changes, so this also works in co-op.
 */
#include "Entities/StdH/StdH.h"
#include "Entities/EnemyBase.h"
#include "Entities/Player.h"

#include <Engine/World/WorldRayCasting.h>
#include <emscripten.h>

#include <atomic>
#include <math.h>

struct AimLevel {
  float fFrictionCone;   // degrees from the crosshair
  float fFriction;       // look speed factor inside it
  float fPullCone;       // degrees (0 = no pull)
  float fPull;           // fraction of the angle error removed per second
  bool  bPullAlways;     // false: only while the player is looking with the stick / touch
};
static const AimLevel _alLevels[4] = {
  {  0.0f, 1.0f,  0.0f, 0.0f,  false },   // 0 off
  {  4.0f, 0.6f,  0.0f, 0.0f,  false },   // 1 low: friction only
  {  6.0f, 0.5f,  6.0f, 0.25f, false },   // 2 medium: friction + gentle pull while aiming
  { 10.0f, 0.4f, 12.0f, 0.90f, true  },   // 3 high: strong pull, near lock-on
};
static const FLOAT AIM_RANGE = 60.0f;          // metres
static const double STICKY_S = 0.25;       // keep a target this long before re-picking
static const double ASSISTED_S = 3.0;      // an assisted device counts as "in use" this long
static const double LOOKING_S = 0.15;      // "the player is aiming" window for the medium pull
static const int MAX_RAYS = 8;             // line-of-sight checks per re-pick (monsters behind
                                           // walls must not hide a visible one further out)
static const double RETRY_S = 0.1;         // after a search found nothing, wait before the next

static std::atomic<int> _iLevel{0};
static double _tmLastAssisted = -1e9;      // real time of the last pad/touch look input
static double _tmLastApply = -1;
static CEntityPointer _penTarget;
static double _tmTargetSet = -1e9;
static float _fTargetAngle = 1e9f;         // angle to the current target, for the friction

static double now_s(void) { return _pTimer->GetHighPrecisionTimer().GetSeconds(); }

static CPlayer *player_of(const CPlayerCharacter &pc)
{
  /* the player entity this action is for (the same lookup as ctl_ComposeActionPacket) */
  INDEX ct = CEntity::GetMaxPlayers();
  for (INDEX i = 0; i < ct; i++) {
    CPlayer *pen = (CPlayer *)CEntity::GetPlayerEntity(i);
    if (pen != NULL && pen->en_pcCharacter == pc) return pen;
  }
  return NULL;
}

static BOOL alive_enemy(CEntity *pen)
{
  return pen != NULL && !(pen->GetFlags() & ENF_DELETED) && (pen->GetFlags() & ENF_ALIVE)
      && IsDerivedFromClass(pen, "Enemy Base") && ((CLiveEntity *)pen)->GetHealth() > 0.0f;
}

static FLOAT3D aim_point(CEntity *pen)
{
  FLOATaabbox3D box;
  pen->GetBoundingBox(box);   // current, in world coordinates
  return box.Center();
}

/* angle (degrees) between the view direction and the direction to a point */
static float angle_to(const FLOAT3D &vEye, const FLOAT3D &vDir, const FLOAT3D &vPoint, FLOAT *pfDist)
{
  FLOAT3D vTo = vPoint - vEye;
  FLOAT fDist = vTo.Length();
  if (pfDist) *pfDist = fDist;
  if (fDist < 0.01f) return 0.0f;
  FLOAT fDot = (vDir % vTo) / fDist;
  return (float)acos(Clamp(fDot, -1.0f, 1.0f)) * (180.0f / PI);
}

static BOOL visible(CPlayer *penPlayer, const FLOAT3D &vEye, CEntity *pen)
{
  CCastRay crRay(penPlayer, vEye, aim_point(pen));
  crRay.cr_ttHitModels = CCastRay::TT_NONE;   // walls only
  crRay.cr_bHitTranslucentPortals = FALSE;
  crRay.cr_bPhysical = FALSE;                 // what the player can see, not invisible collision walls
  crRay.cr_penIgnore = penPlayer;
  _pNetwork->ga_World.CastRay(crRay);
  // only walls block (a ray can also stop at the target itself or at another monster)
  CEntity *penHit = crRay.cr_penHit;
  return penHit == NULL || penHit == pen || penHit->GetRenderType() != CEntity::RT_BRUSH;
}

/* keep the current target for a moment; otherwise pick the visible enemy closest to the crosshair */
static CEntity *pick_target(CPlayer *penPlayer, const FLOAT3D &vEye, const FLOAT3D &vDir, float fCone, double tm)
{
  CEntity *penCur = _penTarget.ep_pen;
  if (alive_enemy(penCur) && tm - _tmTargetSet < STICKY_S) return penCur;
  if (penCur == NULL && tm - _tmTargetSet < RETRY_S) return NULL;

  CEntity *apBest[MAX_RAYS] = { NULL };
  float afBest[MAX_RAYS];
  for (int i = 0; i < MAX_RAYS; i++) afBest[i] = 1e9f;
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (!alive_enemy(pen)) continue;
    FLOAT fDist;
    float fAngle = angle_to(vEye, vDir, aim_point(pen), &fDist);
    if (fDist > AIM_RANGE || fAngle > fCone) continue;
    for (int i = 0; i < MAX_RAYS; i++) {   // insert into the sorted best list
      if (fAngle < afBest[i]) {
        for (int j = MAX_RAYS - 1; j > i; j--) { afBest[j] = afBest[j - 1]; apBest[j] = apBest[j - 1]; }
        afBest[i] = fAngle; apBest[i] = pen;
        break;
      }
    }
  }
  CEntity *penNew = NULL;
  for (int i = 0; i < MAX_RAYS && apBest[i] != NULL; i++) {
    if (visible(penPlayer, vEye, apBest[i])) { penNew = apBest[i]; break; }
  }
  _penTarget = penNew;
  _tmTargetSet = tm;
  return penNew;
}

extern "C" EMSCRIPTEN_KEEPALIVE void SE1_SetAimAssist(int level)
{
  _iLevel.store(Clamp(level, 0, 3), std::memory_order_relaxed);
}

extern "C" EMSCRIPTEN_KEEPALIVE int SE1_GetAimAssist(void)
{
  return _iLevel.load(std::memory_order_relaxed);
}

extern "C" void SE1Aim_NoteAssistedInput(void) { _tmLastAssisted = now_s(); }

extern "C" float SE1Aim_Friction(void)
{
  int level = _iLevel.load(std::memory_order_relaxed);
  if (level == 0 || now_s() - _tmLastAssisted > ASSISTED_S || _penTarget.ep_pen == NULL) return 1.0f;
  const AimLevel &al = _alLevels[level];
  return _fTargetAngle < al.fFrictionCone ? al.fFriction : 1.0f;
}

extern "C" void SE1Aim_Apply(const CPlayerCharacter *ppc, float *pfHeading, float *pfPitch)
{
  double tm = now_s();
  double dt = _tmLastApply < 0 ? 0.0 : Clamp(tm - _tmLastApply, 0.0, 0.1);
  _tmLastApply = tm;
  _fTargetAngle = 1e9f;

  int level = _iLevel.load(std::memory_order_relaxed);
  if (level == 0 || tm - _tmLastAssisted > ASSISTED_S) { _penTarget = NULL; return; }
  CPlayer *penPlayer = player_of(*ppc);
  if (penPlayer == NULL || !(penPlayer->GetFlags() & ENF_ALIVE)) return;

  CPlacement3D plView;
  penPlayer->GetLerpedAbsoluteViewPlacement(plView);
  FLOAT3D vEye = plView.pl_PositionVector, vDir;
  AnglesToDirectionVector(plView.pl_OrientationAngle, vDir);

  const AimLevel &al = _alLevels[level];
  CEntity *penTarget = pick_target(penPlayer, vEye, vDir, Max(al.fFrictionCone, al.fPullCone), tm);
  if (penTarget == NULL) return;

  // heading / pitch the view would need to point at the target
  FLOAT3D vTo = aim_point(penTarget) - vEye;
  if (vTo.Length() < 0.01f) return;
  ANGLE3D aTo;
  DirectionVectorToAngles(vTo.Normalize(), aTo);
  FLOAT fErrH = NormalizeAngle(aTo(1) - plView.pl_OrientationAngle(1));
  FLOAT fErrP = aTo(2) - plView.pl_OrientationAngle(2);
  _fTargetAngle = angle_to(vEye, vDir, aim_point(penTarget), NULL);

  if (al.fPull <= 0.0f || _fTargetAngle > al.fPullCone) return;
  if (!al.bPullAlways && tm - _tmLastAssisted > LOOKING_S) return;   // medium: only while aiming

  // remove fPull of the error per second (0.9: 90% gone after 1 s), never more than the error
  FLOAT k = Clamp(FLOAT(1.0 - pow(1.0 - al.fPull, dt)), 0.0f, 1.0f);
  *pfHeading += fErrH * k;
  *pfPitch += fErrP * k;
}

/* tests (tools/gamepadtest.mjs): degrees between the crosshair and the current target, -1 if none */
extern "C" EMSCRIPTEN_KEEPALIVE float SE1_AimDebug(void)
{
  return (_penTarget.ep_pen != NULL && _fTargetAngle < 1e8f) ? _fTargetAngle : -1.0f;
}
