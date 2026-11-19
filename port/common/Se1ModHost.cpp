/* Engine side of the se1mod interface (port/common/se1mod.h): builds the SE1ModHost table
 * from the engine's console shell, and forwards engine events to the Rust mod layer.
 * Engine call sites (guarded by SE1_WITH_RUSTMOD) call the SE1Mod_* wrappers below.
 */
#include <Engine/Engine.h>
#include <Engine/Base/Shell.h>
#include <Engine/Base/Shell_internal.h>
#include <Engine/Base/ParsingSymbols.h>

#include "se1mod.h"
 #include "Se1ModEntities.h"
#include <unordered_map>
#include <unordered_set>
#include <Engine/Sound/SoundObject.h>

static ShellTypeType symbol_type(const char *name)
{
  CShellSymbol *pss = _pShell->GetSymbol(CTString(name), TRUE);
  if (pss == NULL || pss->ss_istType < 0) return STT_ILLEGAL;
  return _shell_ast[pss->ss_istType].st_sttType;
}

static void host_log(const char *msg);   /* defined below: engine log + browser console */
static void host_shell_execute(const char *script) { _pShell->Execute(CTString(script)); }
static int host_get_index(const char *name, int32_t *out) {
  if (symbol_type(name) != STT_INDEX) return 0;
  *out = (int32_t)_pShell->GetINDEX(CTString(name)); return 1;
}
static int host_get_float(const char *name, float *out) {
  if (symbol_type(name) != STT_FLOAT) return 0;
  *out = _pShell->GetFLOAT(CTString(name)); return 1;
}
static int host_set_index(const char *name, int32_t v) {
  if (symbol_type(name) != STT_INDEX) return 0;
  _pShell->SetINDEX(CTString(name), (INDEX)v); return 1;
}
static int host_set_float(const char *name, float v) {
  if (symbol_type(name) != STT_FLOAT) return 0;
  _pShell->SetFLOAT(CTString(name), v); return 1;
}
static int host_set_string(const char *name, const char *v) {
  if (symbol_type(name) != STT_STRING) return 0;
  _pShell->SetString(CTString(name), CTString(v)); return 1;
}

/* ---- API 2: gameplay ---- */
#include <Engine/Entities/Entity.h>
#include <Engine/Network/Network.h>
#include <Engine/World/World.h>
#include <Engine/Classes/BaseEvents.h>
#include <emscripten.h>
#ifdef SE1_THREADS
#include <emscripten/threading.h>
#endif

#define MAX_HANDLES 2048
 static CEntityPointer _apenHandles[MAX_HANDLES];   /* references keep the entity's memory valid */
static std::unordered_map<ULONG, int> _mapHandleOf;   /* entity ID -> handle, for the damage hook */
static int _iInModDamage = 0;   /* > 0 while the mod's own host.damage is in flight */
static int _iHurtSerial = 0;
static float _hurtPos[3] = {0, 0, 0};
static float _hurtAmount = 0.0f;

void SE1ModBots_Register(SE1ModHost &host);   /* Se1ModBots.cpp */
bool SE1ModBots_IsBot(CEntity *pen);
static CEntity *local_player(void)
{
  /* the first live player entity that isn't one of this server's bots */
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (!(pen->GetFlags() & ENF_DELETED) && (pen->GetFlags() & ENF_ALIVE) && IsDerivedFromClass(pen, "Player") &&
        !SE1ModBots_IsBot(pen)) return pen;
  }
  return NULL;
}
static int handle_ok(int h) { return h > 0 && h < MAX_HANDLES && _apenHandles[h] != NULL; }

static double host_game_time(void) { return _pTimer->CurrentTick(); }
static int host_player(float *pos, float *health)
{
  CEntity *pen = local_player();
  if (pen == NULL) return 0;
  const FLOAT3D &v = pen->GetPlacement().pl_PositionVector;
  pos[0] = v(1); pos[1] = v(2); pos[2] = v(3);
  *health = ((CLiveEntity *)pen)->GetHealth();
  return *health > 0;
}
static int host_player_view(float *dir)
{
  CEntity *pen = local_player();
  if (pen == NULL) return 0;
  CPlacement3D pl = ((CPlayerEntity *)pen)->en_plViewpoint;   // relative to the body
  pl.RelativeToAbsolute(pen->GetPlacement());
  FLOAT3D v;
  AnglesToDirectionVector(pl.pl_OrientationAngle, v);
  dir[0] = v(1); dir[1] = v(2); dir[2] = v(3);
  return 1;
}
static void host_player_heal(float amount, float max)
{
  CEntity *pen = local_player();
  if (pen == NULL) return;
  CLiveEntity *ple = (CLiveEntity *)pen;
  if (ple->GetHealth() <= 0) return;
  ple->SetHealth(Min(ple->GetHealth() + amount, Max(ple->GetHealth(), max)));
}
static int host_spawn(const char *cls, const float *pos)
{
  int h = 1;
  while (h < MAX_HANDLES && _apenHandles[h] != NULL) h++;
  if (h >= MAX_HANDLES) return 0;
  try {
    CPlacement3D pl(FLOAT3D(pos[0], pos[1], pos[2]), ANGLE3D(0, 0, 0));
    CEntity *pen = _pNetwork->ga_World.CreateEntity_t(pl, CTFileName(CTString(cls)));
    pen->Initialize();
    _apenHandles[h] = pen;
    return h;
  } catch (const char *strError) {
    CPrintF("se1mod: cannot spawn %s: %s\n", cls, strError);
    return 0;
  }
}
static int host_alive(int h)
{
  if (!handle_ok(h)) return 0;
  CEntity *pen = _apenHandles[h];
  if ((pen->GetFlags() & ENF_DELETED) || !(pen->GetFlags() & ENF_ALIVE)) return 0;
  return ((CLiveEntity *)pen)->GetHealth() > 0;
}
static int host_position(int h, float *pos)
{
  if (!host_alive(h)) return 0;
  const FLOAT3D &v = _apenHandles[h]->GetPlacement().pl_PositionVector;
  pos[0] = v(1); pos[1] = v(2); pos[2] = v(3);
  return 1;
}
 static void host_damage(int h, float amount)
 {
   if (!host_alive(h)) return;
   CEntity *pen = _apenHandles[h];
   CEntity *penPlayer = local_player();
   const FLOAT3D &v = pen->GetPlacement().pl_PositionVector;
  _iInModDamage++;
   pen->InflictDirectDamage(pen, penPlayer != NULL ? penPlayer : pen, DMT_BULLET, amount, v, FLOAT3D(0, 1, 0));
  _iInModDamage--;
 }
static void host_release(int h)
{
  if (h > 0 && h < MAX_HANDLES && _apenHandles[h] != NULL) _mapHandleOf.erase(_apenHandles[h]->en_ulID);
  if (h > 0 && h < MAX_HANDLES) _apenHandles[h] = NULL;
}
/* ---- API 4: gameplay toolkit ---- */
static int new_handle(CEntity *pen)
{
  for (int h = 1; h < MAX_HANDLES; h++) if (_apenHandles[h] == NULL) { _apenHandles[h] = pen; _mapHandleOf[pen->en_ulID] = h; return h; }
  return 0;
}
static int free_handles(void) { int n = 0; for (int h = 1; h < MAX_HANDLES; h++) n += _apenHandles[h] == NULL; return n; }
static int host_spawn_enemy(const char *cls, int variant, const float *pos, float hpMul, float stretch, uint32_t glow, int boss)
{
  if (free_handles() == 0) return 0;
  try {
    CEntity *pen = SE1ModEnt_SpawnEnemy(_pNetwork->ga_World, cls, variant, FLOAT3D(pos[0], pos[1], pos[2]), hpMul, stretch,
                                        (ULONG)glow, boss, local_player());
    return new_handle(pen);
  } catch (const char *strError) {
    CPrintF("se1mod: cannot spawn %s: %s\n", cls, strError);
    return 0;
  }
}
static float host_health(int h) { return host_alive(h) ? ((CLiveEntity *)&*_apenHandles[h])->GetHealth() : 0.0f; }
static float host_max_health(int h) { return handle_ok(h) ? SE1ModEnt_MaxHealth(_apenHandles[h]) : 0.0f; }
static int host_file_exists(const char *path) { return FileExists(CTFileName(CTString(path))) ? 1 : 0; }
static void host_effect(int type, const float *pos, float size)
{
  try { SE1ModEnt_Effect(_pNetwork->ga_World, type, FLOAT3D(pos[0], pos[1], pos[2]), size); }
  catch (const char *strError) { CPrintF("se1mod: effect: %s\n", strError); }
}
static void host_lightning(const float *a, const float *b, float size, float life)
{
  try { SE1ModEnt_Lightning(_pNetwork->ga_World, FLOAT3D(a[0], a[1], a[2]), FLOAT3D(b[0], b[1], b[2]), size, life); }
  catch (const char *strError) { CPrintF("se1mod: lightning: %s\n", strError); }
}
#define SOUND_POOL 8
static CSoundObject *_apsoSounds[SOUND_POOL];
static int _iNextSound = 0;
static void host_sound(const char *path, float volume)
{
  int i = _iNextSound++ % SOUND_POOL;
  if (_apsoSounds[i] == NULL) _apsoSounds[i] = new CSoundObject;   // after engine init
  try {
    _apsoSounds[i]->Play_t(CTFileName(CTString(path)), SOF_NONGAME);
    _apsoSounds[i]->SetVolume(volume, volume);
  } catch (const char *strError) { CPrintF("se1mod: sound %s: %s\n", path, strError); }
}
static int host_spawn_item(const char *cls, int type, const float *pos)
{
  if (free_handles() == 0) return 0;
  try { return new_handle(SE1ModEnt_SpawnItem(_pNetwork->ga_World, cls, type, FLOAT3D(pos[0], pos[1], pos[2]))); }
  catch (const char *strError) { CPrintF("se1mod: cannot spawn %s: %s\n", cls, strError); return 0; }
}
static int host_exists(int h) { return handle_ok(h) && !(_apenHandles[h]->GetFlags() & ENF_DELETED); }
static void host_set_position(int h, const float *pos)
{
  if (!host_exists(h)) return;
  CEntity *pen = _apenHandles[h];
  CPlacement3D pl = pen->GetPlacement();
  pl.pl_PositionVector = FLOAT3D(pos[0], pos[1], pos[2]);
  pen->SetPlacement(pl);
}
static void host_destroy(int h)
{
  if (!handle_ok(h)) return;
   if (!(_apenHandles[h]->GetFlags() & ENF_DELETED)) _apenHandles[h]->Destroy();
  _mapHandleOf.erase(_apenHandles[h]->en_ulID);
   _apenHandles[h] = NULL;
}
static int host_weapon(void) { return SE1ModEnt_Weapon(local_player()); }
static int host_weapons_owned(void) { return SE1ModEnt_WeaponsOwned(local_player()); }
static void host_ammo(int32_t *out) { int a[12]; SE1ModEnt_Ammo(local_player(), a); for (int i = 0; i < 12; i++) out[i] = a[i]; }
static void host_give_ammo(int type, int amount) { SE1ModEnt_GiveAmmo(local_player(), type, amount); }
static void host_give_weapon(int type) { SE1ModEnt_GiveWeapon(local_player(), type); }
static std::unordered_set<ULONG> _setModProjectiles;   // entity ids of projectiles host_projectile launched
static void host_projectile(int type, const float *pos, const float *dir, float speed)
{
  CEntity *penPlayer = local_player();
  if (penPlayer == NULL) return;
  try {
    CEntity *pen = SE1ModEnt_Projectile(_pNetwork->ga_World, penPlayer, type, FLOAT3D(pos[0], pos[1], pos[2]), FLOAT3D(dir[0], dir[1], dir[2]), speed);
    // the mod's projectiles (abilities, evolutions) fly as the player's, but their hits are the
    // mod's damage (source 2), not the player's gun: remember them for SE1Mod_Damage
    if (pen != NULL) {
      if (_setModProjectiles.size() > 4096) _setModProjectiles.clear();   // old ones are long gone
      _setModProjectiles.insert(pen->en_ulID);
    }
  }
  catch (const char *strError) { CPrintF("se1mod: projectile: %s\n", strError); }
}
static float host_armor(float add, float max)
{
  CEntity *pen = local_player();
  if (add > 0) SE1ModEnt_Armor(pen, add, max);
  return SE1ModEnt_Armor(pen);
}
static int host_player_eye(float *pos, float *dir)
{
  CEntity *pen = local_player();
  if (pen == NULL) return 0;
  FLOAT3D p, d;
  SE1ModEnt_Eye(pen, p, d);
  pos[0] = p(1); pos[1] = p(2); pos[2] = p(3);
  dir[0] = d(1); dir[1] = d(2); dir[2] = d(3);
  return 1;
}
static int host_player_hurt(float *from, float *amount)
{
  static int lastSerial = 0;
  if (_iHurtSerial == lastSerial) return 0;
  lastSerial = _iHurtSerial;
  from[0] = _hurtPos[0]; from[1] = _hurtPos[1]; from[2] = _hurtPos[2];
  *amount = _hurtAmount;
  _hurtAmount = 0.0f;
  return 1;
}

/* The game executable's main loop re-decides the pause every frame (SeriousSam.cpp
   UpdatePauseState), so the mod's pause is a flag it ORs in, and game-side actions go through a
   callback the executable registers (the engine library can't see the game's state). */
int _iSE1ModPause = 0;
void (*_pSE1ModGameCall)(int what) = NULL;   /* 1: close the computer */
static void host_set_pause(int on) { _iSE1ModPause = on ? 1 : 0; }
static void host_close_computer(void) { if (_pSE1ModGameCall != NULL) _pSE1ModGameCall(1); }

/* page side: Module[name], Module.se1ModUi(json) and a value the page posts back */
static volatile int32_t _iUiValue = -1;
extern "C" EMSCRIPTEN_KEEPALIVE void SE1Mod_UiSend(int v) { _iUiValue = v; }   /* called from the page */
#ifdef SE1_THREADS
static double host_page_option(const char *name) { return MAIN_THREAD_EM_ASM_DOUBLE({ return +(Module[UTF8ToString($0)] || 0); }, name); }
static void host_ui_post(const char *json) { MAIN_THREAD_EM_ASM({ if (Module.se1ModUi) Module.se1ModUi(UTF8ToString($0)); }, json); }
#else
static double host_page_option(const char *name) { return EM_ASM_DOUBLE({ return +(Module[UTF8ToString($0)] || 0); }, name); }
static void host_ui_post(const char *json) { EM_ASM({ if (Module.se1ModUi) Module.se1ModUi(UTF8ToString($0)); }, json); }
#endif
static void host_log(const char *msg)
{
  CPrintF("%s\n", msg);
  /* also the page's console: in the threaded build the engine log isn't readable from the page */
#ifdef SE1_THREADS
  MAIN_THREAD_EM_ASM({ console.log('[se1mod] ' + UTF8ToString($0)); }, msg);
#else
  EM_ASM({ console.log('[se1mod] ' + UTF8ToString($0)); }, msg);
#endif
}
static int host_ui_poll(void) { int v = _iUiValue; if (v >= 0) _iUiValue = -1; return v; }

static BOOL _bModReady = FALSE;

void SE1Mod_Init(void)
{
  static SE1ModHost host;
  host.api_version = SE1MOD_API_VERSION;
#ifdef FIRST_ENCOUNTER
  host.game = "SamTFE";
#else
  host.game = "SamTSE";
#endif
  host.data_dir = "/";
  host.log = host_log;
  host.shell_execute = host_shell_execute;
  host.get_index = host_get_index;
  host.get_float = host_get_float;
  host.set_index = host_set_index;
  host.set_float = host_set_float;
  host.set_string = host_set_string;
  host.game_time = host_game_time;
  host.player = host_player;
  host.player_heal = host_player_heal;
  host.spawn = host_spawn;
  host.alive = host_alive;
  host.position = host_position;
  host.damage = host_damage;
  host.release = host_release;
  host.set_pause = host_set_pause;
  host.page_option = host_page_option;
  host.ui_post = host_ui_post;
  host.ui_poll = host_ui_poll;
  host.close_computer = host_close_computer;
  host.player_view = host_player_view;
  host.spawn_enemy = host_spawn_enemy;
  host.health = host_health;
  host.max_health = host_max_health;
  host.file_exists = host_file_exists;
  host.effect = host_effect;
  host.lightning = host_lightning;
  host.sound = host_sound;
  host.spawn_item = host_spawn_item;
  host.exists = host_exists;
  host.set_position = host_set_position;
  host.destroy = host_destroy;
  host.weapon = host_weapon;
  host.weapons_owned = host_weapons_owned;
  host.ammo = host_ammo;
  host.give_ammo = host_give_ammo;
  host.give_weapon = host_give_weapon;
  host.projectile = host_projectile;
  host.armor = host_armor;
  host.player_eye = host_player_eye;
  host.player_hurt = host_player_hurt;
  SE1ModBots_Register(host);
  _bModReady = se1mod_init(&host) == 0;
  if (!_bModReady) host_log("se1mod: init failed (API version mismatch?)");
}

void SE1Mod_Frame(void) { if (_bModReady) se1mod_frame(_pTimer->GetHighPrecisionTimer().GetSeconds()); }
void SE1Mod_LevelStarted(const char *strWorld) { if (_bModReady) se1mod_level_started(strWorld); }
void SE1Mod_Shutdown(void) { if (_bModReady) se1mod_shutdown(); _bModReady = FALSE; }

/* Damage hook (API v6): ask the mod to scale the damage before it is applied.
   penDealing is the entity that deals the damage (this in CEntity::Inflict*); for a
   projectile it is the projectile itself, and SE1ModEnt_ProjectileWeapon maps it to
   the gun that fired it so the mod can credit the hit to that gun. */
FLOAT SE1Mod_Damage(CEntity *penDealing, CEntity *penTarget, CEntity *penInflictor, INDEX iDmt, FLOAT fAmount)
{
  if (!_bModReady || penTarget == NULL) return fAmount;
  // where the local player was hit from: only attacks by monsters (a rocket's inflictor is the
  // one who fired it); lava, falls and the world have no direction worth showing
  if (penTarget == local_player() && penInflictor != NULL && penInflictor != penTarget &&
      IsDerivedFromClass(penInflictor, "Enemy Base")) {
    const FLOAT3D &iv = penInflictor->GetPlacement().pl_PositionVector;
    _hurtPos[0] = iv(1); _hurtPos[1] = iv(2); _hurtPos[2] = iv(3);
    _hurtAmount += fAmount;
    _iHurtSerial++;
  }
  int src = _iInModDamage > 0 ? 2 : (penInflictor != NULL && penInflictor == local_player() ? 1 : 0);
  if (src == 1 && penDealing != NULL && _setModProjectiles.count(penDealing->en_ulID)) src = 2;   // a mod projectile
  std::unordered_map<ULONG, int>::const_iterator it = _mapHandleOf.find(penTarget->en_ulID);
  int h = it == _mapHandleOf.end() ? 0 : it->second;
  int weapon = penDealing != NULL ? SE1ModEnt_ProjectileWeapon(penDealing) : 0;
  return se1mod_damage(h, src, (int)iDmt, fAmount, weapon);
}
