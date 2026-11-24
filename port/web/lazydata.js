// Lazy game data, page side (notes/lazy-data.md; the engine side is port/common/LazyData.c).
//
// The engine asks for byte ranges of the big data files in 256 KiB chunks. Each chunk comes from
// the OPFS cache (se1-lazy/<dataset>/<key>.<chunk>) or, when missing, from gamedata/<path> with
// an HTTP Range request (one request per run of missing chunks), and is then written to OPFS
// for the next visit. A server that ignores Range and sends the whole file still works: the
// file is kept in memory for this session and served from there.
//
//   ?lazycache=0       no OPFS: every chunk from the network (tests, comparisons)
//   Module.se1LazyBase base URL of the lazy files (default: gamedata/ next to the page)
//   Module.se1LazyStats()  counters (network/OPFS bytes and requests, time waited)
//   Module.se1LazyClear()  empty the OPFS cache
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this file too
  var q = new URLSearchParams(location.search);
  var useCache = q.get('lazycache') !== '0' && !!(navigator.storage && navigator.storage.getDirectory);
  var stats = { requests: 0, chunks: 0, netRequests: 0, netBytes: 0, opfsChunks: 0, opfsBytes: 0, waitMs: 0, fullFiles: 0, errors: 0, files: {} };
  var wholeFiles = new Map();   // path -> Promise<ArrayBuffer>, when the server ignored Range
  var wholeDone = new Map();    // path -> ArrayBuffer, the same once loaded (for fetchSync)
  var dirP = null;              // Promise<FileSystemDirectoryHandle> of se1-lazy/<dataset>
  var writing = Promise.resolve();

  function base() {
    return Module['se1LazyBase'] || new URL('gamedata/', location.href).href;
  }
  function url(path) {
    return base() + path.split('/').map(encodeURIComponent).join('/');
  }

  // se1-lazy/<dataset>; keeps the current dataset and the most recently used other one
  function datasetDir(dataset) {
    if (dirP) return dirP;
    dirP = (async function () {
      var root = await navigator.storage.getDirectory();
      var top = await root.getDirectoryHandle('se1-lazy', { create: true });
      try { if (navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
      var used = {};
      try { used = JSON.parse(localStorage.getItem('se1-lazy-used') || '{}'); } catch (e) {}
      used[dataset] = Date.now();
      var others = Object.keys(used).filter(function (d) { return d !== dataset; })
        .sort(function (a, b) { return used[b] - used[a]; });
      var keep = { }; keep[dataset] = 1; if (others[0]) keep[others[0]] = 1;
      for await (var name of top.keys()) {
        if (!keep[name]) { try { await top.removeEntry(name, { recursive: true }); } catch (e) {} delete used[name]; }
      }
      try { localStorage.setItem('se1-lazy-used', JSON.stringify(used)); } catch (e) {}
      return top.getDirectoryHandle(dataset, { create: true });
    })();
    dirP.catch(function (e) { console.warn('lazy data: no OPFS cache:', e); useCache = false; });
    return dirP;
  }

  async function cacheRead(dir, name, len) {
    try {
      var fh = await dir.getFileHandle(name);
      var file = await fh.getFile();
      if (file.size !== len) return null;   // a write that didn't finish
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) { return null; }
  }
  function cacheWrite(dir, name, bytes) {
    // one write at a time, after the engine has its bytes: never delays a read
    writing = writing.then(async function () {
      if (!useCache) return;
      try {
        var fh = await dir.getFileHandle(name, { create: true });
        var w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') { console.warn('lazy data: OPFS full, caching stops'); useCache = false; }
      }
    });
  }

  async function fetchRange(path, start, len) {
    var whole = wholeFiles.get(path);
    if (whole) return new Uint8Array(await whole, start, len);
    var r, err;
    for (var attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(function (res) { setTimeout(res, 250 * Math.pow(2, attempt)); });
      try {
        r = await fetch(url(path), { headers: { Range: 'bytes=' + start + '-' + (start + len - 1) } });
        if (r.status === 206 || r.status === 200) break;
        err = new Error('HTTP ' + r.status); r = null;
      } catch (e) { err = e; r = null; }
    }
    if (!r) throw err;
    stats.netRequests++;
    if (r.status === 200) {   // the server ignored Range: keep the whole file for this session
      stats.fullFiles++;
      var p = r.arrayBuffer();
      wholeFiles.set(path, p);
      p.then(function (b) { wholeDone.set(path, b); }, function () { wholeFiles.delete(path); });
      var buf = await p;
      stats.netBytes += buf.byteLength;
      return new Uint8Array(buf, start, len);
    }
    var b = new Uint8Array(await r.arrayBuffer());
    stats.netBytes += b.length;
    if (b.length !== len) throw new Error('short range: ' + b.length + ' of ' + len);
    return b;
  }

  // fill HEAPU8[dst .. dst+len) with chunks first .. first+count-1 of the file
  async function fill(dataset, key, path, first, count, chunk, dst, len) {
    var t0 = performance.now();
    stats.requests++; stats.chunks += count;
    stats.files[path] = (stats.files[path] || 0) + count;   // chunks asked for, per file
    var sizes = [], parts = new Array(count), off = 0;
    for (var i = 0; i < count; i++) { sizes.push(Math.min(chunk, len - off)); off += sizes[i]; }
    var dir = null;
    if (useCache) { try { dir = await datasetDir(dataset); } catch (e) { dir = null; } }
    if (dir) {
      var got = await Promise.all(sizes.map(function (s, i) { return cacheRead(dir, key + '.' + (first + i), s); }));
      got.forEach(function (b, i) { if (b) { parts[i] = b; stats.opfsChunks++; stats.opfsBytes += b.length; } });
    }
    var lo = parts.findIndex(function (b) { return !b; });
    if (lo >= 0) {   // one request for the span of missing chunks
      var hi = count - 1;
      while (parts[hi]) hi--;
      var spanStart = 0;
      for (i = 0; i < lo; i++) spanStart += sizes[i];
      var spanLen = 0;
      for (i = lo; i <= hi; i++) spanLen += sizes[i];
      var bytes = await fetchRange(path, first * chunk + spanStart, spanLen);
      for (i = lo, off = 0; i <= hi; off += sizes[i], i++) {
        if (parts[i]) continue;
        parts[i] = bytes.subarray(off, off + sizes[i]);
        if (dir) cacheWrite(dir, key + '.' + (first + i), parts[i].slice());
      }
    }
    for (i = 0, off = 0; i < count; off += sizes[i], i++) HEAPU8.set(parts[i], dst + off);
    stats.waitMs += performance.now() - t0;
  }

  // synchronous read for the single-threaded build where JSPI can't suspend (a script function
  // called through JS, see LazyData.c): sync XHR with a binary string, no OPFS read (that's async)
  function fillSync(dataset, key, path, first, count, chunk, dst, len) {
    var t0 = performance.now();
    stats.requests++; stats.chunks += count; stats.syncRequests = (stats.syncRequests || 0) + 1;
    stats.files[path] = (stats.files[path] || 0) + count;
    var start = first * chunk, bytes = null, whole = wholeDone.get(path), err;
    if (whole) bytes = new Uint8Array(whole, start, len);
    for (var attempt = 0; attempt < 3 && !bytes; attempt++) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', url(path), false);
        x.setRequestHeader('Range', 'bytes=' + start + '-' + (start + len - 1));
        x.overrideMimeType('text/plain; charset=x-user-defined');
        x.send();
        if (x.status !== 206 && x.status !== 200) { err = new Error('HTTP ' + x.status); continue; }
        var t = x.responseText, b = new Uint8Array(t.length);
        for (var i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff;
        stats.netRequests++; stats.netBytes += b.length;
        if (x.status === 200) { stats.fullFiles++; wholeDone.set(path, b.buffer); wholeFiles.set(path, Promise.resolve(b.buffer)); b = b.subarray(start, start + len); }
        if (b.length !== len) { err = new Error('short range: ' + b.length + ' of ' + len); continue; }
        bytes = b;
      } catch (e) { err = e; }
    }
    if (!bytes) throw err;
    HEAPU8.set(bytes, dst);
    if (useCache) {   // keep them for the next visit
      datasetDir(dataset).then(function (dir) {
        for (var i = 0, off = 0; i < count; i++) {
          var n = Math.min(chunk, len - off);
          cacheWrite(dir, key + '.' + (first + i), bytes.slice(off, off + n));
          off += n;
        }
      }, function () {});
    }
    stats.waitMs += performance.now() - t0;
  }

  Module['se1Lazy'] = {
    fetchSync: function (dataset, key, path, first, count, chunk, dst, len) {
      try { fillSync(dataset, key, path, first >>> 0, count >>> 0, chunk >>> 0, dst >>> 0, len >>> 0); return 1; }
      catch (e) { stats.errors++; console.error('lazy data: ' + path + ': ' + e); return -1; }
    },
    // single-threaded build: awaited through JSPI; 1 = done, -1 = failed
    fetch: async function (dataset, key, path, first, count, chunk, dst, len) {
      try { await fill(dataset, key, path, first, count, chunk, dst, len); return 1; }
      catch (e) { stats.errors++; console.error('lazy data: ' + path + ': ' + e); return -1; }
    },
    // threaded build: the engine thread waits on the int32 at `state` (0 -> 1 or -1)
    fetchForThread: function (state, ds, key, path, first, count, chunk, dst, len) {
      var a = [UTF8ToString(ds), UTF8ToString(key), UTF8ToString(path)];
      this.fetch(a[0], a[1], a[2], first >>> 0, count >>> 0, chunk >>> 0, dst >>> 0, len >>> 0).then(function (v) {
        Atomics.store(HEAP32, state >> 2, v);
        Atomics.notify(HEAP32, state >> 2);
      });
    },
  };
  Module['se1LazyStats'] = function () {
    var s = Object.assign({}, stats, { files: Object.assign({}, stats.files) });
    s.waitMs = Math.round(s.waitMs);
    s.cache = useCache;
    return s;
  };
  Module['se1LazyClear'] = async function () {
    var root = await navigator.storage.getDirectory();
    try { await root.removeEntry('se1-lazy', { recursive: true }); } catch (e) {}
    dirP = null;
  };
})();
