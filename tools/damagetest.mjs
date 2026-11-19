#!/usr/bin/env node
// Damage hook test (API v5): verifies the engine→mod damage hook works end-to-end.
// Opens a Survivors run with a minigun at rank 5, fires at svstress monsters, and checks
// that the damage hook sees player damage, scales it by the rank multiplier, and logs
// the counters.
//
//   node tools/damagetest.mjs http://127.0.0.1:8360/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-damage')] = process.argv.slice(2);
if (!url) { console.error('usage: damagetest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9800 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1dmg-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'log') {
      const txt = (d.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push(txt);
    }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const click = async (x = 550, y = 500) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async (k, code, vk, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // headless Chrome has no real pointer lock: stub it as tools/inputtest.mjs does (lock on request)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { let el = null;
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get() { return el; }, configurable: true });
    Element.prototype.requestPointerLock = function () { if (el !== this) { el = this; document.dispatchEvent(new Event('pointerlockchange')); } return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () { if (el) { el = null; document.dispatchEvent(new Event('pointerlockchange')); } };
  })();` });
  // minigun is ALL[5] → bit 5 → mask 32; rank 5; 25 stress monsters; god mode
  const q = 'mute=1&mode=survivors&svauto=1&svgod=1&svstress=25&svgive=32&svrank=5';
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + q });

  // wait for the game to boot and the run to start
  for (let t = 0; t < 120 * TIMEOUT_SCALE; t++) {
    const f = await ev('Module.se1Perf ? Module.se1Perf.n : -1');
    if (f > 100) break;
    await sleep(500);
  }
  await sleep(3000); // let monsters spawn and the run settle

  // capture the mouse
  await click();
  await sleep(500);

  // select the tommy gun / minigun (key 4 in TFE; svgive gave the minigun at rank 5)
  await key('4', 'Digit4', 52, '4');
  await sleep(800);

  // hold fire for 8 s while sweeping the view left and right (SE1_TouchLook, the touch look input)
  // so the bullets cross the stress monsters standing in front of the player
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 550, y: 500, button: 'left', clickCount: 1 });
  for (let i = 0; i < 80; i++) {
    const dir = Math.floor(i / 20) % 2 === 0 ? 1 : -1;
    await ev(`Module._SE1_TouchLook && Module._SE1_TouchLook(${dir * 12}, 0); 1`);
    await sleep(100);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 550, y: 500, button: 'left', clickCount: 1 });

  // wait for the next 5 s log line
  await sleep(6000);

  // check the console log for the damage hook line
  const hookLines = logs.filter((l) => l.includes('damage hook:'));
  check('hook log line present', hookLines.length > 0, `found ${hookLines.length} line(s): ${hookLines.slice(0, 2).join(' | ')}`);

  let fromPlayer = 0, scaled = 0;
  for (const l of hookLines) {
    const m = l.match(/damage hook: (\d+) calls, (\d+) from player, (\d+) scaled/);
    if (m) { fromPlayer += +m[2]; scaled += +m[3]; }
  }
  check('hook sees player damage', fromPlayer > 0, `from_player total ${fromPlayer}`);
  check('rank bonus scales hits', scaled > 0, `scaled ${scaled}`);
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
