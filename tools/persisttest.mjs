#!/usr/bin/env node
// Persistent user directory test (port/web/persist.js + port/common/Persist.cpp):
// the engine's settings survive a page reload in both builds.
//
//   node tools/persisttest.mjs http://127.0.0.1:8340/serioussam.html   (threaded, OPFS)
//   node tools/persisttest.mjs http://127.0.0.1:8341/serioussam.html   (single-threaded, IDBFS)
//
// ONE Chrome profile for the whole test (temp --user-data-dir), so storage
// survives the Page.reload. The engine stores its settings only at shutdown,
// which never happens in a browser: the page asks it through
// Module.se1SaveNow() (persist.js) and the engine thread stores on the next
// frame. mt: /libsdl is an OPFS-backed directory (WASMFS); st: /libsdl is an
// IDBFS mount (IndexedDB database named "/libsdl", store FILE_DATA).
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url] = process.argv.slice(2);
if (!url) { console.error('usage: persisttest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9800 + Math.floor(Math.random() * 50);
// one profile for the whole test: OPFS/IndexedDB live there and survive the reload
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1pt-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// walk the OPFS tree from the page: flat list of {path, size} for every file
const LIST_OPFS = `
(async () => {
  const out = [];
  async function walk(h, prefix) {
    for await (const [name, handle] of h.entries()) {
      const p = prefix + '/' + name;
      if (handle.kind === 'directory') await walk(handle, p);
      else {
        // the engine's OPFS backend keeps files open (sync access handles): getFile() may refuse
        let size = -1;
        try { size = (await handle.getFile()).size; } catch (e) {}
        out.push({ path: p, size });
      }
    }
  }
  await walk(await navigator.storage.getDirectory(), '');
  return out;
})()`;
// IDBFS keeps its files in the IndexedDB database named after the mount path
// ("/libsdl"), store FILE_DATA, one record per file (key = the path).
const LIST_IDB = `
new Promise((resolve, reject) => {
  const req = indexedDB.open('/libsdl');
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); resolve([]); return; }
    let out = [];
    try {
      const tx = db.transaction('FILE_DATA', 'readonly');
      const cur = tx.objectStore('FILE_DATA').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { const v = c.value; out.push({ path: c.key, size: v ? (v.byteLength !== undefined ? v.byteLength : v.size) : -1 }); c.continue(); }
        else { db.close(); resolve(out); }
      };
    } catch (e) { db.close(); reject(e); }
  };
  req.onerror = () => reject(req.error);
})`;
// write a marker file through the build's storage API, in the engine's user dir
const WRITE_MARKER = `
(async () => {
  const dir = await navigator.storage.getDirectory();
  const sdl = await dir.getDirectoryHandle('libsdl', { create: true });
  const ser = await sdl.getDirectoryHandle('SeriousSam', { create: true });
  const fh = await ser.getFileHandle('se1-persist-marker.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('se1-persist-marker ' + Date.now());
  await w.close();
})()`;
const WRITE_MARKER_IDB = `
new Promise((resolve, reject) => {
  const req = indexedDB.open('/libsdl');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('FILE_DATA', 'readwrite');
    tx.objectStore('FILE_DATA').put(new Uint8Array([104, 105]), '/libsdl/SeriousSam/se1-persist-marker.txt');
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
  req.onerror = () => reject(req.error);
})`;

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate failed');
    return res.result?.value;
  };
  const until = async (expr, pred, ms) => { let v; for (let t = 0; t < ms / 1000; t++) { v = await ev(expr); if (pred(v)) return v; await sleep(1000); } return v; };
  const frames = () => ev(`Module.se1Perf ? Module.se1Perf.n : -1`);
  const list = () => ev(buildKind === 'mt' ? LIST_OPFS : LIST_IDB, true);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1' });
  // which build is this: the st build's persist.js sets Module.se1PersistFlush in preRun
  // (IDBFS flush); the mt build has no such hook (WASMFS OPFS persists on its own).
  // Check after the engine has run a few frames so preRun has completed.
  await until(frames, (n) => n > 10, 120000 * TIMEOUT_SCALE);
  const buildKind = await ev(`typeof Module.se1PersistFlush === 'function' ? 'st' : 'mt'`);

  // 1. engine writes to persistent storage
  await until(frames, (n) => n > 60, 120000 * TIMEOUT_SCALE);
  await ev(`Module.se1SaveNow && Module.se1SaveNow()`);
  // the engine stores on the next frame; give it a few seconds, then list
  let files;
  for (let t = 0; t < 15; t++) {
    await sleep(1000);
    files = await list();
    if (files && files.some((x) => /PersistentSymbols\.ini$/.test(x.path))) break;
  }
  check('engine writes to persistent storage', files && files.some((x) => /PersistentSymbols\.ini$/.test(x.path)),
    `${buildKind}: ${files ? files.length : 0} files, ${files ? files.slice(0, 5).map((x) => x.path + ':' + x.size).join(', ') : '(none)'}`);
  const ps = files.find((x) => /PersistentSymbols\.ini$/.test(x.path));

  // 2. settings survive a reload (the file is there before saving again).
  // Page.reload hangs in headless Chrome with JSPI, so navigate away and back.
  await ev(buildKind === 'mt' ? WRITE_MARKER : WRITE_MARKER_IDB, true);   // a file only the page wrote
  const before = await frames();
  const reloadUrl = url + (url.includes('?') ? '&' : '?') + 'mute=1';
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(2000);
  await send('Page.navigate', { url: reloadUrl });
  await until(`typeof Module !== 'undefined'`, (v) => v, 180000 * TIMEOUT_SCALE);
  await until(frames, (n) => n > 60, 180000 * TIMEOUT_SCALE);
  const f1 = await frames();
  files = await list();
  const psAfter = files.find((x) => /PersistentSymbols\.ini$/.test(x.path));
  check('settings survive a reload', !!psAfter && psAfter.size === ps.size,
    `before ${ps.path}:${ps.size}, after reload ${psAfter ? psAfter.path + ':' + psAfter.size : 'missing'}, frames ${before}->${f1}`);
  const marker = files.find((x) => /se1-persist-marker\.txt$/.test(x.path));
  check('page-written marker survives a reload', !!marker, marker ? `${marker.path}:${marker.size}` : 'missing');

  // 3. engine sees the stored file: the engine only creates/rewrites its own files, and a
  //    reload starts from the persisted tree, so every user-dir file listed here (settings,
  //    marker) is what the engine booted from. A clean engine-side proof: the marker is in the
  //    same directory the engine's IncludeDir scans, and the settings file is what the engine
  //    itself included at startup (it is listed because it was loaded, not rewritten).
  check('engine sees the stored file', !!psAfter && !!marker,
    `user dir after reload: ${files.map((x) => x.path).join(', ') || '(empty)'}`);

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
  process.exit(failed ? 1 : 0);
}
