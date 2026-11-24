// The player's own game files (user-data build, notes/user-data.md).
//
// A user-data build carries no game data: only the engine, the GPL files from the upstream repo
// (src/SamTFE: scripts, SE1_10b.gro, ...) and the port's own files. The player picks the folder
// their game is installed in, once; this file copies the files the game needs into OPFS
// (se1-user/<game>/files/...) and, on every start, puts them into the engine's filesystem before
// main() runs:
//   - small files (< 256 KiB) are written whole (after the runtime starts: WASMFS makes the
//     preloaded files then, so this runs in onRuntimeInitialized, with the copy read in preRun);
//   - big ones become empty placeholders listed in /SE1Lazy/user.txt, which port/common/LazyData.c
//     reads like the build's own lazy manifest. Their reads come back to the page
//     (port/web/lazydata.js) and are served from the OPFS copy by se1UserRead below.
// The player's files win over the build's (as tools/make_full_data.sh and make_demo_data.sh lay
// them out), except Scripts/GLSettings, where the repo's settings stay.
//
//   ?userdata=reset         show the import screen again (and replace the files)
//   Module.se1UserImport(entries)  import [{path, file}] (path relative to any folder above the
//                           game folder, as webkitRelativePath gives it); used by the screen and tests
//   Module.se1UserDataInfo()  what is imported: {files, bytes, kind, when}
//   Module.se1UserDataClear()  delete the imported files
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this file too
  var cfg = Module['se1UserDataConfig'] || { game: 'tfe', demo: false };
  var SMALL = 262144;
  var q = new URLSearchParams(location.search);
  var files = new Map();   // engine path (lower case) -> File (a snapshot of the OPFS copy)
  var blobUrls = new Map();
  var info = null;

  // ------------------------------------------------------------------ what to import
  // The game folder is the one with the main archive. The full game: its archives, Levels and Help
  // (tools/make_full_data.sh). The demo: everything but the installer and Windows files
  // (tools/make_demo_data.sh).
  var MAIN = { full: /^1_00c\.gro$/i, demo: /^1_00c_demo\.gro$/i };
  var TSE = /^se1_00\.gro$/i;
  var SKIP_EXT = /\.(exe|ex_|bmp|inx|hdr|bin|cab|ini|log|dll)$/i;
  var SKIP_DIR = /^(bin|tools\.win32)$/i;

  function selectFiles(entries) {
    var roots = { full: null, demo: null }, tse = false;
    entries.forEach(function (e) {
      var parts = e.path.split('/'), name = parts[parts.length - 1], dir = parts.slice(0, -1).join('/');
      for (var k in MAIN) if (MAIN[k].test(name) && (roots[k] === null || dir.length < roots[k].length)) roots[k] = dir;
      if (TSE.test(name)) tse = true;
    });
    var kind = roots.full !== null ? 'full' : roots.demo !== null ? 'demo' : null;
    if (!kind) {
      if (tse) return { error: 'That is The Second Encounter. This page runs The First Encounter.' };
      if (!entries.some(function (e) { return /\.gro$/i.test(e.path); }))
        return { error: 'That folder has no game archives (.gro files). Pick the folder The First Encounter is installed in.' };
      return { error: 'That folder has .gro files, but not the game\'s main archive (1_00c.gro).' };
    }
    if (kind === 'demo' && !cfg.demo) return { error: 'That is the demo. This page needs the full game.' };
    if (kind === 'full' && cfg.demo) return { error: 'This test build runs the demo data only.' };
    var root = roots[kind], pre = root ? root + '/' : '', out = [];
    entries.forEach(function (e) {
      if (pre && e.path.slice(0, pre.length) !== pre) return;
      var rel = e.path.slice(pre.length), parts = rel.split('/');
      if (kind === 'full') {
        if (parts.length === 1 ? !/\.gro$/i.test(rel) : !/^(levels|help)$/i.test(parts[0])) return;
      } else {
        if (SKIP_EXT.test(rel) || parts.slice(0, -1).some(function (p) { return SKIP_DIR.test(p); })) return;
        if (parts[parts.length - 1] === '.DS_Store') return;
      }
      if (/^scripts\/glsettings\//i.test(rel)) return;   // the repo's GLSettings stay
      out.push({ path: rel, file: e.file });
    });
    return { kind: kind, files: out };
  }

  // ------------------------------------------------------------------ OPFS copy
  async function gameDir(create) {
    var root = await navigator.storage.getDirectory();
    var top = await root.getDirectoryHandle('se1-user', { create: create });
    return top.getDirectoryHandle(cfg.game, { create: create });
  }
  async function subdir(dir, parts, create) {
    for (var i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: create });
    return dir;
  }
  async function readIndex() {
    try {
      var dir = await gameDir(false);
      var f = await (await dir.getFileHandle('index.json')).getFile();
      var idx = JSON.parse(await f.text());
      return idx && idx.version === 1 && idx.files && idx.files.length ? idx : null;
    } catch (e) { return null; }
  }
  async function clear() {
    try {
      var root = await navigator.storage.getDirectory();
      var top = await root.getDirectoryHandle('se1-user');
      await top.removeEntry(cfg.game, { recursive: true });
    } catch (e) {}
    files.clear(); info = null;
  }

  // copy the selected files into se1-user/<game>/files; index.json last, so a copy that stops
  // half way is never used
  async function importFiles(entries, progress) {
    var sel = selectFiles(entries);
    if (sel.error) throw new Error(sel.error);
    var total = sel.files.reduce(function (a, e) { return a + e.file.size; }, 0);
    await clear();
    var est = null;
    try { est = await navigator.storage.estimate(); } catch (e) {}
    if (est && est.quota && est.quota - est.usage < total * 1.05)
      throw new Error('Not enough browser storage: the game needs ' + mb(total) + ', ' + mb(est.quota - est.usage) + ' is free.');
    try { if (navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    var dir = await gameDir(true), data = await dir.getDirectoryHandle('files', { create: true });
    var done = 0, list = [];
    for (var i = 0; i < sel.files.length; i++) {
      var e = sel.files[i], parts = e.path.split('/');
      var d = await subdir(data, parts.slice(0, -1), true);
      var fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      var w = await fh.createWritable();
      try { await w.write(e.file); await w.close(); }
      catch (err) {
        try { await w.abort(); } catch (x) {}
        if (err && err.name === 'QuotaExceededError') throw new Error('The browser ran out of storage while copying the game.');
        throw err;
      }
      done += e.file.size;
      list.push({ path: e.path, size: e.file.size, mtime: e.file.lastModified || 0 });
      if (progress) progress(done, total, e.path);
    }
    var idx = { version: 1, kind: sel.kind, when: Date.now(), files: list };
    var ih = await dir.getFileHandle('index.json', { create: true });
    var iw = await ih.createWritable();
    await iw.write(JSON.stringify(idx));
    await iw.close();
    return idx;
  }

  // ------------------------------------------------------------------ into the engine's filesystem
  function hash16(s) {   // FNV-1a, 15 hex digits: the "u" prefix makes the dataset id 16 chars
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 15);
  }
  function exists(p) { try { FS.stat(p); return true; } catch (e) { return false; } }

  // the engine path for a file: each directory that exists in another letter case is reused
  // (the repo has "Levels", a CD may have "LEVELS"), the others are created
  // (WASMFS makes the preloaded directories read-only, 0555: each one we write into is made
  // writable first)
  var listings = new Map();
  function resolve(rel) {
    var parts = rel.split('/'), cur = '';
    for (var i = 0; i < parts.length; i++) {
      var dir = cur || '/', names = listings.get(dir);
      if (!names) {
        names = new Map();
        try { FS.readdir(dir).forEach(function (n) { names.set(n.toLowerCase(), n); }); } catch (e) {}
        try { FS.chmod(dir, 0o777); } catch (e) {}
        listings.set(dir, names);
      }
      var hit = names.get(parts[i].toLowerCase());
      if (!hit) {
        hit = parts[i];
        if (i < parts.length - 1) FS.mkdir(cur + '/' + hit);
        names.set(hit.toLowerCase(), hit);
      }
      cur += '/' + hit;
    }
    return cur;
  }

  // read the copy (preRun, async): small files whole, big ones as File snapshots
  async function load(idx) {
    var data = await subdir(await gameDir(false), ['files'], false), out = [];
    for (var i = 0; i < idx.files.length; i++) {
      var e = idx.files[i], parts = e.path.split('/');
      var d = await subdir(data, parts.slice(0, -1), false);
      var file = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      out.push({ path: e.path, mtime: e.mtime, file: file,
                 bytes: file.size < SMALL ? new Uint8Array(await file.arrayBuffer()) : null });
    }
    return out;
  }

  // into the engine's filesystem (onRuntimeInitialized, sync): WASMFS creates the build's own
  // preloaded files only when the runtime starts, so this can't run in preRun
  function mount(idx, loaded) {
    var lines = [], big = 0, bytes = 0;
    loaded.forEach(function (e) {
      var p = e.path, step = 'resolve';
      try {
        p = resolve(e.path);
        step = 'replace';
        if (exists(p)) FS.unlink(p);   // the player's file wins over the repo's
        step = 'write';
        if (e.bytes) FS.writeFile(p, e.bytes);
        else {
          FS.writeFile(p, new Uint8Array(0));
          lines.push(hash16(p + '\0' + e.file.size + '\0' + e.mtime).padEnd(16, '0') + ' ' + e.file.size + ' ' + p.slice(1));
          files.set(p.slice(1).toLowerCase(), e.file);
          big++;
        }
      } catch (x) {
        console.error('user data: cannot add ' + p + ' (' + step + ', errno ' + (x && x.errno) + ')');
        return;
      }
      if (e.mtime) { try { FS.utime(p, e.mtime, e.mtime); } catch (x) {} }
      bytes += e.file.size;
      e.bytes = null;
    });
    var ds = 'u' + hash16(lines.join('\n'));
    try { FS.mkdir('/SE1Lazy'); } catch (x) {}
    FS.writeFile('/SE1Lazy/user.txt', 'dataset ' + ds + '\n' + lines.join('\n') + (lines.length ? '\n' : ''));
    info = { files: idx.files.length, small: idx.files.length - big, big: big, bytes: bytes, kind: idx.kind, when: idx.when };
    console.log('user data: ' + idx.files.length + ' files (' + mb(bytes) + ', ' + idx.kind + '), ' + big + ' read on demand');
  }

  function fileFor(path) {
    var f = files.get(path.replace(/^\/+/, '').toLowerCase());
    if (!f) throw new Error('not an imported file');
    return f;
  }
  Module['se1UserRead'] = async function (path, start, len) {
    var b = new Uint8Array(await fileFor(path).slice(start, start + len).arrayBuffer());
    if (b.length !== len) throw new Error('short read: ' + b.length + ' of ' + len);
    return b;
  };
  // single-threaded build inside a script function, where the engine can't wait for a Promise:
  // a synchronous XHR of a byte range of the File's blob URL
  Module['se1UserReadSync'] = function (path, start, len) {
    var f = fileFor(path), key = path.toLowerCase(), u = blobUrls.get(key);
    if (!u) { u = URL.createObjectURL(f); blobUrls.set(key, u); }
    var x = new XMLHttpRequest();
    x.open('GET', u, false);
    x.setRequestHeader('Range', 'bytes=' + start + '-' + (start + len - 1));
    x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send();
    var t = x.responseText, off = x.status === 200 ? start : 0, b = new Uint8Array(len);
    if (t.length - off < len) throw new Error('short read: ' + (t.length - off) + ' of ' + len);
    for (var i = 0; i < len; i++) b[i] = t.charCodeAt(off + i) & 0xff;
    return b;
  };
  Module['se1UserImport'] = function (entries, progress) { return importFiles(entries, progress); };
  Module['se1UserDataInfo'] = function () { return info; };
  Module['se1UserDataClear'] = clear;

  // ------------------------------------------------------------------ the import screen
  function mb(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB'; }

  // a dropped folder: walk its entries (readEntries returns them in batches)
  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      out.push({ path: prefix + entry.name, file: await new Promise(function (res, rej) { entry.file(res, rej); }) });
      return;
    }
    var reader = entry.createReader(), batch;
    do {
      batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
      for (var i = 0; i < batch.length; i++) await walk(batch[i], prefix + entry.name + '/', out);
    } while (batch.length);
  }

  function screen() {
    return new Promise(function (resolve) {
      var css = document.createElement('style');
      css.textContent =
        '#se1ud{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:#000;padding:16px;box-sizing:border-box}' +
        '#se1ud .card{max-width:520px;width:100%;background:#111;border:1px solid #3a3a3a;border-radius:8px;padding:22px 24px;box-sizing:border-box}' +
        '#se1ud h1{font:600 20px system-ui,sans-serif;margin:0 0 10px;color:#ffd75e}' +
        '#se1ud p{margin:0 0 10px;color:#ccc}#se1ud .small{font-size:12px;color:#999}' +
        '#se1ud .drop{margin:14px 0;border:2px dashed #555;border-radius:8px;padding:18px;text-align:center}' +
        '#se1ud .drop.over{border-color:#ffd75e;background:#1a1a10}' +
        '#se1ud button{font:600 14px system-ui,sans-serif;color:#111;background:#ffd75e;border:0;border-radius:5px;padding:9px 16px;cursor:pointer}' +
        '#se1ud button:disabled{opacity:.5;cursor:default}' +
        '#se1ud .err{color:#ff8a7a;min-height:1.4em;margin:6px 0 0}#se1ud progress{width:100%;margin-top:8px}';
      document.head.appendChild(css);
      var el = document.createElement('div');
      el.id = 'se1ud';
      el.innerHTML =
        '<div class="card"><h1>Your game files</h1>' +
        '<p>This page is the game engine only. The game itself comes from your own copy of ' +
        (cfg.demo ? 'the First Encounter demo.' : 'Serious Sam Classic: The First Encounter (Steam, GOG or CD).') + '</p>' +
        '<p>Pick the folder it is installed in. The files are copied into this browser, once, and stay on this device.</p>' +
        '<div class="drop"><button type="button">Choose the game folder</button><div class="small" style="margin-top:8px">or drop the folder here</div></div>' +
        '<p class="small">Steam: right-click the game, then Manage, then Browse local files.</p>' +
        '<p class="err"></p><progress hidden></progress><p class="small status"></p></div>';
      document.body.appendChild(el);
      var input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.webkitdirectory = true; input.hidden = true;
      input.id = 'se1ud-input';
      el.appendChild(input);
      var btn = el.querySelector('button'), drop = el.querySelector('.drop'), err = el.querySelector('.err');
      var bar = el.querySelector('progress'), status = el.querySelector('.status');
      var busy = false;
      if (Module['setStatus']) Module['setStatus']('');
      async function run(entries) {
        if (busy) return;
        busy = true; btn.disabled = true; err.textContent = '';
        try {
          bar.hidden = false; bar.value = 0;
          var idx = await importFiles(entries, function (done, total, path) {
            bar.max = total; bar.value = done;
            status.textContent = 'Copying ' + mb(done) + ' of ' + mb(total) + ': ' + path;
          });
          el.remove(); css.remove();
          resolve(idx);
        } catch (e) {
          err.textContent = e.message || String(e);
          bar.hidden = true; status.textContent = '';
          busy = false; btn.disabled = false;
        }
      }
      btn.onclick = function () { input.click(); };
      input.onchange = function () {
        var entries = Array.prototype.map.call(input.files, function (f) { return { path: f.webkitRelativePath || f.name, file: f }; });
        input.value = '';
        run(entries);
      };
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = function () { drop.classList.remove('over'); };
      drop.ondrop = async function (e) {
        e.preventDefault(); drop.classList.remove('over');
        var items = Array.prototype.slice.call(e.dataTransfer.items || []), out = [];
        try {
          for (var i = 0; i < items.length; i++) {
            var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
            if (en) await walk(en, '', out);
          }
        } catch (x) { err.textContent = 'Could not read the dropped folder: ' + x; return; }
        run(out);
      };
      Module['se1UserScreen'] = el;   // tests look for it
    });
  }

  var ready = null;   // {idx, loaded} once preRun has read the copy
  Module['preRun'] = (Module['preRun'] || []).concat([function () {
    addRunDependency('se1-userdata');
    (async function () {
      if (!(navigator.storage && navigator.storage.getDirectory)) {
        if (Module['setStatus']) Module['setStatus']('This browser has no private file storage (OPFS), which the game files need.');
        return;
      }
      var idx = q.get('userdata') !== 'reset' ? await readIndex() : null;
      if (!idx) idx = await screen();
      var loaded;
      try { loaded = await load(idx); }
      catch (e) {
        // the copy is gone or broken (storage cleared under us): ask again
        console.error('user data: ' + e);
        await clear();
        idx = await screen();
        loaded = await load(idx);
      }
      ready = { idx: idx, loaded: loaded };
      removeRunDependency('se1-userdata');
    })();
  }]);
  var prevInit = Module['onRuntimeInitialized'];
  Module['onRuntimeInitialized'] = function () {
    if (ready) { mount(ready.idx, ready.loaded); ready = null; }
    if (prevInit) prevInit.apply(this, arguments);
  };
})();
