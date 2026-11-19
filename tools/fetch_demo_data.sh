#!/bin/sh
# Fetch the free official Serious Sam TFE demo + the 1.05 patch, verify them against pinned
# SHA-256 sums, unpack them into data/tfe-demo-raw/Disk1 and assemble data/tfe-demo
# (tools/make_demo_data.sh). Everything lands under data/, which is gitignored: game data is never
# committed. Downloads are kept in data/download (CI caches that folder) and reused when their
# checksum matches.
#
#   tools/fetch_demo_data.sh [--force]   (--force: unpack again even if Disk1 exists)
#
# Needs curl (or wget), 7z (p7zip) and sha256sum or shasum.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DL="$ROOT/data/download"
RAW="$ROOT/data/tfe-demo-raw"
FORCE=0
[ "$1" = "--force" ] && FORCE=1

# name|url|sha256
FILES="SeriousSamDemo.exe|https://archive.org/download/SeriousSamDemo/SeriousSamDemo.exe|029ec109adba4445e8c4365c88230c03fdad6abf98262a14c6fe88efdd686cd0
serioussampatch105_usa.exe|https://archive.org/download/SeriousSamPatches/serioussampatch105_usa.exe|57efedff534f4cc429924ae031016919bbf0ab8760eb00bf62419885c5e2429b"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --retry-delay 5 -o "$2" "$1"
  else wget -O "$2" "$1"; fi
}
SEVENZ=$(command -v 7z || command -v 7zz || command -v 7za || true)
[ -n "$SEVENZ" ] || { echo "fetch_demo_data: 7z not found (apt install p7zip-full / brew install p7zip)" >&2; exit 1; }

mkdir -p "$DL"
echo "$FILES" | while IFS='|' read -r name url sum; do
  f="$DL/$name"
  if [ -f "$f" ] && [ "$(sha256 "$f")" = "$sum" ]; then
    echo "have $name"
    continue
  fi
  echo "downloading $name"
  fetch "$url" "$f.part"
  got=$(sha256 "$f.part")
  if [ "$got" != "$sum" ]; then
    echo "fetch_demo_data: checksum mismatch for $name: got $got, want $sum" >&2
    rm -f "$f.part"
    exit 1
  fi
  mv "$f.part" "$f"
done

# both installers unpack into Disk1/; the patch goes on top of the demo
if [ $FORCE = 1 ] || [ ! -d "$RAW/Disk1" ]; then
  rm -rf "$RAW" && mkdir -p "$RAW"
  "$SEVENZ" x -y -bd -o"$RAW" "$DL/SeriousSamDemo.exe" >/dev/null
  "$SEVENZ" x -y -bd -o"$RAW" "$DL/serioussampatch105_usa.exe" >/dev/null
  echo "unpacked into $RAW/Disk1"
fi

"$ROOT/tools/make_demo_data.sh"
