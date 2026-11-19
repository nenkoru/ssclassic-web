#!/bin/sh
# Unit tests for the port's C helpers, compiled with emcc and run under Node.
#   tests/run.sh [outdir]   (default build-tests/; needs emcc on PATH: source ~/emsdk/emsdk_env.sh)
# Exit code 0 when every test passes.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/build-tests}
mkdir -p "$OUT"
command -v emcc >/dev/null 2>&1 || { echo "tests/run.sh: emcc not found (source ~/emsdk/emsdk_env.sh)" >&2; exit 2; }

failed=0
# name | sources | flags (the same wrap/FS flags as port/CMakeLists.txt uses for these files)
run() {
  name=$1; shift
  srcs=$1; shift
  printf '%s: compiling\n' "$name"
  # shellcheck disable=SC2086
  if ! emcc -O2 -Wall -Wno-unused-function $srcs "$@" -sEXIT_RUNTIME=1 -o "$OUT/$name.js" >"$OUT/$name.build.log" 2>&1; then
    cat "$OUT/$name.build.log"
    echo "FAIL  $name (build)"
    failed=$((failed + 1))
    return
  fi
  if node "$OUT/$name.js"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    failed=$((failed + 1))
  fi
}

run fastsort "$ROOT/tests/fastsort_test.c $ROOT/port/common/FastSort.c"
run casefs "$ROOT/tests/casefs_test.c $ROOT/port/common/CaseFs.c" \
  -sWASMFS -Wl,--wrap=fopen -Wl,--wrap=open -Wl,--wrap=opendir

[ $failed = 0 ] && echo "unit tests: all passed" || echo "unit tests: $failed failed"
exit $((failed != 0))
