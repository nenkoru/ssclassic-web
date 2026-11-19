#!/usr/bin/env node
// Touch controls test (port/web/touch.js): move stick, look drag, Fire/Jump/Weapon/Menu buttons,
// shown only while in play. Headless Chrome with touch emulation; the page runs with ?touch=1.
//   node tools/touchtest.mjs http://127.0.0.1:8300/serioussam.html
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-touch')] = process.argv.slice(2);
if (!url) { console.error('usage: touchtest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9850 + Math.floor(Math.random() * 49);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1touch-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// record every keydown/keyup code on window, in order
const SPY = `(() => {
  window.__keys = [];
  addEventListener('keydown', (e) => { __keys.push(['down', e.code]); }, true);
  addEventListener('keyup', (e) => { __keys.push(['up', e.code]); }, true);
})();`;

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
  const st = async () => JSON.parse(await ev(`JSON.stringify({
    want: Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : -1,
    shown: !!document.getElementById('touch') && getComputedStyle(document.getElementById('touch')).display !== 'none',
    buttons: ['t-fire','t-jump','t-weapon','t-menu'].every((i) => !!document.getElementById(i)),
    keys: window.__keys || [],
    hud: Module.se1SurvivorsLast || null })`));
  const touch = async (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const down = (x, y, i = 0) => touch('touchStart', [{ x, y, id: i }]);
  const move = (x, y, i = 0) => touch('touchMove', [{ x, y, id: i }]);
  const up = (x, y, i = 0) => touch('touchEnd', [{ x, y, id: i }]);
  const until = async (pred, ms) => { let s; for (let t = 0; t < ms / 250; t++) { s = await st(); if (pred(s)) return s; await sleep(250); } return s; };
  const keys = (s) => s.keys;
  const sawDown = (s, code) => s.keys.some((k) => k[0] === 'down' && k[1] === code);
  const sawUp = (s, code) => s.keys.some((k) => k[0] === 'up' && k[1] === code);
  const held = (s, code) => { let n = 0; for (const k of s.keys) { if (k[1] === code) n += k[0] === 'down' ? 1 : -1; } return n > 0; };
  const hud = async () => (await st()).hud;
  const posDist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  const yawDelta = (a, b) => { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&touch=1' });

  // 1. controls shown in play
  let s = await until((x) => x.want === 1, 90000 * TIMEOUT_SCALE);
  s = await until((x) => x.shown && x.buttons, 4000);
  check('controls shown in play', s.want === 1 && s.shown && s.buttons,
    `want ${s.want}, shown ${s.shown}, buttons ${s.buttons}`);

  // 2. stick holds W (record pos once the hud reports it, so step 3 compares real positions)
  let h0 = null;
  for (let t = 0; t < 40 && !h0; t++) { const h = await hud(); if (h && h.pos) h0 = h; else await sleep(250); }
  await down(200, 700);
  await move(200, 600);
  await sleep(300);
  s = await st();
  check('stick holds W', sawDown(s, 'KeyW') && held(s, 'KeyW'), `keys ${JSON.stringify(keys(s).slice(-6))}`);
  await sleep(1500);
  await up(200, 600);
  await sleep(300);
  s = await st();
  check('stick releases W', sawUp(s, 'KeyW') && !held(s, 'KeyW'), `keys ${JSON.stringify(keys(s).slice(-6))}`);

  // 3. stick moves the player
  const h1 = await hud();
  check('stick moves the player', h0 && h1 && h0.pos && h1.pos && posDist(h0.pos, h1.pos) > 1.0,
    `pos ${JSON.stringify(h0 && h0.pos)} -> ${JSON.stringify(h1 && h1.pos)}`);

  // 4. drag looks around
  const y0 = (await hud()).yaw;
  await down(800, 500);
  for (let x = 820; x <= 1000; x += 20) { await move(x, 500); await sleep(30); }
  await up(1000, 500);
  await sleep(500);
  const y1 = (await hud()).yaw;
  check('drag looks around', y0 != null && y1 != null && yawDelta(y0, y1) > 20, `yaw ${y0} -> ${y1}`);

  // 5. two fingers at once: stick (W) held while a look drag happens on the right
  const y2 = (await hud()).yaw;
  await down(200, 700, 0);
  await move(200, 600, 0);
  await sleep(200);
  await down(800, 500, 1);
  for (let x = 820; x <= 1000; x += 20) { await move(x, 500, 1); await sleep(30); }
  s = await st();
  const wHeldDuringDrag = held(s, 'KeyW');
  await up(1000, 500, 1);
  await up(200, 600, 0);
  await sleep(500);
  const y3 = (await hud()).yaw;
  check('two fingers at once', wHeldDuringDrag && yawDelta(y2, y3) > 20,
    `W held during drag ${wHeldDuringDrag}, yaw ${y2} -> ${y3}`);

  // 6. menu hides the controls, releases everything
  const menu = JSON.parse(await ev("JSON.stringify((r => [r.x + r.width / 2, r.y + r.height / 2])(document.getElementById('t-menu').getBoundingClientRect()))"));
  await down(menu[0], menu[1]);
  await sleep(100);
  await up(menu[0], menu[1]);
  s = await until((x) => x.want === 0 && !x.shown, 3000);
  const netHeld = {};
  for (const k of keys(s)) netHeld[k[1]] = (netHeld[k[1]] || 0) + (k[0] === 'down' ? 1 : -1);
  const nothingHeld = Object.values(netHeld).every((n) => n === 0);
  check('menu hides the controls', s.want === 0 && !s.shown && nothingHeld,
    `want ${s.want}, shown ${s.shown}, netHeld ${JSON.stringify(netHeld)}`);

  // 7. no exceptions
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
