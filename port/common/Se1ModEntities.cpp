/* Entity-typed half of the se1mod host (port/common/Se1ModHost.cpp lives in the engine library,
 * which can't see entity class layouts). Built into the entities library; the host calls these
 * through the prototypes in Se1ModEntities.h. Used by gameplay mods such as Serious Survivors:
 * monster variants and elites, visual effects, pickups, the player's weapons and ammo.
 * Asset rule: a missing model/texture/sound is fatal in this engine, so the mod only asks for
 * classes and variants whose data exists (it checks files first).
 */
#include "Entities/StdH/StdH.h"
#include "Entities/EnemyBase.h"
#include "Entities/Headman.h"
#include "Entities/Eyeman.h"
#include "Entities/Scorpman.h"
#include "Entities/Walker.h"
#include "Entities/Beast.h"
#include "Entities/Elemental.h"
#include "Entities/BasicEffects.h"
#include "Entities/Effector.h"
#include "Entities/Projectile.h"
#include "Entities/HealthItem.h"
#include "Entities/ArmorItem.h"
#include "Entities/AmmoItem.h"
#include "Entities/WeaponItem.h"
#include "Entities/Player.h"
#include "Entities/PlayerWeapons.h"

#include "Se1ModEntities.h"

CEntity *SE1ModEnt_SpawnEnemy(CWorld &wo, const char *cls, int variant, const FLOAT3D &pos, float hpMul,
                              float stretch, ULONG glow, int boss, CEntity *penPlayer)
{
  CPlacement3D pl(pos, ANGLE3D(0, 0, 0));
  CEntity *pen = wo.CreateEntity_t(pl, CTFileName(CTString(cls)));   // throws char *
  if (!IsDerivedFromClass(pen, "Enemy Base")) { pen->Initialize(); return pen; }
  CEnemyBase *peb = (CEnemyBase *)pen;
  // variants and size: before Initialize (Main reads them)
  if (variant >= 0) {
    if (IsOfClass(pen, "Headman"))        ((CHeadman *)pen)->m_hdtType = (HeadmanType)variant;
    else if (IsOfClass(pen, "Eyeman"))    ((CEyeman *)pen)->m_EecChar = (EyemanChar)variant;
    else if (IsOfClass(pen, "Scorpman"))  ((CScorpman *)pen)->m_smtType = (ScorpmanType)variant;
    else if (IsOfClass(pen, "Walker"))    ((CWalker *)pen)->m_EwcChar = (WalkerChar)variant;
    else if (IsOfClass(pen, "Beast"))     ((CBeast *)pen)->m_bcType = (BeastType)variant;
    else if (IsOfClass(pen, "Elemental")) ((CElemental *)pen)->m_EecChar = (ElementalCharacter)variant;
  }
  if (IsOfClass(pen, "Elemental")) ((CElemental *)pen)->m_EetType = ELT_LAVA;   // the only type with data
  if (stretch > 0.0f) peb->m_fStretchMultiplier = stretch;
  if (glow != 0) peb->m_colColor = glow;
  peb->m_bBoss = boss != 0;
  pen->Initialize();
  // health and behaviour: after Initialize (Main sets the class defaults)
  if (hpMul > 0.0f && hpMul != 1.0f) {
    peb->m_fMaxHealth *= hpMul;
    peb->SetHealth(peb->GetHealth() * hpMul);
  }
  peb->m_fDamageWounded = Max(peb->m_fDamageWounded, 0.35f * peb->m_fMaxHealth);   // auras don't stun-lock
  peb->m_tmGiveUp = 1e6f;          // relentless: don't give up when the player is out of sight
  if (penPlayer != NULL) {
    peb->m_penEnemy = penPlayer;   // hunt at once (StandardBehavior starts Active with an enemy)
    peb->m_ttTarget = TT_HARD;
  }
  return pen;
}

CEntity *SE1ModEnt_SpawnItem(CWorld &wo, const char *cls, int type, const FLOAT3D &pos)
{
  CPlacement3D pl(pos, ANGLE3D(0, 0, 0));
  CEntity *pen = wo.CreateEntity_t(pl, CTFileName(CTString(cls)));
  if (IsOfClass(pen, "Health Item"))      ((CHealthItem *)pen)->m_EhitType = (HealthItemType)type;
  else if (IsOfClass(pen, "Armor Item"))  ((CArmorItem *)pen)->m_EaitType = (ArmorItemType)type;
  else if (IsOfClass(pen, "Ammo Item"))   ((CAmmoItem *)pen)->m_EaitType = (AmmoItemType)type;
  else if (IsOfClass(pen, "Weapon Item")) ((CWeaponItem *)pen)->m_EwitType = (WeaponItemType)type;
  pen->Initialize();
  return pen;
}

void SE1ModEnt_Effect(CWorld &wo, int type, const FLOAT3D &pos, float size)
{
  ESpawnEffect ese;
  ese.colMuliplier = C_WHITE | CT_OPAQUE;
  ese.betType = (BasicEffectType)type;
  ese.vNormal = FLOAT3D(0, 1, 0);
  ese.vDirection = FLOAT3D(0, 0, -1);
  float s = Max(size, 0.01f);
  ese.vStretch = FLOAT3D(s, s, s);
  CEntity *pen = wo.CreateEntity_t(CPlacement3D(pos, ANGLE3D(0, 0, 0)), CTFILENAME("Classes\\BasicEffect.ecl"));
  pen->Initialize(ese);
}

void SE1ModEnt_Lightning(CWorld &wo, const FLOAT3D &from, const FLOAT3D &to, float size, float life)
{
  ESpawnEffector ese;
  ese.eetType = ET_LIGHTNING;
  ese.vDestination = to;
  ese.tmLifeTime = life;
  ese.fSize = size;
  ese.ctCount = 8;
  CEntity *pen = wo.CreateEntity_t(CPlacement3D(from, ANGLE3D(0, 0, 0)), CTFILENAME("Classes\\Effector.ecl"));
  pen->Initialize(ese);
}

void SE1ModEnt_Projectile(CWorld &wo, CEntity *penLauncher, int type, const FLOAT3D &pos, const FLOAT3D &dir, float speed)
{
  ANGLE3D ang;
  DirectionVectorToAngles(dir, ang);
  CEntity *pen = wo.CreateEntity_t(CPlacement3D(pos, ang), CTFILENAME("Classes\\Projectile.ecl"));
  ELaunchProjectile elp;
  elp.penLauncher = penLauncher;
  elp.prtType = (ProjectileType)type;
  elp.fSpeed = speed;
  pen->Initialize(elp);
}

float SE1ModEnt_MaxHealth(CEntity *pen)
{
  return IsDerivedFromClass(pen, "Enemy Base") ? ((CEnemyBase *)pen)->m_fMaxHealth : 0.0f;
}

static CPlayerWeapons *weapons(CEntity *penPlayer)
{
  if (penPlayer == NULL || !IsDerivedFromClass(penPlayer, "Player")) return NULL;
  return ((CPlayer *)penPlayer)->GetPlayerWeapons();
}
int SE1ModEnt_Weapon(CEntity *penPlayer)
{
  CPlayerWeapons *pw = weapons(penPlayer);
  return pw != NULL ? (int)pw->m_iCurrentWeapon : 0;
}
int SE1ModEnt_WeaponsOwned(CEntity *penPlayer)
{
  CPlayerWeapons *pw = weapons(penPlayer);
  return pw != NULL ? (int)pw->m_iAvailableWeapons : 0;
}
void SE1ModEnt_Ammo(CEntity *penPlayer, int *out)
{
  CPlayerWeapons *pw = weapons(penPlayer);
  for (int i = 0; i < 12; i++) out[i] = 0;
  if (pw == NULL) return;
  out[0] = pw->m_iBullets;     out[1] = pw->m_iShells;      out[2] = pw->m_iRockets;
  out[3] = pw->m_iGrenades;    out[4] = pw->m_iElectricity; out[5] = pw->m_iIronBalls;
  out[6] = pw->m_iMaxBullets;  out[7] = pw->m_iMaxShells;   out[8] = pw->m_iMaxRockets;
  out[9] = pw->m_iMaxGrenades; out[10] = pw->m_iMaxElectricity; out[11] = pw->m_iMaxIronBalls;
}
void SE1ModEnt_GiveAmmo(CEntity *penPlayer, int aitType, int amount)
{
  if (penPlayer == NULL || amount <= 0) return;
  EAmmoItem eai;
  eai.EaitType = (AmmoItemType)aitType;
  eai.iQuantity = amount;
  penPlayer->ReceiveItem(eai);
}
void SE1ModEnt_GiveWeapon(CEntity *penPlayer, int witType)
{
  if (penPlayer == NULL) return;
  EWeaponItem ewi;
  ewi.iWeapon = witType;
  ewi.iAmmo = -1;          // the weapon's default ammo
  ewi.bDropped = FALSE;
  penPlayer->ReceiveItem(ewi);
}
void SE1ModEnt_Armor(CEntity *penPlayer, float add, float max)
{
  if (penPlayer == NULL || !IsDerivedFromClass(penPlayer, "Player")) return;
  CPlayer *pl = (CPlayer *)penPlayer;
  if (pl->m_fArmor < max) pl->m_fArmor = Min(pl->m_fArmor + add, max);
}
float SE1ModEnt_Armor(CEntity *penPlayer)
{
  if (penPlayer == NULL || !IsDerivedFromClass(penPlayer, "Player")) return 0;
  return ((CPlayer *)penPlayer)->m_fArmor;
}
void SE1ModEnt_Eye(CEntity *penPlayer, FLOAT3D &pos, FLOAT3D &dir)
{
  CPlacement3D pl = ((CPlayerEntity *)penPlayer)->en_plViewpoint;
  pl.RelativeToAbsolute(penPlayer->GetPlacement());
  if (IsDerivedFromClass(penPlayer, "Player")) ((CPlayer *)penPlayer)->GetLerpedAbsoluteViewPlacement(pl);
  pos = pl.pl_PositionVector;
  AnglesToDirectionVector(pl.pl_OrientationAngle, dir);
}
