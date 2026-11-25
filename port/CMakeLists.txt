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
option(SE1_LAZY_DATA "Fetch the big data files on demand, cached in OPFS (notes/lazy-data.md)" ON)
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
  # web port (threads): the movers' parallel collision prefetch (port/common/ClipPrefetch.cpp, ?mt=N)
  add_compile_definitions(SE1_CLIPPREFETCH=1)
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
list(APPEND S_ENGINE "${ROOT}/port/common/WebDynamicLoader.cpp" "${ROOT}/port/common/gl1shim.c" "${ROOT}/port/common/ShellCall.cpp" "${ROOT}/port/common/WebAudio.cpp" "${ROOT}/port/common/WebFrame.cpp" "${ROOT}/port/common/CaseFs.c" "${ROOT}/port/common/LazyData.c" "${ROOT}/port/common/FastSort.c" "${ROOT}/port/common/NetLan.c" "${ROOT}/port/common/SimHash.cpp" "${ROOT}/port/common/Se1Jobs.cpp")
if(SE1_THREADS)
  list(APPEND S_ENGINE "${ROOT}/port/common/Persist.cpp" "${ROOT}/port/common/ClipPrefetch.cpp")
endif()

add_library(engine_safemath STATIC ${S_SAFEMATH})
target_compile_options(engine_safemath PRIVATE -fno-unsafe-math-optimizations)
target_include_directories(engine_safemath PRIVATE "${ROOT}/port/common")   # ClipPrefetch.h
add_library(engine STATIC ${S_ENGINE})
target_include_directories(engine PRIVATE "${ROOT}/port/common")   # ClipPrefetch.h
add_library(entities STATIC ${S_ENTITIES})
target_sources(entities PRIVATE "${ROOT}/port/common/AimAssist.cpp")
add_library(game STATIC ${S_GAME})
add_library(shaders STATIC ${S_SHADERS})

# --- Rust mod layer (rust/se1-mod), built with cargo for wasm32-unknown-emscripten ---
option(SE1_RUSTMOD "Link the Rust mod layer" ON)
if(SE1_RUSTMOD)
  target_sources(engine PRIVATE "${ROOT}/port/common/Se1ModHost.cpp")
  target_sources(engine PRIVATE "${ROOT}/port/common/Se1ModBots.cpp")
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
  # Entity.cpp (the damage hook, API v5) is built in engine_safemath, not engine
  target_compile_definitions(engine_safemath PRIVATE SE1_WITH_RUSTMOD=1)
  # WeaponItem.es (the pickup hook, API v11) is in the entities library
  target_compile_definitions(entities PRIVATE SE1_WITH_RUSTMOD=1)
  target_include_directories(engine PRIVATE "${ROOT}/port/common")
endif()

# --- the executables ---
# se1_add_game(<target> <data dir> <user data> <out dir>): one page (<out dir>/serioussam.html)
# linked from the libraries above. With <user data> ON it carries no game data: the player imports their own
# (port/web/userdata.js, notes/user-data.md).
set(SE1_PRE_JS isolate pre audio gfx gfx-webgpu net lobby input touch gamepad gyro survivors persist
    lazydata playtest archipelago)
function(se1_add_game tgt data_dir user_data out)
  add_executable(${tgt} ${S_SAM} "${ROOT}/port/${GAME}/static_symbols.cpp")
  set_target_properties(${tgt} PROPERTIES SUFFIX ".html" OUTPUT_NAME serioussam RUNTIME_OUTPUT_DIRECTORY "${out}")
  target_link_libraries(${tgt}
    "-Wl,--whole-archive" engine engine_safemath entities game shaders "-Wl,--no-whole-archive"
  )
  if(SE1_RUSTMOD)
    add_dependencies(${tgt} rustmod)
    target_compile_definitions(${tgt} PRIVATE SE1_WITH_RUSTMOD=1)
    target_link_libraries(${tgt} "${RUSTMOD_LIB}")
  endif()
  set(prejs "")
  set(deps "")
  foreach(js ${SE1_PRE_JS})
    if(js STREQUAL "isolate" AND NOT SE1_THREADS)
      continue()
    endif()
    list(APPEND prejs "SHELL:--pre-js ${ROOT}/port/web/${js}.js")
    list(APPEND deps "${ROOT}/port/web/${js}.js")
  endforeach()
  if(user_data)
    # which game the page expects the player to bring (read by userdata.js)
    if(SE1_DEMO)
      set(demo true)
    else()
      set(demo false)
    endif()
    set(cfg "${CMAKE_CURRENT_BINARY_DIR}/${tgt}-config.js")
    file(WRITE "${cfg}" "Module['se1UserDataConfig'] = { game: 'tfe', demo: ${demo} };\n")
    list(APPEND prejs "SHELL:--pre-js ${cfg}" "SHELL:--pre-js ${ROOT}/port/web/userdata.js")
    list(APPEND deps "${cfg}" "${ROOT}/port/web/userdata.js")
  endif()
  target_link_options(${tgt} PRIVATE
    ${PORT_FLAGS} ${EH_FLAGS} ${OPT_FLAGS}
    $<$<BOOL:${SE1_DEV}>:-sASSERTIONS=1>
    $<$<OR:$<BOOL:${SE1_DEV}>,$<BOOL:${SE1_PROFILE}>>:--profiling-funcs>
    ${prejs}
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
    -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8,HEAP16,HEAPU16,HEAPU32,HEAP32,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,addRunDependency,removeRunDependency
  )
  if(user_data)
    # only what the repo ships (tools/basedata.py), split like any lazy build
    add_custom_command(TARGET ${tgt} PRE_LINK
      COMMAND python3 "${ROOT}/tools/basedata.py" --game "${GAME}" --out "${out}/data-base"
      COMMAND python3 "${ROOT}/tools/lazydata.py" --data "${out}/data-base" --out "${out}" VERBATIM)
    target_link_options(${tgt} PRIVATE "--preload-file" "${out}/data-boot@/" "--exclude-file" "*.DS_Store")
  elseif(data_dir AND SE1_LAZY_DATA)
    # big files on demand (notes/lazy-data.md): tools/lazydata.py splits the data dir on every link
    # into data-boot/ (the preload bundle: small files, empty placeholders, SE1Lazy/manifest.txt) and
    # gamedata/ (the big files, fetched with HTTP Range by port/web/lazydata.js)
    add_custom_command(TARGET ${tgt} PRE_LINK
      COMMAND python3 "${ROOT}/tools/lazydata.py" --data "${data_dir}" --out "${out}" VERBATIM)
    target_link_options(${tgt} PRIVATE "--preload-file" "${out}/data-boot@/" "--exclude-file" "*.DS_Store")
  elseif(data_dir)
    target_link_options(${tgt} PRIVATE "--preload-file" "${data_dir}@/" "--exclude-file" "*.DS_Store")
  endif()
  if(SE1_THREADS)
    # cross-origin isolation for hosts that can't send COOP/COEP (registered by port/web/isolate.js)
    add_custom_command(TARGET ${tgt} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${ROOT}/port/web/coi-sw.js" "${out}/coi-sw.js")
  endif()
  # --pre-js/--post-js files are link inputs: relink when they change
  set_property(TARGET ${tgt} APPEND PROPERTY LINK_DEPENDS ${deps}
    "${ROOT}/port/web/bench.js" "${ROOT}/port/web/shell.html" "${ROOT}/tools/lazydata.py")
endfunction()

se1_add_game(serioussam "${DATA_DIR}" OFF "${CMAKE_CURRENT_BINARY_DIR}")
# The user-data page, in <build>/byod/: what a public host serves (no game data of its own).
# Not part of "all": build it with `ninja -C <build> serioussam_byod`.
option(SE1_USER_DATA "Add the serioussam_byod target (no game data; the player imports theirs)" ON)
if(SE1_USER_DATA)
  se1_add_game(serioussam_byod "" ON "${CMAKE_CURRENT_BINARY_DIR}/byod")
  set_target_properties(serioussam_byod PROPERTIES EXCLUDE_FROM_ALL ON)
endif()
