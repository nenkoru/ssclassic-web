#!/usr/bin/env node
// Projectile credit test (API v6): verifies that projectile hits are credited to the
// gun that fired them, not the gun held when the hit lands.
// Opens a Survivors run with RocketLauncher + Shotgun at rank 5, fires rockets for 4 s,
// switches to the shotgun, waits 3 s (rockets land during this window), and checks that
// the damage hook log credits the hits to RocketLauncher, not Shotgun.
//
//   node tools/projtest.mjs http://127.0.0.1:8410/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-proj')] = process.argv.slice(2);
if (!url) { console.error('usage: projtest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9800 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1proj-')}`,
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
    // hold the key for a few frames: a press shorter than an engine frame can be missed
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await sleep(120);
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
  // RocketLauncher is ALL[6] → bit 6 → 64; Shotgun is ALL[2] → bit 2 → 4; mask = 68
  // rank 5; 25 stress monsters; god mode
  const q = 'mute=1&mode=survivors&svauto=1&svgod=1&svtime=120&svgive=68&svrank=5';
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

  // select the rocket launcher (key 5 in TFE; svgive gave it at rank 5)
  // select the rocket launcher and wait until it is in hand (the HUD reports the weapon type; 8)
  const held = () => ev('Module.se1SurvivorsLast ? Module.se1SurvivorsLast.weapon : -1');
  // wheel down = next weapon (the default controls); cycle until the rocket launcher is in hand
  for (let i = 0; i < 12 && await held() !== 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 550, y: 500, deltaX: 0, deltaY: 100 });
    await sleep(700);
  }
  console.log('info: weapon in hand ' + await held() + ' (8 = rocket launcher)');
  await sleep(1000);

  // fire rockets for 4 s while sweeping the view (SE1_TouchLook)
  // so the rockets hit the stress monsters in front of the player
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 550, y: 500, button: 'left', clickCount: 1 });
  for (let i = 0; i < 40; i++) {
    const dir = Math.floor(i / 10) % 2 === 0 ? 1 : -1;
    await ev(`Module._SE1_TouchLook && Module._SE1_TouchLook(${dir * 12}, 0); 1`);
    await sleep(100);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 550, y: 500, button: 'left', clickCount: 1 });

  // immediately switch to the shotgun (key 3) and keep NOT firing for 3 s
  // rockets in flight land during this window; they must be credited to the rocket launcher
  await key('3', 'Digit3', 51, '3');
  await sleep(3000);

  // wait for the next 5 s log line
  await sleep(6000);

  // parse the damage hook log lines for per-gun counts
  const hookLines = logs.filter((l) => l.includes('damage hook:'));
  check('hook log line present', hookLines.length > 0, `found ${hookLines.length} line(s)`);

  let rocketHits = 0, shotgunHits = 0;
  for (const l of hookLines) {
    const m = l.match(/by gun: (.+)/);
    if (m) {
      const parts = m[1].split(', ');
      for (const p of parts) {
        const gm = p.match(/^(.+) (\d+)$/);
        if (gm) {
          if (gm[1] === 'Rocket Launcher') rocketHits += +gm[2];
          if (gm[1] === 'Pump Shotgun') shotgunHits += +gm[2];
        }
      }
    }
  }

  check('rockets credited to the rocket launcher', rocketHits > 0, `RocketLauncher count ${rocketHits}`);
  check('nothing credited to the shotgun', shotgunHits === 0, `Shotgun count ${shotgunHits}`);
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
