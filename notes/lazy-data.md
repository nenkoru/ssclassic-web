# Lazy game-data loading

> **Reviewer's note (Claude):** the byte counts below are the sizes of the files the game *opened*,
> not the bytes it *read*. Three quarters of them are `.gro` archives, which the engine opens whole
> and then seeks into, so the bytes actually needed at boot are probably far fewer than the 86 MB in
> the tables. The first implementation step is therefore to measure bytes read per file (wrap
> `read`/`fread`, as the opens were wrapped). That decides between whole-file fetching with an OPFS
> cache (simple, but ~86 MB on the first visit) and HTTP range requests into the archives. The
> "read-through cache" in the threaded-build recommendation reads files whole, so it only fits
> the first of the two.

## Today

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

## What the game reads

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

## Options

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

## Recommendation

### Threaded build (WASMFS)

1. **Mount a fetch backend at `/data`** in `wasmfs_before_preload` (or early in
   `main()`, like `Persist.cpp`). `base_url` = the page origin + `/data/`.
   `chunk_size` = 0 (default, ~256 KB).
2. **Mount an OPFS backend at `/cache`** (same pattern as `Persist.cpp:24-27`).
3. **Remove `--preload-file`** from CMakeLists. The data folder is served by the
   dev server (or production CDN) at `/data/`.
4. **Add a read-through cache layer** in `CaseFs.c`: before calling `__real_fopen`,
   check if `/cache/<path>` exists; if so, open that. If not, open `/data/<path>`,
   read it, write to `/cache/<path>`, then open the cached copy.
   (Alternatively, use WASMFS's `wasmfs_create_icase_backend` wrapper, `wasmfs.h:109`,
   to get case-insensitivity for free and drop `CaseFs.c`'s `resolve_case`.)
5. **First visit:** downloads only the files the engine actually reads (~86 MB for
   the demo, less with ranges). **Second visit:** zero downloads (OPFS).

Steps in order:
1. Serve `data/tfe-demo` at `/data/` from the dev server (no CMake change yet).
2. Add `wasmfs_before_preload` in a new `port/common/LazyFs.cpp` (threaded-only,
   `#ifdef SE1_THREADS`): mount fetch at `/data`, OPFS at `/cache`.
3. Modify `CaseFs.c` to redirect opens: try `/cache/<path>`, then `/data/<path>`,
   then the old path (for `/libsdl`). Write-through to `/cache`.
4. Remove `--preload-file` from CMakeLists. Verify with `tools/flowtest.mjs`.
5. Add a test: `tools/lazytest.mjs` that loads the page, measures bytes downloaded
   (via `PerformanceResourceTiming` or a dev-server counter), clicks to start a demo,
   reloads, and verifies the second load downloads ~0 bytes.

### Single-threaded build (MEMFS + JSPI)

1. **Replace `--preload-file` with `FS.createLazyFile`** calls in a new
   `port/web/lazyfs.js` (pre-js). For each file in the data folder manifest,
   create a lazy file at its path with `readAsync: (file, offset, length, cb) =>
   fetch(url + offset + '-' + (offset+length-1)).then(r => r.arrayBuffer())...`.
   The manifest is a small JSON file listing all data files (generated by a script
   from the data folder).
2. **JSPI handles the await:** the engine's `fread` suspends via JSPI while the
   fetch is in flight. The game shows its normal loading screen.
3. **Cache in IndexedDB:** after the first fetch, store the bytes in IDB. On
   subsequent visits, `readAsync` checks IDB first. (The st build already links
   `-lidbfs.js`; reuse the IDB connection.)
4. **First visit:** downloads files as they're read (same ~86 MB for the demo).
   **Second visit:** zero downloads (IDB).

Steps in order:
1. Generate a manifest JSON from `data/tfe-demo` (path, size, sha256).
2. Write `port/web/lazyfs.js`: in `Module.preRun`, read the manifest, call
   `FS.createLazyFile` for each entry with a `readAsync` that fetches from
   `/data/<path>` with a `Range` header, caching in IDB.
3. Remove `--preload-file` from CMakeLists (st build). Add `lazyfs.js` to the
   `--pre-js` list.
4. Verify with `tools/flowtest.mjs` on the st build.

### Testing

- **Existing tests that must keep passing:** `tools/flowtest.mjs` (boot → menu →
  demo → Escape), `tools/svtest.mjs` (survivors), `tools/inputtest.mjs`,
  `tools/qualitytest.mjs`, `tools/shimtest.mjs`.
- **New test: `tools/lazytest.mjs`.** Loads the page, records total bytes downloaded
  (sum of `transferSize` from `Performance.getEntriesByType('resource')`), clicks to
  start a demo, waits for it to run, then reloads the page (same user-data-dir, so
  OPFS/IDB persists) and records the second load's bytes. Checks: first load > 0
  bytes, second load < 1 MB (only the wasm + js, no data).
- **Byte-count check:** the dev server can log request sizes; the test can hit a
  `/__bytes` endpoint to get the total bytes served.

### Risks

- **Fetch backend worker thread:** consumes one of the 4 pthread pool slots
  (`-sPTHREAD_POOL_SIZE=4`). If the engine also uses 4 workers, the pool is
  exhausted. Mitigation: increase `PTHREAD_POOL_SIZE` to 6, or use the browser's
  HTTP cache instead of a separate OPFS cache.
- **OPFS quota:** browsers cap OPFS at a fraction of available disk space
  (Chrome: ~60% of free space). 112 MB is fine for the demo; the full game
  (1-2 GB) may hit the cap on small devices. Mitigation: evict LRU files, or
  use the browser's HTTP cache (no quota).
- **`.gro` range reads:** the engine seeks randomly within `.gro` files. With a
  range backend, each seek that crosses a chunk boundary triggers a new HTTP
  request. Chunk size matters: too small → many requests; too large → wasted
  bytes. The default (256 KB) is reasonable for the demo; profile with the full
  game.
- **Case-insensitivity + fetch:** the fetch backend is case-sensitive.
  `CaseFs.c`'s `resolve_case` works on the local FS; it must also work when the
  file is at `/data/<path>`. The `wasmfs_create_icase_backend` wrapper
  (`wasmfs.h:109`) handles this at the WASMFS level, which would be cleaner than
  the current `CaseFs.c` approach.
- **st build fetch latency:** `FS.createLazyFile` with `readAsync` fetches the
  whole file on first read. A 54 MB `.gro` is one 54 MB fetch. JSPI suspends the
  wasm stack during the fetch, so the game doesn't freeze, but the loading screen
  is up for the duration of the download. With a fast connection this is a few
  seconds; on slow connections it's longer. The threaded build's range backend
  is better here, but WASMFS is not available in the st build.
- **`file_packager --lz4` vs ranges:** LZ4-compressed packages are not seekable.
  If using `--preload-file` with `--lz4`, the whole package is downloaded and
  decompressed before any file is accessible. Ranges require uncompressed files
  on the server. For the threaded build, serve raw (uncompressed) files and use
  the fetch backend's range requests. For the st build, `FS.createLazyFile`
  fetches raw bytes, so no compression is needed (HTTP compression, `gzip`/
  `br`, is handled by the server transparently).
