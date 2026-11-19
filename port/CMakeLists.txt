# Emscripten (wasm) build for Serious Sam Classic.
# Configure:  emcmake cmake -S port -B build-web-tfe -G Ninja -DGAME=SamTFE
# Source lists come from upstream via tools/extract_sources.py (port/<game>/sources.cmake).
# Entity code must be generated first: tools/gen_entities.sh <game>
cmake_minimum_required(VERSION 3.20)
project(SeriousSamWeb C CXX)

set(GAME "SamTFE" CACHE STRING "SamTFE or SamTSE")
set(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(SRC "${ROOT}/src/${GAME}/Sources")
include("${CMAKE_CURRENT_SOURCE_DIR}/${GAME}/sources.cmake")

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This build is for Emscripten only (use emcmake).")
endif()

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)

option(SE1_DEMO "Build for the official demo data (demo start level / logos)" OFF)
if(SE1_DEMO)
  add_compile_definitions(SE1_DEMO=1)
endif()
# Game data folder preloaded into the in-browser FS at "/" (temporary: later lazy/OPFS).
set(DATA_DIR "" CACHE PATH "Game data folder to preload (e.g. data/tfe-demo)")

if(GAME STREQUAL "SamTFE")
  set(MP "")
  add_compile_definitions(FIRST_ENCOUNTER=1)
else()
  set(MP "MP")
endif()

add_compile_definitions(
  PLATFORM_UNIX=1 PLATFORM_EMSCRIPTEN=1 PRAGMA_ONCE=1
  USE_PORTABLE_C=1 SINGLE_THREADED=1 STATICALLY_LINKED=1
  _REENTRANT=1 _MT=1 FASTBITS UNIX
  $<$<NOT:$<CONFIG:Debug>>:NDEBUG=1>
  $<$<NOT:$<CONFIG:Debug>>:_NDEBUG=1>
  $<$<CONFIG:Debug>:DEBUG=1>
  $<$<CONFIG:Debug>:_DEBUG=1>
)

# Emscripten ports pulled in at compile time so headers are found.
set(PORT_FLAGS "-sUSE_SDL=2" "-sUSE_ZLIB=1" "-sUSE_VORBIS=1" "-sUSE_OGG=1")
# The engine reports errors with C++ throw/catch: use native wasm exceptions.
set(EH_FLAGS -fwasm-exceptions -sSUPPORT_LONGJMP=wasm)

# Build flavours:
#   SE1_DEV=ON  (default): -sASSERTIONS, function names in stacks, no LTO -> fast iteration
#   SE1_DEV=OFF          : release, LTO, no runtime checks (what players get)
#   SE1_PROFILE=ON       : keep function names in a release build (for the JS Self-Profiling API)
option(SE1_DEV "Developer build (assertions, no LTO)" ON)
option(SE1_PROFILE "Keep function names (profiling)" OFF)
option(SE1_SIMD "Enable wasm SIMD (-msimd128)" ON)
# Engine in a worker (render plan phase 3, the default): pthreads + PROXY_TO_PTHREAD, frames handed
# to the page's main thread through shared memory. Needs a cross-origin isolated page: COOP/COEP
# headers (tools/devserver.py sends them), or coi-sw.js on static hosts (port/web/isolate.js).
# -DSE1_THREADS=OFF: the single-threaded JSPI build, which runs anywhere.
option(SE1_THREADS "Run the engine in a worker thread" ON)
set(OPT_FLAGS "")
if(SE1_SIMD)
  list(APPEND OPT_FLAGS -msimd128)
endif()
if(NOT SE1_DEV)
  list(APPEND OPT_FLAGS -O3 -flto)
endif()
if(SE1_THREADS)
  list(APPEND OPT_FLAGS -pthread)
  add_compile_definitions(SE1_THREADS=1)
  # rename the engine's SDL_GL_* calls to stubs: the worker has no GL context (sdlgl_threads.h)
  add_compile_options("SHELL:-include ${ROOT}/port/common/sdlgl_threads.h")
endif()
add_compile_options(
  ${PORT_FLAGS} ${EH_FLAGS} ${OPT_FLAGS}
  -fsigned-char -fms-extensions -fno-strict-aliasing
  -Wno-everything
)
include_directories("${SRC}" "${SRC}/External/libvorbis/include")

# --- static libraries (upstream builds these as .so and dlopens them) ---
list(TRANSFORM ENGINE_ES APPEND ".cpp" OUTPUT_VARIABLE ENGINE_ENT_CPP)
list(TRANSFORM GAME_ES APPEND ".cpp" OUTPUT_VARIABLE GAME_ENT_CPP)
set(PARSER_SRCS Engine/Base/Parser.cpp Engine/Base/Scanner.cpp Engine/Ska/smcPars.cpp Engine/Ska/smcScan.cpp)

macro(prefix_src OUT)
  set(${OUT} "")
  foreach(f ${ARGN})
    list(APPEND ${OUT} "${SRC}/${f}")
  endforeach()
endmacro()

prefix_src(S_SAFEMATH ${SAFEMATH_SRCS})
prefix_src(S_ENGINE ${ENGINE_ENT_CPP} ${ENGINE_SRCS} ${PARSER_SRCS} Engine/Base/NullSynchronization.cpp)
prefix_src(S_ENTITIES ${GAME_ENT_CPP} ${ENTITIES_EXTRA_SRCS})
prefix_src(S_GAME ${GAME_SRCS})
prefix_src(S_SHADERS ${SHADERS_SRCS})
prefix_src(S_SAM ${SAM_SRCS})

# dlopen() replacement: drop the Unix loader, use a static symbol registry.
list(FILTER S_ENGINE EXCLUDE REGEX "Engine/Base/Unix/UnixDynamicLoader\\.cpp$")
if(SE1_THREADS)
  list(APPEND S_ENGINE "${ROOT}/port/common/SdlGlThreads.cpp")
endif()
list(APPEND S_ENGINE "${ROOT}/port/common/WebDynamicLoader.cpp" "${ROOT}/port/common/gl1shim.c" "${ROOT}/port/common/ShellCall.cpp" "${ROOT}/port/common/WebAudio.cpp" "${ROOT}/port/common/WebFrame.cpp" "${ROOT}/port/common/CaseFs.c" "${ROOT}/port/common/FastSort.c" "${ROOT}/port/common/NetLan.c")
if(SE1_THREADS)
  list(APPEND S_ENGINE "${ROOT}/port/common/Persist.cpp")
endif()

add_library(engine_safemath STATIC ${S_SAFEMATH})
target_compile_options(engine_safemath PRIVATE -fno-unsafe-math-optimizations)
add_library(engine STATIC ${S_ENGINE})
add_library(entities STATIC ${S_ENTITIES})
target_sources(entities PRIVATE "${ROOT}/port/common/AimAssist.cpp")
add_library(game STATIC ${S_GAME})
add_library(shaders STATIC ${S_SHADERS})

# --- Rust mod layer (rust/se1-mod), built with cargo for wasm32-unknown-emscripten ---
option(SE1_RUSTMOD "Link the Rust mod layer" ON)
if(SE1_RUSTMOD)
  target_sources(engine PRIVATE "${ROOT}/port/common/Se1ModHost.cpp")
  target_sources(entities PRIVATE "${ROOT}/port/common/Se1ModEntities.cpp")
  find_program(CARGO cargo HINTS "$ENV{HOME}/.cargo/bin" REQUIRED)
  if(SE1_THREADS)
    # Rust's precompiled std for wasm32-unknown-emscripten has no atomics, so the threaded build
    # rebuilds std with them (nightly + rust-src: rustup toolchain install nightly --component rust-src)
    set(RUSTMOD_LIB "${ROOT}/rust/target-mt/wasm32-unknown-emscripten/release/libse1_mod.a")
    add_custom_target(rustmod
      COMMAND ${CMAKE_COMMAND} -E env "RUSTFLAGS=-C target-feature=+atomics,+bulk-memory,+mutable-globals"
              ${CARGO} +nightly build -Z build-std=std,panic_abort -p se1-mod
              --target wasm32-unknown-emscripten --release --target-dir target-mt
      WORKING_DIRECTORY "${ROOT}/rust"
      BYPRODUCTS "${RUSTMOD_LIB}"
      COMMENT "cargo +nightly build se1-mod (wasm32-unknown-emscripten, atomics, build-std)")
  else()
    set(RUSTMOD_LIB "${ROOT}/rust/target/wasm32-unknown-emscripten/release/libse1_mod.a")
    add_custom_target(rustmod
      COMMAND ${CARGO} build -p se1-mod --target wasm32-unknown-emscripten --release
      WORKING_DIRECTORY "${ROOT}/rust"
      BYPRODUCTS "${RUSTMOD_LIB}"
      COMMENT "cargo build se1-mod (wasm32-unknown-emscripten)")
  endif()
  target_compile_definitions(engine PRIVATE SE1_WITH_RUSTMOD=1)
  target_include_directories(engine PRIVATE "${ROOT}/port/common")
endif()

# --- the executable ---
add_executable(serioussam ${S_SAM} "${ROOT}/port/${GAME}/static_symbols.cpp")
target_link_libraries(serioussam
  "-Wl,--whole-archive" engine engine_safemath entities game shaders "-Wl,--no-whole-archive"
)
if(SE1_RUSTMOD)
  add_dependencies(serioussam rustmod)
  target_compile_definitions(serioussam PRIVATE SE1_WITH_RUSTMOD=1)
  target_link_libraries(serioussam "${RUSTMOD_LIB}")
endif()
target_link_options(serioussam PRIVATE
  ${PORT_FLAGS} ${EH_FLAGS} ${OPT_FLAGS}
  $<$<BOOL:${SE1_DEV}>:-sASSERTIONS=1>
  $<$<OR:$<BOOL:${SE1_DEV}>,$<BOOL:${SE1_PROFILE}>>:--profiling-funcs>
  "$<$<BOOL:${SE1_THREADS}>:SHELL:--pre-js ${ROOT}/port/web/isolate.js>"
  "SHELL:--pre-js ${ROOT}/port/web/pre.js" "SHELL:--pre-js ${ROOT}/port/web/audio.js" "SHELL:--pre-js ${ROOT}/port/web/gfx.js" "SHELL:--pre-js ${ROOT}/port/web/gfx-webgpu.js" "SHELL:--pre-js ${ROOT}/port/web/net.js" "SHELL:--pre-js ${ROOT}/port/web/lobby.js" "SHELL:--pre-js ${ROOT}/port/web/input.js" "SHELL:--pre-js ${ROOT}/port/web/touch.js" "SHELL:--pre-js ${ROOT}/port/web/gamepad.js" "SHELL:--pre-js ${ROOT}/port/web/survivors.js"
  "SHELL:--pre-js ${ROOT}/port/web/pre.js" "SHELL:--pre-js ${ROOT}/port/web/audio.js" "SHELL:--pre-js ${ROOT}/port/web/gfx.js" "SHELL:--pre-js ${ROOT}/port/web/gfx-webgpu.js" "SHELL:--pre-js ${ROOT}/port/web/net.js" "SHELL:--pre-js ${ROOT}/port/web/input.js" "SHELL:--pre-js ${ROOT}/port/web/survivors.js"
  "SHELL:--pre-js ${ROOT}/port/web/persist.js"
  "SHELL:--shell-file ${ROOT}/port/web/shell.html" "SHELL:--post-js ${ROOT}/port/web/bench.js"
  # (SHELL: keeps each flag with its argument; target_link_options would de-duplicate "--pre-js")
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sSTACK_SIZE=4MB
  -Wl,--wrap=fopen -Wl,--wrap=open -Wl,--wrap=opendir   # case-insensitive opens (port/common/CaseFs.c)
  -Wl,--wrap=qsort   # introsort instead of musl's smoothsort (port/common/FastSort.c)
  -Wl,--wrap=socket -Wl,--wrap=bind -Wl,--wrap=sendto -Wl,--wrap=recvfrom -Wl,--wrap=fcntl -Wl,--wrap=close -Wl,--wrap=gethostname -Wl,--wrap=gethostbyname   # virtual LAN (port/common/NetLan.c)
  -sFULL_ES3=1 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2
  $<IF:$<BOOL:${SE1_THREADS}>,-sPROXY_TO_PTHREAD,-sJSPI=1>
  $<$<BOOL:${SE1_THREADS}>:-sPTHREAD_POOL_SIZE=4>
  $<$<BOOL:${SE1_THREADS}>:-sWASMFS>   # filesystem in wasm: no per-read proxy to the main thread
  -sFORCE_FILESYSTEM=1
  $<$<NOT:$<BOOL:${SE1_THREADS}>>:-lidbfs.js>   # WASMFS (threaded build) persists via its OPFS backend instead
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8,HEAP16,HEAPU16,HEAPU32,HEAP32,HEAPF32,UTF8ToString,addRunDependency,removeRunDependency
)
if(DATA_DIR)
  target_link_options(serioussam PRIVATE "--preload-file" "${DATA_DIR}@/" "--exclude-file" "*.DS_Store")
endif()
set_target_properties(serioussam PROPERTIES SUFFIX ".html")
if(SE1_THREADS)
  # cross-origin isolation for hosts that can't send COOP/COEP (registered by port/web/isolate.js)
  add_custom_command(TARGET serioussam POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${ROOT}/port/web/coi-sw.js" "$<TARGET_FILE_DIR:serioussam>/coi-sw.js")
  set_property(TARGET serioussam APPEND PROPERTY LINK_DEPENDS "${ROOT}/port/web/isolate.js")
endif()
# --pre-js/--post-js files are link inputs: relink when they change
set_property(TARGET serioussam APPEND PROPERTY LINK_DEPENDS
  "${ROOT}/port/web/pre.js" "${ROOT}/port/web/audio.js" "${ROOT}/port/web/gfx.js" "${ROOT}/port/web/gfx-webgpu.js" "${ROOT}/port/web/net.js" "${ROOT}/port/web/lobby.js" "${ROOT}/port/web/input.js" "${ROOT}/port/web/touch.js" "${ROOT}/port/web/gamepad.js" "${ROOT}/port/web/survivors.js" "${ROOT}/port/web/persist.js" "${ROOT}/port/web/bench.js"
  "${ROOT}/port/web/shell.html")
