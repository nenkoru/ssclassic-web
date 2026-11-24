#!/usr/bin/env bash
# Static hosting bundle: one folder any static web host can serve as-is.
#   outdir/mt/  threaded build (needs cross-origin isolation; coi-sw.js adds it), with its
#               gamedata/ (big data files fetched on demand, when built with SE1_LAZY_DATA)
#   outdir/st/  single-threaded build (needs nothing)
#   outdir/index.html  landing page: picks the build the visitor's page can run
#   outdir/_headers    COOP/COEP for /mt/* (Netlify / Cloudflare Pages format)
#
#   tools/package.sh [--force] <outdir> [mt-build-dir] [st-build-dir]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
usage: package.sh [--force] <outdir> [mt-build-dir] [st-build-dir]

Build a static hosting bundle from the threaded (mt) and single-threaded (st)
builds. Defaults: build-mt and build-st next to the repo.
--force  empty <outdir> first (required if it exists and is not empty)
EOF
}

force=0
if [ "${1:-}" = "--force" ]; then force=1; shift; elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then usage; exit 0; fi

outdir="${1:?missing <outdir> (see -h)}"
mt_dir="${2:-$ROOT/build-mt}"
st_dir="${3:-$ROOT/build-st}"

die() { echo "package.sh: $*" >&2; exit 2; }

for d in "$mt_dir" "$st_dir"; do
  for f in serioussam.html serioussam.js serioussam.wasm serioussam.data; do
    [ -f "$d/$f" ] || die "$d is missing $f (build it first: ninja -C $(basename "$d"))"
  done
done
[ -f "$mt_dir/coi-sw.js" ] || die "$mt_dir is missing coi-sw.js (threaded build only)"

if [ -d "$outdir" ] && [ -n "$(ls -A "$outdir" 2>/dev/null)" ] && [ "$force" -eq 0 ]; then
  die "$outdir exists and is not empty (use --force to empty it)"
fi
if [ "$force" -eq 1 ]; then
  # --force empties the folder: never let a typo point it at something precious
  abs=$(mkdir -p "$outdir" && cd "$outdir" && pwd -P)
  case "$abs" in
    /|"$(cd "$HOME" && pwd -P)"|"$(cd "$ROOT" && pwd -P)") die "refusing to empty $abs" ;;
  esac
  rm -rf "$outdir"/*
fi

mkdir -p "$outdir/mt" "$outdir/st"
for f in serioussam.html serioussam.js serioussam.wasm serioussam.data; do
  cp "$mt_dir/$f" "$outdir/mt/"
  cp "$st_dir/$f" "$outdir/st/"
done
# lazy data (notes/lazy-data.md): the big files each page fetches on demand; hard links in the
# build dir, real copies here. Both builds' OPFS caches are keyed by content, so a visitor who
# switches builds doesn't download twice.
for b in mt st; do
  src=$mt_dir; [ "$b" = st ] && src=$st_dir
  if [ -d "$src/gamedata" ]; then cp -R "$src/gamedata" "$outdir/$b/"; fi
done
cp "$mt_dir/coi-sw.js" "$outdir/mt/"
cp "$ROOT/port/web/landing.html" "$outdir/index.html"

# Netlify / Cloudflare Pages header file: hosts that read it isolate /mt/* without
# a service worker; hosts that don't fall back to coi-sw.js.
cat > "$outdir/_headers" <<'EOF'
/mt/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
EOF

total=$(du -sk "$outdir" | cut -f1)
echo "package.sh: $outdir ready ($total KB)"
