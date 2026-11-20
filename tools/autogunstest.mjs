#!/usr/bin/env node
// Auto-guns test (rust/se1-mod/src/survivors/mod.rs auto_guns + data.rs AUTO_GUNS).
// Loads ?mode=survivors&svauto=1&svgod=1&mute=1&svgive=511&svrank=3&svring=12 with no input:
// every gun fires on its own, so every gun the run owns (the HUD's guns: all 9, or 8 on the demo
// data, which has no Cannon) must have damage > 0. svring keeps monsters in sight: the guns only
// shoot what the player can see, and the run starts indoors with the monsters behind walls.
// Then the same run with &svautofire=0: nothing fires, so no gun has damage.
//
//   node tools/autogunstest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-autogun')] = process.argv.slice(2);
if (!url) { console.error('usage: autogunstest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9950 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1ag-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

const GUN_NAMES = ['Knife', 'Schofield Revolver', 'Pump Shotgun', 'Double Coach Gun', 'Tommy Gun', 'XM214 Minigun', 'Rocket Launcher', 'XL2 Laser', 'SBC Cannon'];

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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });

  // auto guns on: all guns rank 3, no input, every owned gun must deal damage
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mode=survivors&svauto=1&svgod=1&mute=1&svgive=511&svrank=3&svring=12' });
  let m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.time > 40); t++) { await sleep(500); m = await last(); }
  const dmgMap = {};
  if (m && m.dmg) for (const [n, v] of m.dmg) dmgMap[n] = v;
  const owned = (m?.guns || []).map((g) => g.name).filter((n) => GUN_NAMES.includes(n));
  const fired = owned.filter((n) => (dmgMap[n] || 0) > 0);
  const detail = owned.map((n) => `${n}:${Math.round(dmgMap[n] || 0)}`).join(' ');
  check('all guns fire', owned.length >= 8 && fired.length === owned.length, `${fired.length}/${owned.length} owned guns fired. ${detail}`);

  // auto guns off: same run, no gun deals damage
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mode=survivors&svauto=1&svgod=1&mute=1&svgive=511&svrank=3&svring=12&svautofire=0' });
  m = null;
  for (let t = 0; t < 100 * TIMEOUT_SCALE && !(m && m.time > 25); t++) { await sleep(500); m = await last(); }
  const dmgMap2 = {};
  if (m && m.dmg) for (const [n, v] of m.dmg) dmgMap2[n] = v;
  const fired2 = GUN_NAMES.filter((n) => (dmgMap2[n] || 0) > 0);
  check('off by option', fired2.length === 0, fired2.length ? `still fired: ${fired2.join(', ')}` : `time ${m?.time}, no gun damage`);

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
