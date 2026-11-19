#!/usr/bin/env node
// gl1shim sync-call test: in the threaded build the engine worker must not block on the main
// thread for shader work. port/common/gl1shim.c records createProgram / uniformLocation as
// commands (OP_NEWPROG / OP_NEWULOC) and the replayer resolves the handles on the main thread,
// so Module.se1GfxSync.createProgram and .uniformLocation must stay 0 in play.
//
//   node tools/shimtest.mjs http://127.0.0.1:8350/serioussam.html
//
// Chrome binary, ANGLE backend, extra flags and timeout scaling come from the environment
// (CHROME, SE1_ANGLE, SE1_CHROME_FLAGS, SE1_TIMEOUT_SCALE: see tools/chrome.mjs).
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: shimtest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9850 + Math.floor(Math.random() * 49);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1shim-')}`,
  '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...gpuFlags(), ...EXTRA_FLAGS,
  '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  // survivors with god mode drops straight into play; shader combinations appear as the player
  // moves through the level
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1' });

  // engine up (up to ~60 s headless)
  let s;
  for (let t = 0; t < 240 * TIMEOUT_SCALE; t++) {
    s = await ev('JSON.stringify({ frames: Module.se1Perf ? Module.se1Perf.n : -1, sync: Module.se1GfxSync || null })');
    s = JSON.parse(s || 'null');
    if (s && s.frames > 60) break;
    await sleep(500);
  }
  check('engine is running', s && s.frames > 60, `frames ${s ? s.frames : -1}`);
  check('se1GfxSync is exposed', s && s.sync && typeof s.sync.createProgram === 'number',
    s && s.sync ? JSON.stringify(s.sync) : 'missing');

  // 20 s in play: enough new shader combinations for the base build to compile several programs
  await sleep(20000 * TIMEOUT_SCALE);
  const r = await ev('JSON.stringify(Module.se1GfxSync || null)');
  const sync = JSON.parse(r || 'null') || { createProgram: -1, uniformLocation: -1, other: -1 };
  check('no synchronous program calls', sync.createProgram === 0 && sync.uniformLocation === 0,
    `createProgram ${sync.createProgram}, uniformLocation ${sync.uniformLocation}, other ${sync.other}`);
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
