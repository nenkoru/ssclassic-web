#!/bin/sh
# Assemble a playable TFE demo data folder (data/tfe-demo) the same way
# upstream build-linux64demo.sh does: repo game files + official demo + 1.05 patch.
# Expects data/tfe-demo-raw/Disk1 (7z x SeriousSamDemo.exe; 7z x serioussampatch105_usa.exe).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RAW="$ROOT/data/tfe-demo-raw/Disk1"
OUT="$ROOT/data/tfe-demo"
REPO="$ROOT/src/SamTFE"

rm -rf "$OUT" && mkdir -p "$OUT"
# 1. repo-provided game files (everything except sources and Windows tools)
for d in Controls Data Demos Help Mods Players Scripts SE1_10b.gro ModEXT.txt; do
  [ -e "$REPO/$d" ] && cp -R "$REPO/$d" "$OUT/"
done
mkdir -p "$OUT/Levels" "$OUT/SaveGame" "$OUT/Temp" "$OUT/Bin"
# 2. official demo + patch on top, keeping the repo's GLSettings
cp -R "$OUT/Scripts/GLSettings" "$OUT/.GLSettings.keep"
(cd "$RAW" && tar cf - --exclude='*.exe' --exclude='*.ex_' --exclude='*.bmp' --exclude='*.inx' \
   --exclude='*.hdr' --exclude='*.bin' --exclude='*.cab' --exclude='*.ini' --exclude='*.log' \
   --exclude='Bin' --exclude='Tools.Win32' .) | (cd "$OUT" && tar xf -)
rm -rf "$OUT/Scripts/GLSettings" && mv "$OUT/.GLSettings.keep" "$OUT/Scripts/GLSettings"
# 3. web-port extras (mod layer config etc.)
cp -R "$ROOT/port/data/." "$OUT/"
du -sh "$OUT"
ls "$OUT"
