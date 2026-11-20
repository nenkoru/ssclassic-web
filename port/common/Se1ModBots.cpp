/* Bots for the se1mod host (host API v8, notes/bots.md).
 *
 * Bots are server-side virtual players (CServer::AddVirtualPlayer): other clients see normal
 * players. Once per simulated tick the server calls _pSE1ServerTickHook, which runs the mod's
 * se1mod_bot_tick; the mod reads what each bot senses through the calls below and sets its action
 * with bot_action. Everything here runs on the engine thread, inside the server loop. */
#include <Engine/Engine.h>
#include <Engine/Entities/Entity.h>
#include <Engine/Entities/PlayerCharacter.h>
#include <Engine/Classes/PlayerEntity.h>
#include <Engine/Network/Network.h>
#include <Engine/Network/Server.h>
#include <Engine/Network/SessionState.h>
#include <Engine/Network/PlayerTarget.h>
#include <Engine/Network/PlayerSource.h>
#include <Engine/World/World.h>
#include <Engine/World/WorldRayCasting.h>
#include "se1mod.h"
#include "Se1ModEntities.h"

static bool is_bot(int id) { return _pNetwork->IsServer() && _pNetwork->ga_srvServer.IsVirtualPlayer(id); }

static CEntity *player_entity(int id)
{
  CSessionState &ses = _pNetwork->ga_sesSessionState;
  if (id < 0 || id >= ses.ses_apltPlayers.Count()) return NULL;
  CPlayerTarget &plt = ses.ses_apltPlayers[id];
  if (!plt.IsActive()) return NULL;
  return plt.plt_penPlayerEntity;
}
static bool live(CEntity *pen)
{
  return pen != NULL && !(pen->GetFlags() & ENF_DELETED) && (pen->GetFlags() & ENF_ALIVE);
}

/* the local player's character, renamed, with its own GUID: same look as the host's player */
static int bot_add(const char *name)
{
  if (!_pNetwork->IsServer()) return -1;
  CPlayerCharacter pc;
  for (INDEX i = 0; i < _pNetwork->ga_aplsPlayers.Count(); i++) {
    CEntity *pen = player_entity(_pNetwork->ga_aplsPlayers[i].pls_Index);
    if (pen != NULL) { pc = ((CPlayerEntity *)pen)->en_pcCharacter; break; }
  }
  pc.pc_strName = name;
  ULONG h = 2166136261u;
  for (const char *c = name; *c; c++) h = (h ^ (UBYTE)*c) * 16777619u;
  for (INDEX i = 0; i < PLAYERGUIDSIZE; i++) { pc.pc_aubGUID[i] = UBYTE(h >> ((i % 4) * 8)); h = h * 1103515245u + 12345u; }
  return _pNetwork->ga_srvServer.AddVirtualPlayer(pc);
}
static void bot_remove(int id)
{
  if (is_bot(id)) _pNetwork->ga_srvServer.RemoveVirtualPlayer(id);
}
/* eye x y z, heading, pitch (degrees, the engine's: heading +left, pitch +up), health, armor, weapon */
static int bot_state(int id, float *out8)
{
  CEntity *pen = player_entity(id);
  if (pen == NULL) return 0;
  FLOAT3D p, d;
  SE1ModEnt_Eye(pen, p, d);
  out8[0] = p(1); out8[1] = p(2); out8[2] = p(3);
  out8[3] = atan2f(-d(1), -d(3)) * 180.0f / PI;
  out8[4] = asinf(Clamp(d(2), -1.0f, 1.0f)) * 180.0f / PI;
  out8[5] = live(pen) ? ((CLiveEntity *)pen)->GetHealth() : 0.0f;
  out8[6] = SE1ModEnt_Armor(pen);
  out8[7] = (float)SE1ModEnt_Weapon(pen);
  return 1;
}
static void bot_action(int id, const float *move3, const float *rot3, uint32_t buttons)
{
  if (!is_bot(id)) return;
  CPlayerAction pa;
  pa.Clear();
  pa.pa_vTranslation = FLOAT3D(move3[0], move3[1], move3[2]);
  pa.pa_aRotation = ANGLE3D(rot3[0], rot3[1], rot3[2]);
  pa.pa_aViewRotation = ANGLE3D(0, 0, 0);
  pa.pa_ulButtons = buttons;
  _pNetwork->ga_srvServer.SetVirtualAction(id, pa);
}
/* distance to the first solid hit from `from` toward `to`, or -1 when clear */
static float host_ray(const float *from3, const float *to3, int hit_models)
{
  CCastRay cr(NULL, FLOAT3D(from3[0], from3[1], from3[2]), FLOAT3D(to3[0], to3[1], to3[2]));
  cr.cr_ttHitModels = hit_models ? CCastRay::TT_SIMPLE : CCastRay::TT_NONE;
  cr.cr_bHitPortals = FALSE;
  cr.cr_bHitTranslucentPortals = FALSE;
  cr.cr_bPhysical = TRUE;
  _pNetwork->ga_World.CastRay(cr);
  return cr.cr_penHit != NULL ? cr.cr_fHitDistance : -1.0f;
}
/* live enemies: entity id, then x y z health */
static int host_enemies(int32_t *ids, float *pos4, int max)
{
  int n = 0;
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (n >= max) break;
    if (!live(pen) || !IsDerivedFromClass(pen, "Enemy Base")) continue;
    float hp = ((CLiveEntity *)pen)->GetHealth();
    if (hp <= 0) continue;
    const FLOAT3D &v = pen->GetPlacement().pl_PositionVector;
    ids[n] = (int32_t)pen->en_ulID;
    pos4[n * 4 + 0] = v(1); pos4[n * 4 + 1] = v(2); pos4[n * 4 + 2] = v(3); pos4[n * 4 + 3] = hp;
    n++;
  }
  return n;
}
/* items that can be picked up now: kind 0 health, 1 armor, 2 ammo, 3 weapon. A picked-up item
   that waits to respawn shows its editor model, so only RT_MODEL ones count. */
static int host_items(int32_t *kinds, float *pos3, int max)
{
  static const char *classes[4] = { "Health Item", "Armor Item", "Ammo Item", "Weapon Item" };
  int n = 0;
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (n >= max) break;
    if ((pen->GetFlags() & ENF_DELETED) || pen->GetRenderType() != CEntity::RT_MODEL) continue;
    for (int k = 0; k < 4; k++) {
      if (!IsOfClass(pen, classes[k])) continue;
      const FLOAT3D &v = pen->GetPlacement().pl_PositionVector;
      kinds[n] = k; pos3[n * 3 + 0] = v(1); pos3[n * 3 + 1] = v(2); pos3[n * 3 + 2] = v(3);
      n++;
      break;
    }
  }
  return n;
}
/* live players that are not bots: their positions (followed by the bots) */
static int host_humans(float *pos3, int max)
{
  int n = 0;
  CSessionState &ses = _pNetwork->ga_sesSessionState;
  for (INDEX i = 0; i < ses.ses_apltPlayers.Count() && n < max; i++) {
    if (is_bot(i)) continue;
    CEntity *pen = player_entity(i);
    if (!live(pen) || ((CLiveEntity *)pen)->GetHealth() <= 0) continue;
    const FLOAT3D &v = pen->GetPlacement().pl_PositionVector;
    pos3[n * 3 + 0] = v(1); pos3[n * 3 + 1] = v(2); pos3[n * 3 + 2] = v(3);
    n++;
  }
  return n;
}
/* the union of the level's brush boxes */
static int host_world_bounds(float *min3, float *max3)
{
  FLOATaabbox3D box;
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if ((pen->GetFlags() & ENF_DELETED) || pen->GetRenderType() != CEntity::RT_BRUSH) continue;
    FLOATaabbox3D b;
    pen->GetBoundingBox(b);
    /* some brush entities (empty or editor-only ones) report infinite or absurd boxes: skip them */
    bool sane = true;
    for (int k = 1; k <= 3; k++) {
      if (!(Abs(b.Min()(k)) < 1e5f) || !(Abs(b.Max()(k)) < 1e5f)) sane = false;
    }
    if (sane) box |= b;
  }
  if (box.IsEmpty()) return 0;
  min3[0] = box.Min()(1); min3[1] = box.Min()(2); min3[2] = box.Min()(3);
  max3[0] = box.Max()(1); max3[1] = box.Max()(2); max3[2] = box.Max()(3);
  return 1;
}
static int host_is_server(void) { return _pNetwork->IsServer() ? 1 : 0; }

static void server_tick(void) { se1mod_bot_tick(); }

/* is this player entity one of this server's bots? (local_player in Se1ModHost.cpp skips them) */
bool SE1ModBots_IsBot(CEntity *pen)
{
  if (pen == NULL || !_pNetwork->IsServer()) return false;
  CSessionState &ses = _pNetwork->ga_sesSessionState;
  for (INDEX i = 0; i < ses.ses_apltPlayers.Count(); i++) {
    if (ses.ses_apltPlayers[i].plt_penPlayerEntity == pen) return is_bot(i);
  }
  return false;
}

void SE1ModBots_Register(SE1ModHost &host)
{
  host.bot_add = bot_add;
  host.bot_remove = bot_remove;
  host.bot_state = bot_state;
  host.bot_action = bot_action;
  host.ray = host_ray;
  host.enemies = host_enemies;
  host.items = host_items;
  host.humans = host_humans;
  host.world_bounds = host_world_bounds;
  host.is_server = host_is_server;
  _pSE1ServerTickHook = server_tick;
}
