# User data: the player brings the game files

The public site can't serve game data. The retail EULA forbids "making a copy available on a
network", and the 2001 demo comes with no redistribution grant. So the public build carries the
engine and the GPL files from the upstream repo only, and the player picks the folder their own copy
is installed in (Steam, GOG, a CD install, or the unpacked demo). That happens once. The files stay
in the browser's private storage (OPFS), and later visits start straight away.

## Builds

Every build directory also has a target `serioussam_byod` (`EXCLUDE_FROM_ALL`, CMake option
`SE1_USER_DATA`, on by default). It is built into `<build>/byod/`:

```
ninja -C build-pub-mt serioussam_byod   # threaded, SE1_DEMO=OFF, no DATA_DIR
ninja -C build-pub-st serioussam_byod   # single-threaded
tools/package.sh <out> build-pub-mt/byod build-pub-st/byod
```

Before the link:

1. `tools/basedata.py` stages `<build>/byod/data-base`: `src/SamTFE`'s Controls, Data, Demos, Help,
   Mods, Players, Scripts, VirtualTrees, SE1_10b.gro and ModEXT.txt, the empty Levels, SaveGame,
   Temp and Bin, and `port/data` on top. That is 163 files, 11 MB.
2. `tools/lazydata.py` splits the staged folder as for any lazy build. `serioussam.data` comes to
   0.6 MB, and `gamedata/` holds 6 files and 10.5 MB.

The bundle is 34 MB in all, and none of it is Croteam's or Devolver's data.

`SE1_DEMO` is a compile-time switch in the game code (first level, logos), so a build takes either
the full game or the demo, not both. The demo-only test builds (`build-test-*`) make demo pages, and
the public build makes a full-game page.

## The page (port/web/userdata.js)

**Import.** The screen takes a folder from the picker (`<input webkitdirectory>`) or a drag and
drop.

- The game folder is the one that holds the main archive: `1_00c.gro` for the full game,
  `1_00c_demo.gro` for the demo.
- The wrong game is refused with a message: a TSE folder, the demo in a full build, the full game in
  a demo build, or a folder with no archives.
- What gets copied:
  - full game: the top-level `*.gro`, `Levels/` and `Help/` (as `tools/make_full_data.sh` does);
  - demo: everything except the installer and Windows files (as `tools/make_demo_data.sh` does);
  - `Scripts/GLSettings` is never copied: the repo's settings stay.
- Before copying, the page clears the old copy, checks the quota and asks for persistent storage.
  Files are written to `se1-user/tfe/files/...`, and `index.json` is written last as the commit
  marker.
- An import takes about 1 s for the 375 MB of the full game on an SSD (it's a local copy).

**Start.** The work is split in two because the WASMFS FS can't be used until the runtime is up.

- `preRun` reads the index and the small files (under 256 KiB) from OPFS.
- `onRuntimeInitialized` writes them into the engine's filesystem before `main()`. The player's file
  replaces the build's at the same path, matched case-insensitively.
- Big files become empty placeholders listed in `/SE1Lazy/user.txt` (dataset `u<hash>`).
  `port/common/LazyData.c` reads that manifest after the build's own one, and the last entry for a
  path wins.
- Their reads go back to `port/web/lazydata.js`, which serves a `u` dataset from the OPFS copy:
  - async reads use `File.slice`;
  - the single-threaded build's synchronous path (a script function JSPI can't suspend) uses a sync
    XHR with a Range header on a blob URL.
- These chunks are never fetched over the network or cached a second time.

Switches and calls:
- `?userdata=reset` shows the import screen again;
- `Module.se1UserDataInfo()` returns `{files, small, big, bytes, kind, when}`;
- `Module.se1UserDataClear()` deletes the copy;
- `Module.se1UserImport([{path, file}])` imports files (used by the screen and the tests);
- `Module.se1LazyStats().userBytes` is how much has been read from the copy.

The full game imports 334 files: 302 are written whole and 32 are read on demand. Reaching the menu
reads 58 MB of the copy, and a Survivors run on Hatshepsut reads 82 MB.

## Tests

`tools/userdatatest.mjs <url> [folder]` checks the whole flow. The folder defaults to
`data/tfe-demo-raw/Disk1`.

1. The first visit shows the screen and the engine waits.
2. The demo's `Help/` folder is refused.
3. The real folder is imported.
4. The game runs from the copy (`userBytes > 0`).
5. There are no read errors.
6. Sync and async reads give the same bytes.
7. The next visit starts without asking, and a Survivors level reaches an upgrade offer.
8. `?userdata=reset` asks again.

`tools/test.sh` builds `serioussam_byod` in both test builds and runs the test on each (the
"user data" steps). It passes on the packaged public bundle (`tools/package.sh`) behind a plain
`python3 -m http.server`, with retail data: `st/` directly, and `mt/` through `coi-sw.js`.

## Open

- **Safari:** the copy uses `FileSystemFileHandle.createWritable`, which Safari got late. Check
  which versions have it before relying on it; otherwise write from a worker with
  `createSyncAccessHandle`. Untested on Safari and iOS.
- **Phones:** picking a folder on Android Chrome and iOS is awkward or impossible. A zip import
  would help there.
- **TSE:** a TSE build with its own main-archive check (`SE1_00.gro`).
- Mods and user levels the player adds to the folder come along only under `Levels/` (full game).
