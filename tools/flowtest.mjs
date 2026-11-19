#!/usr/bin/env node
// Input / game-flow test: drives the page like a player and checks that the engine keeps running.
//   1. intro: frames advance on their own
//   2. a mouse click (intro "any key") starts the next demo: the demo clock runs, frames advance
//   3. Escape stops the demo; the menu is shown and frames keep advancing
// Exits 1 if a step fails. Screenshots go to <outdir>/flow-<step>.png.
//
//   node tools/flowtest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
//
// Headless Chrome has no real window: pointer lock is stubbed as granted (otherwise the request
// throws inside the engine's call stack and stops it, which real browsers don't do).
// Chrome binary, ANGLE backend, extra flags and timeout scaling come from the environment (CHROME,
// SE1_ANGLE, SE1_CHROME_FLAGS, SE1_TIMEOUT_SCALE: see tools/chrome.mjs); SE1_TIMEOUT_SCALE also
// widens the frame-counting windows, for software rendering on slow machines.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-flow')] = process.argv.slice(2);
if (!url) { console.error('usage: flowtest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const port = 9700 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1flow-'))}`,
  '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...gpuFlags(), ...EXTRA_FLAGS,
  '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const WIN = 2000 * TIMEOUT_SCALE;   // frame-counting window (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const consoleLog = [];   // page console, printed when a check fails
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
    if (d.method === 'Runtime.consoleAPICalled') { consoleLog.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' ')); if (consoleLog.length > 200) consoleLog.shift(); }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const frames = () => ev('Module.se1Perf ? Module.se1Perf.n : -1');
  const demo = () => ev('Module._SE1_DemoTime ? Module._SE1_DemoTime() : -2');
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outdir, `flow-${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const key = async (k, code, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); };
  const click = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 540, y: 500, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 540, y: 500, button: 'left', clickCount: 1 });
  };
  const advancing = async (ms) => { const a = await frames(); await sleep(ms); const b = await frames(); return [a, b, b - a]; };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1' });
  for (let t = 0; t < 120 * TIMEOUT_SCALE && (await frames()) < 60; t++) await sleep(500);   // engine up

  let [, , n] = await advancing(WIN);
  check('intro runs', n >= 20, `${n} frames in ${WIN / 1000} s`);
  await shot('1-intro');

  await click();
  let d = -1;
  for (let t = 0; t < 60 * TIMEOUT_SCALE && d < 0; t++) { await sleep(500); d = await demo(); }   // demo loading
  [, , n] = await advancing(WIN);
  check('click starts a demo', d >= 0 && n >= 20, `demo time ${d.toFixed ? d.toFixed(2) : d}, ${n} frames in ${WIN / 1000} s`);
  await shot('2-demo');

  await key('Escape', 'Escape', 27);
  for (let t = 0; t < 20 * TIMEOUT_SCALE && (d = await demo()) >= 0; t++) await sleep(500);
  [, , n] = await advancing(WIN);
  check('Escape opens the menu', d < 0 && n >= 1, `demo time ${d}, ${n} frames in ${WIN / 1000} s`);
  await shot('3-menu');

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  chrome.kill();
}
if (failed && consoleLog.length) console.log('page console (last lines):\n  ' + consoleLog.slice(-40).join('\n  '));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
