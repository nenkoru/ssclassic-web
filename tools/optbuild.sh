#!/bin/sh
# Build the threaded demo build for perf work in any checkout, a git worktree included:
#   tools/optbuild.sh [build dir=build-opt]
# Bootstraps what a fresh worktree lacks (the native ecc, copied from the main checkout when it has
# one; the generated entity sources), configures like build-web-tfe-mt (release, -O3 -flto, names
# kept for profiles, demo data from the main checkout's data/tfe-demo), then runs ninja.
# Serve the result with: tools/perfsnap.py <build dir> <name> --port N (or tools/devserver.py).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MAIN=$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)/.." && pwd)
BDIR=${1:-build-opt}
cd "$ROOT"
command -v emcc >/dev/null 2>&1 || . "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
if [ ! -x tools/bin/ecc-SamTFE ]; then
  if [ -x "$MAIN/tools/bin/ecc-SamTFE" ]; then mkdir -p tools/bin && cp "$MAIN/tools/bin/ecc-SamTFE" tools/bin/
  else tools/build_ecc.sh SamTFE; fi
fi
tools/gen_entities.sh SamTFE
DATA=${SE1_DATA_DIR:-$MAIN/data/tfe-demo}
if [ ! -f "$BDIR/build.ninja" ]; then
  emcmake cmake -S port -B "$BDIR" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSE1_DEV=OFF -DSE1_DEMO=ON \
    -DSE1_PROFILE=ON -DSE1_RUSTMOD=ON -DSE1_THREADS=ON -DDATA_DIR="$DATA" >/dev/null
fi
ninja -C "$BDIR" ${NINJA_JOBS:+-j$NINJA_JOBS} serioussam   # NINJA_JOBS=N: when several builds share the machine
