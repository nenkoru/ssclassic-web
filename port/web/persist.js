// Persistent storage for the engine's user directory (/libsdl).
//
// Single-threaded build (MEMFS): mount IDBFS at /libsdl before the engine
// runs, so its settings/controls/saves land in IndexedDB; flush after every
// engine save and periodically. The threaded build persists through WASMFS's
// OPFS backend (port/common/Persist.cpp) and has no IDBFS.
//
// Both builds: ask the engine to store its settings (Module.se1SaveNow) when
// the page is hidden, is going away, and every 60 s while visible. The engine
// writes only at shutdown, which never happens in a browser.
(function () {
  // IDBFS is part of the emscripten runtime and is not defined when this
  // pre-js file runs, so the mount/flush setup goes in preRun (where IDBFS
  // and FS are available). The page-side hooks work in both builds.
  Module['preRun'] = (Module['preRun'] || []).concat([function () {
    if (typeof IDBFS === 'undefined') return;   // threaded build: WASMFS OPFS handles persistence
    addRunDependency('se1persist');
    FS.mkdir('/libsdl');
    FS.mount(IDBFS, {}, '/libsdl');
    FS.syncfs(true, function (err) {   // load IndexedDB into the filesystem
      if (err) console.error('web: IDBFS load failed:', err);
      removeRunDependency('se1persist');
    });
    // flush the filesystem to IndexedDB, never two at once (IDBFS syncfs
    // overlaps are not supported): a request while one is running queues one
    // more right after it
    var flushing = false, queued = false;
    function flush() {
      if (flushing) { queued = true; return; }
      flushing = true;
      FS.syncfs(false, function (err) {
        flushing = false;
        if (err) console.error('web: IDBFS save failed:', err);
        if (queued) { queued = false; flush(); }
      });
    }
    Module['se1PersistFlush'] = flush;
    setInterval(flush, 10000);   // safety net: a hidden tab never gets pagehide
  }]);

  if (typeof window !== 'undefined') {
    var request = function () { try { Module['_SE1_RequestSave'] && Module['_SE1_RequestSave'](); } catch (e) {} };
    Module['se1SaveNow'] = request;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') request();
    });
    window.addEventListener('pagehide', request);
    setInterval(function () { if (document.visibilityState === 'visible') request(); }, 60000);
  }
})();
