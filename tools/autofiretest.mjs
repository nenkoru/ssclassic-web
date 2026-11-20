#!/usr/bin/env node
// Auto-fire test (rust/se1-mod/src/survivors/mod.rs auto_fire + port/web/survivors.js).
// Loads ?mode=survivors&svauto=1&svgod=1&mute=1 with no input at all: the twin Schofields fire by
// themselves at the nearest visible enemy, so kills must go up. Then the same run with
// &svautofire=0: nothing fires, so kills must stay at 0.
//
//   node tools/autofiretest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-autofire')] = process.argv.slice(2);
if (!url) { console.error('usage: autofiretest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9950 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1af-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); }
    catch { await sleep(200); }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const last = async () => JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsLast || null)')) || 'null');
  await send('Runtime.enable'); await send('Page.enable');
  // a headless page has no focus, and the game pauses itself without focus/input: emulate focus
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });

  // auto-fire on (the default): no input at all, the Schofields must kill on their own
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1' });
  let m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.time > 25); t++) { await sleep(500); m = await last(); }
  check('kills on its own', !!(m && m.kills > 0), m ? `time ${m.time}, kills ${m.kills}, alive ${m.alive}` : 'no HUD');

  // auto-fire off: same run, nothing fires without input
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svautofire=0' });
  m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.time > 25); t++) { await sleep(500); m = await last(); }
  check('off by option', !!(m && m.kills === 0), m ? `time ${m.time}, kills ${m.kills}, alive ${m.alive}` : 'no HUD');

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
