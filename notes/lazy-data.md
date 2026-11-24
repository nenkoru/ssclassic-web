# Lazy game-data loading

Goal: the menu shows fast, level data is fetched when the engine reads it, and fetched data is
kept in OPFS so the next visit downloads nothing. Both builds (threaded WASMFS, single-threaded
MEMFS + JSPI) must keep working, and `tools/test.sh` stays green.

## The problem (2026-11-24)

`port/CMakeLists.txt` packs the whole data folder into one `serioussam.data` with
`--preload-file`. For the full build that is 386 MB (`data/tfe-full-web`, 497 files), and the
Emscripten runtime downloads all of it and copies it into the in-memory filesystem before
`main()` runs. The file also stays in the wasm heap (WASMFS) or the JS heap (MEMFS) for the whole
session.

Most of those bytes are in a few large files. 38 files are 256 KB or more, and together they hold
361 MB:

| File | Size | Read how |
|---|---:|---|
| `1_00c.gro` | 201 MB | every model, texture and sound; a zip opened at boot, entries read by seek + read |
| `1_00_music.gro` | 72 MB | music, streamed while it plays |
| `Help/*.chm` | 19 MB | never |
| `Levels/*.wld` (20) | 70 MB | one level at a time; the menu's level list reads only their headers |
| `Demos/*.dem` | ~10 MB | when a demo plays |

Whole-file laziness cannot work for the two archives. The engine opens every `.gro` at boot
(`Stream.cpp`, `UNZIPAddArchive` reads the central directory at the end of the file), so fetching
a whole archive when it is opened would fetch 273 MB before the menu. The lazy unit has to be a
**byte range** of a file.

## Design

### Overview

```
engine fopen("1_00c.gro","rb") ──► __wrap_fopen (CaseFs.c)
                                     │ path in the lazy manifest?
                                     ├─ no  ─► __real_fopen (as today)
                                     └─ yes ─► fopencookie(LazyFile) ── read/seek/close
                                                   │ chunk in the heap cache? copy it
                                                   └─ no ─► se1_lazy_fetch(file, chunks)
                                                             mt: proxy to the page + futex wait
                                                             st: EM_ASYNC_JS (JSPI suspends)
page (main thread)  Module.se1Lazy.fetch(...)
   OPFS se1-lazy/<dataset>/<file>.<chunk> ─ hit ─► copy into the heap
   └─ miss ─► fetch(gamedata/<path>, Range) ─► copy into the heap, then write to OPFS
```

### 1. Build: split the data folder (`tools/lazydata.py`)

At link time a script splits `DATA_DIR` into:

- **`<build>/data-boot/`**, the new `--preload-file` source. It has hard links to every small file
  and an **empty placeholder** for each lazy file. The placeholders are there so directory
  listings (`FindFiles("*.gro")`, the level list), `stat` and the case-insensitive lookup still
  see the file. The engine only uses `stat`/`fstat` for existence, mode and mtime, never for the
  size (`Stream.cpp` GetFileTimeStamp_t / IsFileReadOnly, `UnixFileSystem.cpp`). It gets sizes
  through `fseek`/`ftell`, which the lazy FILE answers.
- **`<build>/gamedata/<path>`**: hard links to the lazy files (no extra disk), served next to the
  page and fetched with HTTP `Range`.
- **`data-boot/SE1Lazy/manifest.txt`**, packed into the boot bundle: one line per lazy file:
  `<key> <size> <path>`. `key` is a hex hash of path, size and mtime, so a changed file gets new
  cache entries. The first line is `dataset <hash of all lines>`.

Which files are lazy: every file of 256 KB or more, except under `Nav/` and `SE1Mod/` (the Rust
mod reads those; they are small anyway). For the full data that is 361 MB lazy and about 9 MB in
the boot bundle. The demo data does the same, so `tools/test.sh` exercises the lazy path in both
builds.

It is a CMake option, `SE1_LAZY_DATA` (default ON). OFF keeps today's single bundle. The script
runs on every link (PRE_LINK custom command). It looks only at sizes and mtimes, so it is quick
and picks up data changes on a relink, as the preload does today.

### 2. Engine side: `port/common/LazyData.c` (both builds)

- `__wrap_fopen` (`CaseFs.c`) asks `se1_lazy_open(resolved_path, mode)` first. For a manifest
  path opened read-only it returns a `fopencookie` FILE; anything else falls through to
  `__real_fopen` as today. Write modes on a lazy path keep the old behaviour (it never happens:
  the engine writes only under the user directory).
- `fopencookie` is in Emscripten's musl. The engine reads data files only through
  `fopen`/`fread`/`fseek`/`ftell` (`Stream.cpp` CTFileStream, `Unzip.cpp`). `_open` is used only
  for `fstat` (time stamps), which the placeholder answers. No engine (`src/`) change is needed.
- **Chunks:** 256 KiB (chosen by measurement, see below). A read finds the chunks it covers and
  fetches every missing one in one request (one `Range`, at most 16 chunks). If the read continues where the last read on that FILE ended
  (sequential), the request also takes up to 3 following chunks (read-ahead for `.wld` and
  music).
- **Script functions, single-threaded build:** a console or script function (`PlayDemo`, for
  example) is called through a JS frame (`port/common/ShellCall.cpp`), and JSPI can't suspend
  through JS frames (`SuspendError`). `ShellCall.cpp` counts its depth in `_iSE1ShellDepth`; while it
  is above 0, `LazyData.c` reads with `Module.se1Lazy.fetchSync`, a synchronous XHR Range request
  (no OPFS read, since OPFS is async on the page; the chunks are still written to OPFS). The
  threaded build doesn't need this: its engine thread blocks on a futex.
- **Heap cache:** chunks live in a shared LRU in the wasm heap, 64 MiB at most (256 slots). An evicted chunk
  comes back from OPFS on its next read. Today the full build keeps all 386 MB in the heap, so
  this is also a memory cut, which matters on phones.
- **Fetch call, threaded build:** the engine runs in a pthread. It allocates the destination
  buffer, posts `Module.se1Lazy.fetch(...)` to the page with `MAIN_THREAD_ASYNC_EM_ASM` and
  waits on a futex word that the page sets when the bytes are in. This is the same pattern as
  the frame hand-off in `gl1shim.c`. A read on the browser main thread can't block, so it
  fails with EIO and a console line (nothing in the engine reads data there).
- **Fetch call, single-threaded build:** `EM_ASYNC_JS` awaits the same JS function, and JSPI
  suspends the wasm stack. The whole game runs under `main()` (`WebFrame.cpp` already awaits rAF
  the same way), so every engine read can suspend. Page calls into wasm (`se1Cmd` and others)
  only queue work for the frame loop.
- **Thread safety:** a mutex around the manifest and the heap cache. In the threaded build, the
  engine thread and the sound mixer can both read.
- **Stats:** `SE1_LazyStats()` returns the counters as JSON: bytes and requests from the network
  and from OPFS, cache hits, and time spent waiting. It is exposed as `Module.se1LazyStats()` for
  `tools/menutime.mjs` and the tests.

### 3. Page side: `port/web/lazydata.js` (pre-js, both builds)

`Module.se1Lazy.fetch(dataset, key, path, firstChunk, count, chunkSize, fileSize, dst)` returns
a Promise and fills the heap at `dst`. For each chunk:

1. OPFS: `navigator.storage.getDirectory()` → `se1-lazy/<dataset>/<key>.<chunk>`. On a hit,
   read the bytes from it.
2. Missing chunks are fetched together: `fetch(gamedata/<path>, {headers: {Range}})`. A server
   that answers `200` with the whole file still works: the page slices the bytes it needs and
   caches every chunk of that response. Failed fetches are retried 3 times with backoff, then the
   read fails (the engine shows its usual "cannot read" error).
3. The page copies the bytes into `HEAPU8` (the shared buffer in the threaded build), sets the
   done word (`Atomics.store` + `Atomics.notify` in the threaded build; the Promise resolves in
   the single-threaded one), and only then writes the new chunks to OPFS (`createWritable`, fire
   and forget). Writing to the cache never delays the game.
4. Housekeeping at start-up: `navigator.storage.persist()` (best effort). Keep the current
   dataset and the most recently used other one (the mt and st builds of one bundle share a
   dataset), and delete older `se1-lazy/*` folders.
5. `?lazycache=0` skips OPFS (always network), for tests and comparisons. `Module.se1LazyClear()`
   empties the cache.

OPFS is per origin, so the threaded and single-threaded builds of one hosting bundle share
cached chunks.

### 4. Servers and the hosting bundle

- `tools/devserver.py`: answer `Range: bytes=a-b` with `206 Partial Content` (single ranges are
  enough). Python's `SimpleHTTPRequestHandler` ignores Range and sends 200, which the page also
  handles, at the cost of the whole file.
- `tools/package.sh`: copy `gamedata/` next to each build, dereferencing the hard links. When both
  builds' manifests have the same dataset, keep one copy and point the st build at it.
  `packagetest.mjs` uses `python -m http.server` (no Range), so it also covers the
  200 fallback.

### 5. What is not lazy, and what comes later

- Not lazy: the wasm, the JS and the boot bundle (about 9 MB for the full data).
- Later: per-level prefetch lists. Record which chunks a level load reads, then fetch them in
  parallel when the level starts, instead of one blocking request after another. Worth it on
  high-latency links; measure first.
- Done: on `QuotaExceededError` the page stops writing to OPFS and reads keep coming from the
  network.
- Later: a boot prefetch list. Before the menu the engine reads about 150 chunks one after
  another (mostly `1_00c.gro` entries), so on a 40 ms link most of the cold time is waiting, not
  downloading. Fetching the known boot chunks in parallel at page load should take the cold
  menu from about 14 s towards the 6 s that the bytes alone need.

### Measuring

`tools/menutime.mjs <url> [--runs N] [--throttle MBIT]`: a cold load (fresh profile) and a warm
reload in the same profile. It records the time to the first engine frame and to 60 frames, the
bytes downloaded, and `Module.se1LazyStats()`. The dev server sends `Cache-Control: no-store`, so
"warm" before this change re-downloads the 386 MB bundle. On a static host the HTTP cache would
keep it, but it could also evict it.

Results: see "Measurements" below.

### Measurements

Full data, threaded build, `tools/menutime.mjs`, headless Chrome on the M-series Mac. "Before" is
the same commit built with `-DSE1_LAZY_DATA=OFF` (386 MB preload bundle). Times are to the first
engine frame / to 60 frames (the menu is up and animating); MB is everything the page downloaded.

| Build | Link | Cold first frame | Cold 60 frames | Cold MB | Warm 60 frames | Warm MB |
|---|---|---|---|---|---|---|
| before | localhost | 1.03 s | 2.35 s | 393.1 | 2.02 s | 393.1 |
| lazy, 1 MiB chunks | localhost | 0.52 s | 2.05 s | 120.6 | 1.74 s | 14.9 |
| lazy, 256 KiB | localhost | | 2.26 s | 74.5 | | |
| lazy, 64 KiB | localhost | | 2.52 s | 57.0 | | |
| before | 100 Mbit, 40 ms | 32.44 s | 33.87 s | 393.1 | 34.05 s | 393.1 |
| lazy, 1 MiB | 100 Mbit, 40 ms | 7.97 s | 15.51 s | 120.6 | 3.19 s | 14.9 |
| **lazy, 256 KiB** | 100 Mbit, 40 ms | **5.84 s** | **14.32 s** | **73.0** | **3.39 s** | **14.9** |

- Warm loads read every chunk from OPFS (0 network requests for game data); the 14.9 MB left is
  the wasm, JS and the 8.2 MB boot bundle, which the dev server sends with `no-store`.
- Chunk size: smaller chunks download less (the boot reads scattered `.gro` entries) but need
  more serial requests: 1 MiB = 83 requests / 106 MB of game data, 256 KiB = 147 / 58 MB,
  64 KiB = 306 / 42 MB. 256 KiB is the best of the three on the throttled link and close to
  the best on localhost.
- What the boot reads (256 KiB): `1_00c.gro` 183 chunks, `Intro.wld` 16, music 3,
  `SE1_10b.gro` 2, `1_00_ExtraTools.gro` 1, and the first chunk of every `.wld` (the level list
  reads the headers).

### Rejected options

- **WASMFS fetch backend** (`wasmfs_create_fetch_backend`): it does Range reads but caches
  nothing, it needs its own pthread, and the single-threaded MEMFS build doesn't have it.
- **`FS.createLazyFile`**: it fetches whole files with synchronous XHR, which browsers allow only
  in workers, and the single-threaded build runs on the main thread.
- **Splitting the preload into several `file_packager` bundles**: the bundles are whole files,
  and the boot still needs the `.gro` archives because the engine opens them all at start-up.
- **Repacking `1_00c.gro` per level**: an engine-format change, and the boot still opens every
  archive.

## Background: earlier research (demo data)

The sections below are from the first look at the demo data (`notes/lazy-data-files.txt`). Two of
their conclusions don't hold: the single-threaded `FS.createLazyFile` plan (synchronous XHR is
worker-only), and whole-archive caching (the boot opens every archive).

### Today

The demo data folder (`data/tfe-demo`, 112.4 MB, 117,877,087 bytes) is packed into a
single `serioussam.data` file by `file_packager` at link time:

- `port/CMakeLists.txt:183` — `--preload-file ${DATA_DIR}@/ --exclude-file *.DS_Store`
  (guarded by `if(DATA_DIR)`, line 182).
- The packed file lands in `build-mt/serioussam.data` (115,116 KB on disk after
  Emscripten's own compression).
- At startup the Emscripten runtime downloads and decompresses the whole `.data` file
  before `main()` runs (`addRunDependency` / `removeRunDependency`, line 180).

**Threaded build (WASMFS):** `-sWASMFS` (line 177) puts the filesystem inside the wasm
heap; the engine worker owns it. Preloaded files are placed at `/` by the runtime before
`main()`. The OPFS backend is used only for `/libsdl` (user directory):
`port/common/Persist.cpp:24` calls `wasmfs_create_opfs_backend()` and mounts it at
`/libsdl` via `wasmfs_create_directory("/libsdl", 0777, opfs)` (line 25), called from
`SeriousSam.cpp:1859`.

**Single-threaded build (MEMFS):** `-sJSPI=1` (line 175, the `SE1_THREADS=OFF` branch).
No WASMFS; the filesystem is MEMFS in the JS heap. Preloaded files are placed at `/` the
same way. Persistence uses IDBFS: `-lidbfs.js` (line 179) and `port/web/persist.js`
mounts it at `/libsdl` in `Module.preRun` with `FS.syncfs`.

**Case-insensitive lookup:** The engine was written for Windows and opens paths with
mixed case. Two mechanisms handle this:

- MEMFS (st build): `port/web/pre.js:39-56` wraps `FS.lookupNode` in `Module.preRun`;
  on `ENOENT` it does a case-insensitive scan of the parent directory's `contents`.
- WASMFS (mt build): `port/common/CaseFs.c` wraps `fopen`/`open`/`opendir` via
  `-Wl,--wrap=` (CMakeLists line 171). `__wrap_fopen` (line 79) tries the exact path;
  on `ENOENT` it calls `resolve_case` (line 40) which walks the path component by
  component, `stat`-ing each and falling back to a `strncasecmp` scan of the directory
  via `__real_opendir` + `readdir`. The same pattern is in `__wrap_open` (line 88)
  and `__wrap_opendir` (line 101).

**.gro archives:** The engine's own zip reader (`src/SamTFE/Sources/Engine/Base/Unzip.cpp`)
handles `.gro` files. At startup, `Stream.cpp:212-219` (`_pFileSystem->FindFiles(
_fnmApplicationPath, "*.gro")` + `UNZIPAddArchive`) registers every `.gro` in the base
directory (and mod/CD directories). When the engine opens a file that lives inside a
`.gro`, `UNZIPOpen_t` (`Unzip.cpp:587`) does `fopen(*pze->ze_pfnmArchive, "rb")`
(line 630) on the **whole `.gro` file**, `fseek`s to the entry's local header
(line 640), and reads the entry bytes. The `.gro` file itself is a standard ZIP; the
engine reads it through normal `fopen`/`fread`/`fseek`, so any filesystem backend
(MEMFS, WASMFS, fetch, OPFS) works transparently. `FileExists` (`Stream.cpp:1370-1382`)
calls `ExpandFilePath(EFP_READ, ...)` which checks the zip index without opening the
archive — no bytes are read from the `.gro` for an existence check.

The six `.gro` files in the demo folder total 74.8 MB (78,388,666 bytes). The largest
is `1_00c_demo.gro` (54.3 MB, 1157 entries, 93.4 MB uncompressed) which holds all the
3D models, textures, and sounds for the demo levels.

### What the game reads

Measured with an instrumented threaded build: `__wrap_fopen` and `__wrap_open` in
`port/common/CaseFs.c` log every successful read-open (path + file size) into a
20,000-entry ring buffer; the test drains it via `Module._SE1_LogOpenCount()` /
`Module._SE1_LogOpenAt()` after each phase. Raw output: `notes/lazy-data-files.txt`
(one `phase path bytes` per line, 59,870 lines).

Data folder total: **117,877,087 bytes** (112.4 MB), 117 files + directories.

### Phase A: boot to main menu

32 unique paths, 86,425,004 bytes of unique file content (19,870 open calls, many
repeated).

| Path | Bytes |
|------|------:|
| `/1_00c_demo.gro` | 54,316,265 |
| `/1_00_music_demo.gro` | 12,197,942 |
| `/Levels/KarnakDemo.wld` | 8,339,038 |
| `/Levels/Intro.wld` | 4,122,270 |
| `/SE1_10b.gro` | 2,783,834 |
| `/Levels/TechTest.wld` | 2,627,091 |
| `/1_00_ExtraTools.gro` | 1,199,329 |
| `/Levels/Deathmatch/DesertTemple.wld` | 747,359 |
| `/1_04_patch.gro` | 23,553 |
| `/1_00_scripts.gro` | 10,522 |
| `/Controls/00-Default.ctl` | 4,945 |
| `/Controls/System/Common.ctl` | 3,437 |
| `/Scripts/GLSettings/GLSettings.lst` | 3,590 |
| `/Scripts/GLSettings/Initial.ini` | 2,743 |
| `/Scripts/GLSettings/Default.ini` | 1,299 |
| `/SE1Mod/config.toml` | 635 |
| `/Data/NoCRC.lst` | 70 |
| `/Scripts/Game_startup.ini` | 106 |
| `/Data/Var/DefaultPlayer.var` | 11 |
| `/Data/Var/Sam_Version.var` | 5 |
| `/ModEXT.txt` | 0 |
| (directories, 4096 each) | — |

The menu phase opens all six `.gro` archives (the engine registers them at startup,
`Stream.cpp:212-219`), all four level `.wld` files (the menu previews them), the music
archive, and a handful of config files. **Total: 86.4 MB of the 112.4 MB folder.**

### Phase B: first demo level (click from menu)

33 unique paths, 89,588,872 bytes. Identical to Phase A plus:

| Path | Bytes |
|------|------:|
| `/Demos/Auto-Demo0001.dem` | 3,163,868 |

The demo file is the only new asset. The `.gro` archives are already open from boot.

### Phase C: `?mode=survivors&svauto=1&svgod=1`

46 unique paths, 86,458,779 bytes. Same set as Phase A (survivors plays on
`KarnakDemo.wld`, which was already loaded for the menu). No demo file. Adds 16
user-directory files under `/libsdl/` (8 × `Controls*.ctl` at 4,773 bytes each,
8 × `Player*.plr` at ~68 bytes each) — these are OPFS/IDBFS, not part of the data
folder.

### Summary

| Phase | Unique files | Unique bytes | % of 112.4 MB |
|-------|-------------|-------------|---------------|
| boot → menu | 32 | 86.4 MB | 76.7% |
| + first demo | 33 | 89.6 MB | 79.4% |
| + survivors | 46 | 86.5 MB | 76.9% |

The `.gro` archives dominate: 74.8 MB of the 86.4 MB boot total is inside `.gro`
files. The engine opens the whole `.gro` file and reads individual entries by
seeking, so a range-request backend can serve only the bytes actually read.

**What is NOT read during these phases** (26 MB of the folder):
- 5 more demo files (`Auto-Demo0002.dem` … `Auto-Demo0005.dem`, `Auto-DemoMP0001/2.dem`): ~18 MB
- 2 `.ifr` infopanel files (`Data/Default.ifr`, `Data/Logitech.ifr`): ~180 KB
- `Locales/` (HTML help pages, 2 locales): ~130 KB
- `Mods/` textures: ~1.1 MB
- Level thumbnail `.tex` files: ~200 KB
- `Help/`, `Players/`, `SaveGame/`, `Temp/` directories: small

### Options considered then

### 1. WASMFS fetch backend + OPFS cache (threaded build)

**How it works.** WASMFS (already linked, `-sWASMFS`) supports a fetch backend:
`wasmfs_create_fetch_backend(base_url, chunk_size)` (`wasmfs.h:78`). Mounted at `/`,
every file read is backed by an HTTP `Range` request to `base_url + relative_path`.
Files smaller than `chunk_size` are fetched whole; larger files are read in
`chunk_size`-aligned ranges. The test `test/wasmfs/wasmfs_fetch.c` exercises relative
and absolute URLs, directory listings, small reads, chunk alignment, and 404 handling.

For caching, a second mount: `wasmfs_create_opfs_backend()` (`wasmfs.h:104`) at a
cache path (e.g. `/cache`). The fetch backend does **not** cache automatically — it
re-issues HTTP requests every run. The pattern:

1. On file open, check `/cache/<path>` first (OPFS, instant if present).
2. If absent, read from the fetch backend (HTTP), then write the bytes to `/cache/<path>`.
3. Subsequent visits: everything hits OPFS, zero downloads.

An alternative is to mount the fetch backend directly at `/` and let the browser's
HTTP cache handle re-fetches (with `Cache-Control` headers from the server). This
simpler approach avoids the OPFS write path but depends on the browser's cache policy
and loses data on "clear browsing data."

**Cost.** The fetch backend spawns a dedicated worker thread (`wasmfs.h:68-69`:
"cannot be called on the browser main thread because it might deadlock while waiting
for its dedicated worker thread to be spawned"). With `-sPTHREAD_POOL_SIZE=4`
(CMakeLists line 176), one pool thread is consumed by the fetch backend. The OPFS
backend also uses a dedicated worker (`wasmfs.h:82-83`). Total: 2 extra workers +
engine workers.

The `wasmfs_before_preload` hook (`wasmfs.h:132`) runs before preloaded files are
placed, so backends can be mounted there. `Persist.cpp:22-28` already shows the
pattern (call `wasmfs_create_opfs_backend` from `main()`).

**Cost.** First visit: same bytes as today (the engine reads the same files).
Second visit: zero bytes (OPFS). Memory: fetched chunks are buffered in wasm heap.
Latency: first read of each file has an HTTP round-trip; subsequent reads of the same
file hit the wasm-heap buffer.

**Both builds?** No. WASMFS is threaded-only (`-sWASMFS` is in the `SE1_THREADS`
branch, CMakeLists line 177). The st build uses MEMFS.

### 2. Splitting the `.data` package

**How it works.** Instead of one `--preload-file data/tfe-demo@/`, build multiple
packages:

```
file_packager pkg-core.data --preload Levels/Intro.wld Levels/KarnakDemo.wld ... --js-output=core.js --lz4
file_packager pkg-levels.data --preload Levels/ --js-output=levels.js --lz4
file_packager pkg-gro.data --preload *.gro --js-output=gro.js --lz4
```

Each package is a separate `.data` file + a generated `.js` that calls
`FS.createPreloadedFile` for its files. Load `pkg-core` at startup; load the others
on demand (e.g. when the user picks a level). `--lz4` compresses the package
(LZ4, ~30-50% smaller than raw for game data).

The engine's `ExpandFilePath` / `UNZIPGetFileIndex` lookups work by path, so files
can live in any package as long as they end up at the right path in the MEMFS/WASMFS
tree. No engine changes needed.

**Cost.** Multiple `.data` downloads; the player must wait for `pkg-core` before the
menu appears. Level packages are fetched when a level is selected (a few seconds of
loading). `--lz4` reduces transfer size but adds decompression CPU. The `file_packager`
`--use-preload-cache` flag (`file_packager.py` help) enables an IndexedDB cache so
the second visit skips the download.

**Both builds?** Yes. `--preload-file` / `FS.createPreloadedFile` work in both MEMFS
and WASMFS. The st build already has `-lidbfs.js` for IDBFS; `--use-preload-cache`
uses IndexedDB directly.

### 3. Single-threaded build: `FS.createLazyFile` / JSPI

**`FS.createLazyFile`.** MEMFS supports lazy files: `FS.createLazyFile(parent, name,
url, {read, readAsync})` creates a file whose bytes are fetched on first read. The
`readAsync` variant uses `fetch()` and is non-blocking. This works in the st build
because MEMFS runs in the main thread's JS heap and `fetch` is available.

When is sync XHR allowed? `FS.createLazyFile` with a `read` (sync) callback uses
`XMLHttpRequest` in sync mode. Sync XHR is deprecated in browsers but still works;
it blocks the main thread. In a JSPI build, the engine can `await` a fetch via
`readAsync`, so the sync path is not needed. The st build is a JSPI build
(`-sJSPI=1`, CMakeLists line 175), so `readAsync` + `await` is the right path.

**JSPI.** The st build uses `-sJSPI=1` (CMakeLists line 175). JSPI (JavaScript
Promise Integration) lets wasm code `await` a JS promise, suspending the wasm stack
while the fetch is in flight. This is the mechanism that makes `readAsync` work: the
engine's `fread` call suspends, the fetch completes, and the wasm stack resumes with
the data. No worker threads, no shared memory.

**Cost.** Per-file fetch latency on first read (no bulk download). The engine's read
pattern (open → seek → read) means many small fetches for `.gro` entries; a fetch
backend with range requests (option 1) would be more efficient, but WASMFS is not
available in the st build. `FS.createLazyFile` fetches the whole file on first read,
so a 54 MB `.gro` is one big download. JSPI makes this non-blocking (the game can
show a loading screen while the fetch is in flight).

**Both builds?** `FS.createLazyFile` is MEMFS-only. JSPI is st-build-only
(`-sJSPI=1` is in the `SE1_THREADS=OFF` branch). The threaded build uses WASMFS
(option 1) instead.

### 4. `.gro` handling: whole archives vs ranges

The engine opens `.gro` files with `fopen` + `fseek` + `fread` (`Unzip.cpp:630-640`).
It does not read the whole archive; it seeks to each entry's offset and reads that
entry's bytes. With a range-request backend (WASMFS fetch, option 1), only the
bytes of the entries actually read are downloaded.

Measured: during boot→menu, the engine opens `1_00c_demo.gro` (54.3 MB) and reads
model/texture/sound entries for the four demo levels. The exact bytes read depend on
which entities are in the loaded levels; a rough estimate is 20-40 MB of the 54.3 MB
archive for the menu + first level (estimate, not measured — would require
instrumenting `fread` offsets).

**Whole archive:** download the full 54.3 MB once, cache in OPFS. Simple, works with
any backend. Cost: 54.3 MB first visit even if only 20 MB is read.

**Ranges:** download only the entries that are read. Saves ~50% on the big archive.
Requires a range-request-capable backend (WASMFS fetch, or a custom
`FS.createLazyFile` with range reads). The `file_packager` `--lz4` option does not
help with ranges (LZ4 is a stream format, not seekable).

**Recommendation for `.gro`:** whole-archive fetch + OPFS cache. The range savings
(20-30 MB) are worth the complexity only if the first-visit load time is a hard
requirement. For the demo, 54 MB is acceptable; for the full game (est. 1-2 GB),
ranges become important.

