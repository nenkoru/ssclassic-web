#!/bin/sh
# Run the native ecc over every entity listed in port/<game>/sources.cmake.
# Writes X.cpp / X.h / X_tables.h next to each X.es (same as upstream CMake).
# Also generates the flex/bison parsers the engine needs.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GAME=${1:?usage: gen_entities.sh SamTFE|SamTSE}
ECC="$ROOT/tools/bin/ecc-$GAME"
SRC="$ROOT/src/$GAME/Sources"
cd "$SRC"

# flex/bison parsers (engine console scripts + SKA model scripts)
for pair in "Engine/Base/Parser Engine/Base/Scanner" "Engine/Ska/smcPars Engine/Ska/smcScan"; do
  set -- $pair
  [ "$1.cpp" -nt "$1.y" ] || { bison -o"$1.cpp" "$1.y" -d 2>/dev/null; cp "$1.hpp" "$1.h"; }
  [ "$2.cpp" -nt "$2.l" ] || flex -o"$2.cpp" "$2.l"
done

n=0
for es in $(sed -n '/^set(ENGINE_ES$/,/^)$/p;/^set(GAME_ES$/,/^)$/p' "$ROOT/port/$GAME/sources.cmake" | grep -v '^set\|^)'); do
  if [ ! -f "$es.cpp" ] || [ "$es.es" -nt "$es.cpp" ]; then
    "$ECC" "$es.es" >/dev/null || { echo "ecc failed: $es" >&2; exit 1; }
    n=$((n+1))
  fi
done
echo "$GAME: generated $n entities"
