#!/bin/sh
# Build the native entity compiler (ecc) that tools/gen_entities.sh runs: tools/bin/ecc-<game>.
# Same sources and defines as the upstream CMake "ecc" target (src/<game>/Sources/CMakeLists.txt),
# compiled directly so no SDL/zlib/upstream configure is needed. Needs a host C++ compiler,
# flex and bison.
#
#   tools/build_ecc.sh [SamTFE|SamTSE]   (default SamTFE; rebuilt only when a source is newer)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GAME=${1:-SamTFE}
ECC_DIR="$ROOT/src/$GAME/Sources/Ecc"
OUT="$ROOT/tools/bin/ecc-$GAME"
CXX=${CXX_HOST:-c++}

[ -d "$ECC_DIR" ] || { echo "no such game: $GAME" >&2; exit 2; }
mkdir -p "$ROOT/tools/bin"
cd "$ECC_DIR"

# generated parser/scanner (gitignored), as upstream's add_parser_and_scanner()
# (--defines=Parser.h: leave the tracked Parser.hpp alone)
[ Parser.cpp -nt Parser.y ] && [ -f Parser.h ] || bison -o Parser.cpp --defines=Parser.h Parser.y 2>/dev/null
[ Scanner.cpp -nt Scanner.l ] || flex -o Scanner.cpp Scanner.l

if [ -x "$OUT" ] && [ "$OUT" -nt Main.cpp ] && [ "$OUT" -nt Parser.cpp ] && [ "$OUT" -nt Scanner.cpp ]; then
  echo "ecc-$GAME: up to date"
  exit 0
fi

DEFS="-DPLATFORM_UNIX=1 -DPRAGMA_ONCE=1 -DUNIX -D_MT=1 -D_REENTRANT=1 -DFASTBITS -DNDEBUG=1 -D_NDEBUG=1"
[ "$GAME" = SamTFE ] && DEFS="$DEFS -DFIRST_ENCOUNTER=1"
# shellcheck disable=SC2086
$CXX -std=gnu++14 -O1 -w -fms-extensions -fsigned-char -fno-strict-aliasing $DEFS -I.. \
  Main.cpp Parser.cpp Scanner.cpp -o "$OUT"
echo "ecc-$GAME: built $OUT"
