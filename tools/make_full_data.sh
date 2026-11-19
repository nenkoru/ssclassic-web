#!/bin/sh
# Assemble a playable full-game data folder for the web build from a retail install
# (Steam, CD or GOG), the way upstream's README describes for Linux:
#   repo game files (src/<game>: scripts, data, SE1_10b.gro, ...)
#   + the retail *.gro archives, Help and Levels
#   + web-port extras (port/data: mod-layer config, capture/bench scripts).
#
#   tools/make_full_data.sh SamTFE <retail dir> [out dir]     (default out: data/tfe-full-web)
#   tools/make_full_data.sh SamTSE <retail dir> [out dir]     (default out: data/tse-full-web)
#
# On macOS, Steam won't install the Windows-only games; download the depots from the Steam console
# (steam://open/console) instead: download_depot 41050 41051 (TFE), download_depot 41060 41061 (TSE).
# Game data stays under the ignored data/ folder: never commit it.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GAME=${1:?usage: make_full_data.sh SamTFE|SamTSE <retail dir> [out dir]}
RETAIL=${2:?usage: make_full_data.sh SamTFE|SamTSE <retail dir> [out dir]}
case "$GAME" in
  SamTFE) DEF=tfe-full-web ;;
  SamTSE) DEF=tse-full-web ;;
  *) echo "unknown game $GAME" >&2; exit 2 ;;
esac
OUT=${3:-$ROOT/data/$DEF}
REPO="$ROOT/src/$GAME"
ls "$RETAIL"/*.gro >/dev/null 2>&1 || { echo "no *.gro files in $RETAIL" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
# 1. repo-provided game files (everything except sources and Windows tools)
for d in Controls Data Demos Help Mods Players Scripts VirtualTrees SE1_10b.gro ModEXT.txt; do
  [ -e "$REPO/$d" ] && cp -R "$REPO/$d" "$OUT/"
done
mkdir -p "$OUT/Levels" "$OUT/SaveGame" "$OUT/Temp" "$OUT/Bin"
# 2. retail archives, help and levels on top
cp "$RETAIL"/*.gro "$OUT/"
[ -d "$RETAIL/Help" ] && cp -R "$RETAIL/Help/." "$OUT/Help/"
[ -d "$RETAIL/Levels" ] && cp -R "$RETAIL/Levels/." "$OUT/Levels/"
# 3. web-port extras (mod layer config, capture/bench scripts)
cp -R "$ROOT/port/data/." "$OUT/"
du -sh "$OUT"
ls "$OUT"
