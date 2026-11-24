#!/usr/bin/env node
// User-data build test (port/web/userdata.js, notes/user-data.md): the page without game data asks
// for the player's folder, rejects a wrong one, imports the right one into OPFS, runs the game from
// it, and starts straight away on the next visit.
//
//   node tools/userdatatest.mjs <url of a byod/serioussam.html> [game folder]
//
// The game folder defaults to the unpacked demo (data/tfe-demo-raw/Disk1, tools/fetch_demo_data.sh):
// the test builds are demo builds (SE1_DEMO). For a full-game build pass the retail folder
// (e.g. data/tfe-full). The folder goes through the page's real <input webkitdirectory>
// (DOM.setFileInputFiles), so installer files, Bin/ and the rest are filtered as for a player.
// It also runs against a hosting bundle (tools/package.sh) on a plain static server: st/ directly,
// mt/ through coi-sw.js.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [url, folderArg] = process.argv.slice(2);
if (!url) { console.error('usage: userdatatest.mjs <url> [game folder]'); process.exit(2); }
const folder = resolve(folderArg || join(ROOT, 'data/tfe-demo-raw/Disk1'));
if (!existsSync(folder)) { console.error('no game folder: ' + folder); process.exit(2); }
const wrong = join(folder, 'Help');   // a folder without the game's archives

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9850 + Math.floor(Math.random() * 50);
const profile = tempProfile('se1ud-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = []; const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate failed');
    return res.result?.value;
  };
  const until = async (expr, pred, ms) => { let v; const end = Date.now() + ms; do { v = typeof expr === "function" ? await expr() : await ev(expr); if (pred(v)) return v; await sleep(500); } while (Date.now() < end); return v; };
  const frames = () => ev(`typeof Module === 'undefined' ? -2 : Module.se1Perf ? Module.se1Perf.n : -1`);
  const screenUp = () => ev(`!!document.getElementById('se1ud')`);
  const pick = async (path) => {
    const doc = await send('DOM.getDocument', { depth: 0 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#se1ud-input' });
    const r = await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path] });
    if (r.error) throw new Error('setFileInputFiles: ' + r.error.message);
  };
  const open = async (u) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    await send('Page.navigate', { url: u });
    await until(`typeof Module !== 'undefined'`, (v) => v, 60000 * TIMEOUT_SCALE);
  };
  const withMute = (u, extra = '') => u + (u.includes('?') ? '&' : '?') + 'mute=1' + extra;

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  // 1. first visit: the import screen, and the engine waits
  await open(withMute(url));
  const up = await until(`!!document.getElementById('se1ud')`, (v) => v, 60000 * TIMEOUT_SCALE);
  await sleep(1500);
  check('first visit asks for the game folder', up && (await frames()) <= 0, `screen ${up}, frames ${await frames()}`);

  // 2. a folder without the game's archives is refused
  await pick(wrong);
  const err = await until(`document.querySelector('#se1ud .err').textContent`, (v) => !!v, 20000);
  check('a wrong folder is refused', !!err && (await screenUp()), JSON.stringify(err));

  // 3. the game folder: copied into OPFS, then the game runs from it
  const t0 = Date.now();
  await pick(folder);
  const gone = await until(`!document.getElementById('se1ud')`, (v) => v, 300000 * TIMEOUT_SCALE);
  const importS = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await ev(`Module.se1UserDataInfo && Module.se1UserDataInfo()`);
  check('the game folder is imported', gone && info && info.files > 10,
    `${importS} s, ${info ? `${info.files} files, ${(info.bytes / 1e6).toFixed(1)} MB, ${info.big} on demand, ${info.kind}` : 'no info'}`);
  const n = await until(frames, (v) => v > 120, 180000 * TIMEOUT_SCALE);
  const stats = await ev(`Module.se1LazyStats && Module.se1LazyStats()`);
  const manifestLine = logs.find((l) => /from \/SE1Lazy\/user\.txt/.test(l));
  check('the game runs from the imported files', n > 120 && stats && stats.userBytes > 0 && !stats.errors,
    `frames ${n}, read ${stats ? (stats.userBytes / 1e6).toFixed(1) : '?'} MB of them, errors ${stats ? stats.errors : '?'}; ${manifestLine || 'no user manifest line'}`);
  const unreadable = logs.filter((l) => /lazy data: cannot read|user data: /.test(l) && !/^user data: \d+ files/.test(l));
  check('no read errors', unreadable.length === 0, unreadable.length + ': ' + unreadable.slice(0, 3).join(' | '));

  if (process.env.SE1_UD_EVAL) console.log('eval: ' + JSON.stringify(await ev(process.env.SE1_UD_EVAL, true)));

  // the synchronous read (single-threaded build inside a script function: blob URL + Range) gives
  // the same bytes as the async one
  const same = await ev(`(async () => {
    const big = Object.keys(Module.se1LazyStats().files).find((p) => /^1_00.*\\.gro$/i.test(p));
    if (!big) return 'no archive read';
    const a = await Module.se1UserRead(big, 300000, 65536), b = Module.se1UserReadSync(big, 300000, 65536);
    return a.length === b.length && a.every((x, i) => x === b[i]) ? 'same: ' + big : 'differ: ' + big;
  })()`, true);
  check('sync and async reads agree', /^same/.test(same), same);

  // 4. the next visit starts without asking, and a level loads from the imported files
  const level = info && info.kind === 'demo' ? 'Levels/KarnakDemo.wld' : 'Levels/01_Hatshepsut.wld';
  await open(withMute(url, '&mode=survivors&svauto=1&svxp=5&level=' + encodeURIComponent(level)));
  const n2 = await until(frames, (v) => v > 60, 180000 * TIMEOUT_SCALE);
  const info2 = await ev(`Module.se1UserDataInfo && Module.se1UserDataInfo()`);
  check('the next visit starts straight away', n2 > 60 && !(await screenUp()) && info2 && info2.files === info.files,
    `frames ${n2}, ${info2 ? info2.files : 0} files`);
  // Survivors only offers upgrades in a running level (svxp=5: the first kills level up)
  const offer = await until(`JSON.stringify(Module.se1SurvivorsOffer || Module.se1SurvivorsLast || null)`, (v) => v && v !== 'null', 150000 * TIMEOUT_SCALE);
  const lazy2 = await ev(`Module.se1LazyStats && Module.se1LazyStats()`);
  check('a level runs from them', !!offer && offer !== 'null' && lazy2 && !lazy2.errors,
    `${level}: survivors ${offer ? offer.slice(0, 80) : 'never started'}; ${lazy2 ? (lazy2.userBytes / 1e6).toFixed(1) : '?'} MB read`);

  // 5. ?userdata=reset asks again
  await open(withMute(url, '&userdata=reset'));
  const up3 = await until(`!!document.getElementById('se1ud')`, (v) => v, 60000 * TIMEOUT_SCALE);
  check('?userdata=reset asks again', up3, `screen ${up3}`);

  // isolate.js stops the first load on a plain host on purpose, before coi-sw.js reloads the page
  const unexpected = errors.filter((e) => !e.includes('se1: waiting for cross-origin isolation'));
  check('no exceptions', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  if (failed) console.log('page console (last 40 distinct lines):\n  ' + logs.filter((l, i, a) => a.indexOf(l) === i).slice(-40).join('\n  '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome, profile);
  process.exit(failed ? 1 : 0);
}
