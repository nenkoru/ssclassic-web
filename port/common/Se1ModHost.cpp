/* Engine side of the se1mod interface (port/common/se1mod.h): builds the SE1ModHost table
 * from the engine's console shell, and forwards engine events to the Rust mod layer.
 * Engine call sites (guarded by SE1_WITH_RUSTMOD) call the SE1Mod_* wrappers below.
 */
#include <Engine/Engine.h>
#include <Engine/Base/Shell.h>
#include <Engine/Base/Shell_internal.h>
#include <Engine/Base/ParsingSymbols.h>

#include "se1mod.h"

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

#define MAX_HANDLES 512
static CEntityPointer _apenHandles[MAX_HANDLES];   /* references keep the entity's memory valid */

static CEntity *local_player(void)
{
  /* single player: the first live player entity */
  FOREACHINDYNAMICCONTAINER(_pNetwork->ga_World.wo_cenEntities, CEntity, iten) {
    CEntity *pen = &*iten;
    if (!(pen->GetFlags() & ENF_DELETED) && (pen->GetFlags() & ENF_ALIVE) && IsDerivedFromClass(pen, "Player")) return pen;
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
  pen->InflictDirectDamage(pen, penPlayer != NULL ? penPlayer : pen, DMT_BULLET, amount, v, FLOAT3D(0, 1, 0));
}
static void host_release(int h) { if (h > 0 && h < MAX_HANDLES) _apenHandles[h] = NULL; }
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
  _bModReady = se1mod_init(&host) == 0;
  if (!_bModReady) host_log("se1mod: init failed (API version mismatch?)");
}

void SE1Mod_Frame(void) { if (_bModReady) se1mod_frame(_pTimer->GetHighPrecisionTimer().GetSeconds()); }
void SE1Mod_LevelStarted(const char *strWorld) { if (_bModReady) se1mod_level_started(strWorld); }
void SE1Mod_Shutdown(void) { if (_bModReady) se1mod_shutdown(); _bModReady = FALSE; }
