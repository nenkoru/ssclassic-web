#!/usr/bin/env bash
# One-command test suite for the web port.
#
#   tools/test.sh [options] [THREADED_BUILD_DIR [SINGLE_THREADED_BUILD_DIR]]
#
# Without build dirs it builds (incrementally) build-test-mt (threaded) and build-test-st
# (single-threaded) with the release flags, bootstrapping what is missing first: the native entity
# compiler (tools/build_ecc.sh), the generated entity sources (tools/gen_entities.sh) and the demo
# data (tools/fetch_demo_data.sh). Build dirs given as arguments are used as they are.
# Then, for each build, behind its own tools/devserver.py:
#   - flowtest:     tools/flowtest.mjs (intro runs, a click starts a demo, Escape opens the menu)
#   - input:        tools/inputtest.mjs (mouse capture/re-capture, menu release, Space, fullscreen)
#   - survivors:    tools/svtest.mjs (?mode=survivors: level-up offer, pause, upgrade, spawns)
#   - touch, gamepad: tools/touchtest.mjs, tools/gamepadtest.mjs (emulated touches, fake gamepad,
#                   aim assist)
#   - persistence:  tools/persisttest.mjs (the user dir survives a reload: OPFS / IndexedDB)
#   - damage hook:  tools/damagetest.mjs (host API v5: player hits reach the mod)
#   - threaded only: tools/shimtest.mjs (no synchronous shader calls), tools/qualitytest.mjs
#                   (?quality=auto under CPU throttling)
#   - determinism:  two visual-regression captures (bench.mjs --shots) must match within a tight
#                   tolerance (SE1_SHOTDIFF_ARGS; a few muzzle-flash/flame pixels vary run to run)
#   - timedemo:     one timedemo run completes, no frame over SE1_MAX_FRAME_MS (no fps assertion)
# plus a two-browser co-op test on the threaded build (tools/mptest.mjs, also with --rtc for WebRTC,
# and tools/lobbytest.mjs; needs cargo for the LAN switch, otherwise skipped), the static hosting
# bundle on a plain static server (tools/package.sh + tools/packagetest.mjs), the unit tests (tests/run.sh) and the Rust tests (cargo test --workspace).
# Prints a PASS/FAIL/SKIP summary; exit code 1 on any failure.
#
# Options:
#   --build-only   only build (and bootstrap) the default build dirs, run no tests
#   --no-build     don't build: the build dirs must already contain serioussam.html
#   --skip-unit    don't run the unit tests
#   --webgpu       also capture with ?gfx=webgpu and compare with WebGL2 (8/8 within shotdiff's
#                  default tolerances); skipped when the browser has no WebGPU
#   --android      also run a timedemo on an Android phone (bench.mjs --android); only when
#                  ADB_SERIAL is set, otherwise skipped
#
# Environment:
#   SE1_TEST_OUT       results folder (default data/test-results: logs, captures, flow screenshots)
#   SE1_TEST_PORT      first dev-server port (default 8190; the second build uses +1)
#   SE1_DATA_DIR       game data for new builds (default data/tfe-demo, fetched when missing)
#   SE1_MAX_FRAME_MS   timedemo: worst allowed frame time in ms (default 3000)
#   SE1_SHOTDIFF_ARGS  determinism tolerance for tools/shotdiff.py (default
#                      "--max-mean 0.1 --max-changed 0.05"; "--exact" for bit-identical frames)
#   CHROME, SE1_ANGLE, SE1_CHROME_FLAGS, SE1_TIMEOUT_SCALE: browser settings, see tools/chrome.mjs
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

BUILD=1 BUILD_ONLY=0 UNIT=1 WEBGPU=0 ANDROID=0
DIRS=()
for a in "$@"; do
  case "$a" in
    --build-only) BUILD_ONLY=1 ;;
    --no-build) BUILD=0 ;;
    --skip-unit) UNIT=0 ;;
    --webgpu) WEBGPU=1 ;;
    --android) ANDROID=1 ;;
    -h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) DIRS+=("$a") ;;
  esac
done
MT_DIR=${DIRS[0]:-build-test-mt}
ST_DIR=${DIRS[1]:-build-test-st}
OWN_BUILDS=$(( ${#DIRS[@]} == 0 ))
OUT=${SE1_TEST_OUT:-$ROOT/data/test-results}
PORT=${SE1_TEST_PORT:-8190}
DATA=${SE1_DATA_DIR:-$ROOT/data/tfe-demo}
MAX_FRAME_MS=${SE1_MAX_FRAME_MS:-3000}
SHOTDIFF_ARGS=${SE1_SHOTDIFF_ARGS:---max-mean 0.1 --max-changed 0.05}

RESULTS=()
FAILED=0
result() {   # STATUS name detail
  RESULTS+=("$(printf '%-4s  %-28s %s' "$1" "$2" "${3:-}")")
  [ "$1" = FAIL ] && FAILED=$((FAILED + 1))
  printf '==> %s  %s %s\n' "$1" "$2" "${3:-}"
}
summary() {
  echo
  echo "================ test summary ================"
  for r in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "$r"; done
  echo "=============================================="
  if [ $FAILED -eq 0 ]; then echo "ALL PASSED"; else echo "$FAILED FAILED (logs and captures in $OUT)"; fi
}
step() { echo; echo "---- $* ----"; }

# run "$@" with its output shown and saved to $OUT/<log>.log; returns the command's status
logged() {
  local log=$1; shift
  "$@" 2>&1 | tee "$OUT/$log.log"
  return "${PIPESTATUS[0]}"
}

emsdk_env() {
  command -v emcc >/dev/null 2>&1 && return 0
  for f in "${EMSDK:-}/emsdk_env.sh" "$HOME/emsdk/emsdk_env.sh"; do
    # shellcheck disable=SC1090
    [ -f "$f" ] && . "$f" >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1 && return 0
  done
  echo "emcc not found: install emsdk 7.0.0 and source emsdk_env.sh" >&2
  return 1
}

rm -rf "$OUT" && mkdir -p "$OUT"

python3 tools/cleantmp.py >/dev/null 2>&1 || true   # leftovers of earlier runs (idle > 30 min)

# ---------------------------------------------------------------- build
build_one() {   # dir threads(ON|OFF)
  local dir=$1 threads=$2
  if [ ! -f "$dir/build.ninja" ]; then
    emcmake cmake -S port -B "$dir" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSE1_DEV=OFF -DSE1_DEMO=ON \
      -DSE1_PROFILE=ON -DSE1_RUSTMOD=ON -DSE1_THREADS="$threads" -DDATA_DIR="$DATA" || return 1
  fi
  ninja -C "$dir"
}
if [ $BUILD = 1 ] && [ $OWN_BUILDS = 1 ]; then
  step "build"
  emsdk_env || { result FAIL build "emsdk missing"; summary; exit 1; }
  ok=1
  logged bootstrap sh -c "tools/build_ecc.sh SamTFE && tools/gen_entities.sh SamTFE" || ok=0
  if [ $ok = 1 ] && [ ! -d "$DATA" ]; then
    if [ "$DATA" = "$ROOT/data/tfe-demo" ]; then logged fetch-data tools/fetch_demo_data.sh || ok=0
    else echo "SE1_DATA_DIR=$DATA does not exist" >&2; ok=0; fi
  fi
  [ $ok = 1 ] && { logged build-mt build_one "$MT_DIR" ON || ok=0; }
  [ $ok = 1 ] && { logged build-st build_one "$ST_DIR" OFF || ok=0; }
  if [ $ok = 1 ]; then result PASS build "$MT_DIR, $ST_DIR"
  else result FAIL build "see $OUT/*.log"; summary; exit 1; fi
fi
[ $BUILD_ONLY = 1 ] && { summary; exit $((FAILED != 0)); }

for d in "$MT_DIR" "$ST_DIR"; do
  [ -f "$d/serioussam.html" ] || { result FAIL "build $d" "no serioussam.html (build it, or drop --no-build)"; summary; exit 1; }
done

# ---------------------------------------------------------------- unit tests
if [ $UNIT = 1 ]; then
  step "unit tests"
  if emsdk_env && logged unit tests/run.sh "$ROOT/build-tests"; then result PASS "unit tests" "FastSort, CaseFs"
  else result FAIL "unit tests" "see $OUT/unit.log"; fi
  step "rust tests"
  if ! command -v cargo >/dev/null 2>&1; then result SKIP "rust tests" "no cargo"
  elif logged rust bash -c 'cd rust && cargo test --workspace'; then result PASS "rust tests" "mod config, Survivors tables, LAN switch"
  else result FAIL "rust tests" "see $OUT/rust.log"; fi
fi

# ---------------------------------------------------------------- dev servers
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done; wait 2>/dev/null
  python3 tools/cleantmp.py --min-age 2 >/dev/null 2>&1 || true   # Chrome profiles the tests left behind (2 min: not a parallel run's fresh one)
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

serve() {   # dir port [--no-isolate]
  python3 tools/devserver.py --port "$2" ${3:-} --shots-dir "$OUT/shots" --playtests-dir "$OUT/playtests" "$1" >"$OUT/devserver-$2.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 50); do
    curl -fsS -o /dev/null "http://127.0.0.1:$2/serioussam.html" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "dev server on port $2 did not start:" >&2; cat "$OUT/devserver-$2.log" >&2
  return 1
}

# threaded build behind COOP/COEP (as it needs); the single-threaded one without, as on a plain host
NAMES="mt st"
url_of() { [ "$1" = mt ] && echo "http://127.0.0.1:$PORT/serioussam.html" || echo "http://127.0.0.1:$((PORT + 1))/serioussam.html"; }
if ! { serve "$MT_DIR" "$PORT" && serve "$ST_DIR" $((PORT + 1)) --no-isolate; }; then
  result FAIL "dev servers" "ports $PORT/$((PORT + 1)) busy? (SE1_TEST_PORT)"; summary; exit 1
fi

# ---------------------------------------------------------------- per-build browser tests
frames_ok() {   # shotdiff log -> prints "N/M", status 0 when N == M > 0
  local line n m
  line=$(grep -Eo '[0-9]+/[0-9]+ frames ok' "$1" | tail -1 | cut -d' ' -f1)
  [ -n "$line" ] || { echo "no result"; return 1; }
  echo "$line"
  n=${line%/*} m=${line#*/}
  [ "$n" = "$m" ] && [ "$m" -gt 0 ]
}

for b in $NAMES; do
  url=$(url_of $b)

  step "$b: flow test"
  if logged "flow-$b" node tools/flowtest.mjs "$url" "$OUT/flow-$b"; then result PASS "$b flow test" "intro, click into a demo, Escape to menu"
  else result FAIL "$b flow test" "see $OUT/flow-$b.log"; fi

  step "$b: input"
  if logged "input-$b" node tools/inputtest.mjs "$url" "$OUT/input-$b"; then result PASS "$b input" "mouse capture and re-capture, menu release, Space, fullscreen"
  else result FAIL "$b input" "see $OUT/input-$b.log"; fi

  step "$b: survivors"
  if logged "sv-$b" node tools/svtest.mjs "$url" "$OUT/sv-$b"; then result PASS "$b survivors" "level-up offer, pause, upgrade, spawns"
  else result FAIL "$b survivors" "see $OUT/sv-$b.log"; fi

  step "$b: touch"
  if logged "touch-$b" node tools/touchtest.mjs "$url"; then result PASS "$b touch" "stick, look, buttons, two fingers, menu"
  else result FAIL "$b touch" "see $OUT/touch-$b.log"; fi

  step "$b: gamepad"
  if logged "pad-$b" node tools/gamepadtest.mjs "$url"; then result PASS "$b gamepad" "sticks, buttons, menus, aim assist off/high"
  else result FAIL "$b gamepad" "see $OUT/pad-$b.log"; fi

  step "$b: persistence"
  if logged "persist-$b" node tools/persisttest.mjs "$url"; then result PASS "$b persistence" "settings stored and kept across a reload"
  else result FAIL "$b persistence" "see $OUT/persist-$b.log"; fi

  step "$b: damage hook"
  if logged "damage-$b" node tools/damagetest.mjs "$url"; then result PASS "$b damage hook" "player hits reach the mod and get the rank bonus"
  else result FAIL "$b damage hook" "see $OUT/damage-$b.log"; fi

  step "$b: playtest recorder"
  if logged "rec-$b" node tools/playtesttest.mjs "$url" "$OUT/playtests"; then result PASS "$b playtest recorder" "timeline, markers and survey reach the dev server"
  else result FAIL "$b playtest recorder" "see $OUT/rec-$b.log"; fi

  if [ "$b" = mt ]; then   # threaded build only: the single-threaded build keeps these calls synchronous
    step "mt: shader programs"
    if logged "shim-mt" node tools/shimtest.mjs "$url"; then result PASS "mt shader programs" "no synchronous createProgram/uniformLocation"
    else result FAIL "mt shader programs" "see $OUT/shim-mt.log"; fi
    step "mt: quality controller"
    if logged "quality-mt" node tools/qualitytest.mjs "$url"; then result PASS "mt quality controller" "off by default, lowers under CPU load, restores"
    else result FAIL "mt quality controller" "see $OUT/quality-mt.log"; fi
  fi

  step "$b: capture determinism"
  ok=1
  logged "shots-$b-a" node tools/bench.mjs "$url" --shots "$b-a" || ok=0
  [ $ok = 1 ] && { logged "shots-$b-b" node tools/bench.mjs "$url" --shots "$b-b" || ok=0; }
  if [ $ok = 1 ]; then
    # shellcheck disable=SC2086
    python3 tools/shotdiff.py "$b-a" "$b-b" $SHOTDIFF_ARGS --shots-dir "$OUT/shots" >"$OUT/shotdiff-$b.log" 2>&1
    cat "$OUT/shotdiff-$b.log"
    if r=$(frames_ok "$OUT/shotdiff-$b.log"); then result PASS "$b capture determinism" "$r frames match ($(grep -Eo '[0-9]+ bit-identical' "$OUT/shotdiff-$b.log"))"
    else result FAIL "$b capture determinism" "$r (see $OUT/shotdiff-$b.log)"; fi
  else
    result FAIL "$b capture determinism" "capture failed (see $OUT/shots-$b-*.log)"
  fi

  step "$b: timedemo"
  if logged "timedemo-$b" node tools/bench.mjs "$url" 1; then
    if r=$(python3 - "$OUT/timedemo-$b.log" "$MAX_FRAME_MS" <<'EOF'
import json, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^run 1: (\{.*\})$", text, re.M)
if not m:
    print("no result line"); sys.exit(1)
s = json.loads(m.group(1)); limit = float(sys.argv[2])
info = f"{s['seconds']} s, {s['fps']} fps, p95 {s['p95']} ms, max {s['max']} ms"
ok = s["seconds"] > 0 and s["fps"] > 0 and s["max"] <= limit
print(info + ("" if ok else f" (limit: max <= {limit:g} ms, fps > 0)"))
sys.exit(0 if ok else 1)
EOF
    ); then result PASS "$b timedemo" "$r"
    else result FAIL "$b timedemo" "$r"; fi
  else
    result FAIL "$b timedemo" "did not complete (see $OUT/timedemo-$b.log)"
  fi
done

# ---------------------------------------------------------------- multiplayer (two browsers)
step "multiplayer"
# always (re)build: cargo is incremental, and a stale switch would test old relay code
if command -v cargo >/dev/null 2>&1; then
  logged build-se1-server bash -c 'cd rust && cargo build -p se1-server --release' || true
fi
if [ ! -x rust/target/release/se1-server ]; then result SKIP "multiplayer" "no switch binary (cargo build -p se1-server --release)"
elif logged mp node tools/mptest.mjs "$(url_of mt)" Levels/KarnakDemo.wld; then result PASS "multiplayer" "host + client over the LAN switch"
else result FAIL "multiplayer" "see $OUT/mp.log"; fi
if [ -x rust/target/release/se1-server ]; then
  step "multiplayer: WebRTC"
  if logged mp-rtc node tools/mptest.mjs "$(url_of mt)" Levels/KarnakDemo.wld --rtc; then result PASS "multiplayer WebRTC" "peer links open and carry the game traffic"
  else result FAIL "multiplayer WebRTC" "see $OUT/mp-rtc.log"; fi
  step "multiplayer: lobby"
  if logged lobby node tools/lobbytest.mjs "$(url_of mt)"; then result PASS "multiplayer lobby" "host and join from the page"
  else result FAIL "multiplayer lobby" "see $OUT/lobby.log"; fi
fi

# ---------------------------------------------------------------- static hosting bundle
step "hosting bundle"
if logged package bash tools/package.sh --force "$OUT/pkg" "$MT_DIR" "$ST_DIR" && logged package-test node tools/packagetest.mjs "$OUT/pkg"; then
  result PASS "hosting bundle" "threaded via coi-sw.js, single-threaded fallback, plain static server"
else result FAIL "hosting bundle" "see $OUT/package*.log"; fi

# ---------------------------------------------------------------- optional extras
if [ $WEBGPU = 1 ]; then
  for b in $NAMES; do
    step "$b: WebGPU vs WebGL2"
    if logged "shots-$b-webgpu" node tools/bench.mjs "$(url_of $b)?gfx=webgpu" --shots "$b-webgpu" \
       && grep -q '"backend":"webgpu"' "$OUT/shots-$b-webgpu.log"; then
      if [ -d "$OUT/shots/$b-a" ]; then
        python3 tools/shotdiff.py "$b-a" "$b-webgpu" --shots-dir "$OUT/shots" >"$OUT/shotdiff-$b-webgpu.log" 2>&1
        cat "$OUT/shotdiff-$b-webgpu.log"
        if r=$(frames_ok "$OUT/shotdiff-$b-webgpu.log"); then result PASS "$b WebGPU vs WebGL2" "$r frames ok"
        else result FAIL "$b WebGPU vs WebGL2" "$r (see $OUT/shotdiff-$b-webgpu.log)"; fi
      else
        result FAIL "$b WebGPU vs WebGL2" "no WebGL2 reference capture"
      fi
    else
      result SKIP "$b WebGPU vs WebGL2" "WebGPU not available in this browser"
    fi
  done
fi

if [ $ANDROID = 1 ]; then
  step "android timedemo"
  if [ -z "${ADB_SERIAL:-}" ]; then result SKIP "android timedemo" "ADB_SERIAL not set"
  elif ! command -v "${ADB:-adb}" >/dev/null 2>&1; then result SKIP "android timedemo" "adb not found"
  elif ! "${ADB:-adb}" -s "$ADB_SERIAL" get-state >/dev/null 2>&1; then result SKIP "android timedemo" "device $ADB_SERIAL not connected"
  elif logged timedemo-android node tools/bench.mjs "$(url_of mt)" 1 --android; then
    result PASS "android timedemo" "$(grep -E '^run 1:' "$OUT/timedemo-android.log" | cut -c1-120)"
  else
    result FAIL "android timedemo" "see $OUT/timedemo-android.log"
  fi
fi

summary
exit $((FAILED != 0))
