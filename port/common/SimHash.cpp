/* Simulation hash: the behaviour oracle for engine optimizations (tools/perfbench.mjs --check).
 *
 * With ?simhash=1, every processed game tick folds the engine's own sync checksum
 * (CSessionState::ChecksumForSync, extensive level 2: every entity's state, the random seed, the
 * movers) into a running hash, and keeps the running hash per tick. A demo replays the same ticks
 * on every build, so two builds that simulate alike give the same list; the first tick where the
 * lists differ is where behaviour changed. Off by default: the checksum walks every entity.
 *
 * Page side: Module._SE1_SimHashCount() ticks recorded, Module._SE1_SimHashAt(i) the hash after
 * tick i (plain shared memory: callable from the page's main thread in the threaded build). */
#include <Engine/Engine.h>
#include <Engine/Network/Network.h>
#include <Engine/Network/SessionState.h>
#include <emscripten.h>

#define SE1_SIMHASH_MAX 65536
static ULONG _hashes[SE1_SIMHASH_MAX];
static volatile int _count;
static int _enabled = -1;

extern "C" void SE1_SimHashTick(CSessionState *ses)
{
  if (_enabled < 0) _enabled = MAIN_THREAD_EM_ASM_INT({ return new URLSearchParams(location.search).get('simhash') === '1' ? 1 : 0; });
  if (!_enabled || _count >= SE1_SIMHASH_MAX) return;
  ULONG crc;
  CRC_Start(crc);
  if (_count > 0) CRC_AddLONG(crc, _hashes[_count - 1]);
  ses->ChecksumForSync(crc, 2);
  CRC_Finish(crc);
  _hashes[_count] = crc;
  _count = _count + 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int SE1_SimHashCount(void) { return _count; }
extern "C" EMSCRIPTEN_KEEPALIVE unsigned SE1_SimHashAt(int i) { return i >= 0 && i < _count ? _hashes[i] : 0; }
