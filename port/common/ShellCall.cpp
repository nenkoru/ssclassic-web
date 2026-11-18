/* Calling engine functions from the console/script shell on wasm.
 *
 * Upstream (non-Win32) calls every script-callable C++ function as
 *   f(void*, void*, void*, void*, void*)
 * whatever its real parameters are. That is undefined behaviour that happens to work on
 * x86/ARM, but in wasm an indirect call with the wrong signature traps. Here we call through
 * JS instead: a wasm function invoked from JS accepts any argument list (extra args are
 * dropped, missing ones become 0), so we only need to pass each 4-byte argument slot as the
 * right JS number (f32 for FLOAT slots) and pass the hidden struct-return pointer for
 * functions returning CTString.
 *
 * Functions using NEXTARGUMENT (Shell.h) walk the argument block through a global on
 * Emscripten, because taking &pArgs of a wasm parameter does not give the next argument.
 */
#include <emscripten.h>

extern "C" {
void *_pSE1ShellArgs = 0;
}

EM_JS(double, se1_shell_jscall, (void *pfn, int iFloatMask, int ctArgs, void *pvSRet, void **apvArgs), {
  var args = [];
  for (var i = 0; i < ctArgs; i++) {
    var p = apvArgs + i * 4;
    args.push((iFloatMask & (1 << i)) ? HEAPF32[p >> 2] : HEAP32[p >> 2]);
  }
  if (pvSRet) args.unshift(pvSRet);
  var r = wasmTable.get(pfn).apply(null, args);
  return (r === undefined) ? 0 : r;
});

extern "C" double SE1_ShellCall(void *pfn, int iFloatMask, int ctArgs, void *pvSRet, void **apvArgs)
{
  // nested shell calls may happen inside pfn: save/restore the NEXTARGUMENT cursor
  void *pOld = _pSE1ShellArgs;
  _pSE1ShellArgs = apvArgs;
  double r = se1_shell_jscall(pfn, iFloatMask, ctArgs, pvSRet, apvArgs);
  _pSE1ShellArgs = pOld;
  return r;
}
