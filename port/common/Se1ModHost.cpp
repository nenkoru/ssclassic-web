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

static void host_log(const char *msg) { CPrintF("%s\n", msg); }
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
  _bModReady = se1mod_init(&host) == 0;
  if (!_bModReady) CPrintF("se1mod: init failed\n");
}

void SE1Mod_Frame(void) { if (_bModReady) se1mod_frame(_pTimer->GetHighPrecisionTimer().GetSeconds()); }
void SE1Mod_LevelStarted(const char *strWorld) { if (_bModReady) se1mod_level_started(strWorld); }
void SE1Mod_Shutdown(void) { if (_bModReady) se1mod_shutdown(); _bModReady = FALSE; }
