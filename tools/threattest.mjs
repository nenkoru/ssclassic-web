#!/usr/bin/env node
// Threat warnings test: verifies that enemies behind the player produce edge markers
// (threats) and that damage from behind produces a hit-direction glow (hurt).
//
//   node tools/threattest.mjs http://127.0.0.1:8360/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-threat')] = process.argv.slice(2);
if (!url) { console.error('usage: threattest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9850 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1thr-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') { const desc = d.params.exceptionDetails.exception?.description || ''; if (!desc.includes('pointer lock')) errors.push(desc.split('\n')[0]); }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const last = async () => JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsLast || null)')) || 'null');

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // headless Chrome has no real pointer lock: stub it as tools/damagetest.mjs does
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { let el = null;
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get() { return el; }, configurable: true });
    Element.prototype.requestPointerLock = function () { if (el !== this) { el = this; document.dispatchEvent(new Event('pointerlockchange')); } return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () { if (el) { el = null; document.dispatchEvent(new Event('pointerlockchange')); } };
  })();` });

  // Test 1: svbehind=2 (Beheaded Rocketeer, ranged) behind the player
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svbehind=2' });

  // wait for the game to boot and the run to start
  let m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.state === 'run'); t++) {
    await sleep(500);
    m = await last();
  }
  if (!(m && m.state === 'run')) throw new Error('game did not boot to run state');

  // within 60 s of play, look for a threats entry with |a| >= 135 and d in [6, 20]
  let threat = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE; t++) {
    await sleep(500);
    m = await last();
    if (m && Array.isArray(m.threats)) {
      threat = m.threats.find((x) => Math.abs(x.a) >= 135 && x.d >= 6 && x.d <= 20);
      if (threat) break;
    }
  }
  check('threat behind', !!threat, threat ? JSON.stringify(threat) : 'no threats entry with |a|>=135, d in [6,20]');

  // at the same time, the DOM has at least one visible .threat element
  const nThreats = await ev('document.querySelectorAll("#svv .threat").length');
  check('threat marker', nThreats >= 1, `${nThreats} .threat element(s)`);

  // within 40 s more, look for a non-null hurt with |a| >= 100
  let hurt = null;
  for (let t = 0; t < 80 * TIMEOUT_SCALE; t++) {
    await sleep(500);
    m = await last();
    if (m && m.hurt && Math.abs(m.hurt.a) >= 100) { hurt = m.hurt; break; }
  }
  check('hurt direction', !!hurt, hurt ? JSON.stringify(hurt) : 'no hurt with |a|>=100');

  // right after, a .hurt element with computed opacity > 0
  const hurtOp = await ev('(function(){var e=document.querySelector("#svv .hurt");return e?getComputedStyle(e).opacity:"0"})()');
  check('hurt glow', parseFloat(hurtOp) > 0, `opacity ${hurtOp}`);

  // Test 2: svthreats=0 hides both
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svbehind=2&svthreats=0' });
  m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.state === 'run'); t++) {
    await sleep(500);
    m = await last();
  }
  // wait for the same duration as test 1's threat wait
  for (let t = 0; t < 120 * TIMEOUT_SCALE; t++) { await sleep(500); m = await last(); }
  const nHidden = await ev('document.querySelectorAll("#svv .threat, #svv .hurt").length');
  const hurtOp2 = await ev('(function(){var e=document.querySelector("#svv .hurt");return e?getComputedStyle(e).opacity:"0"})()');
  check('can be turned off', nHidden === 0 || parseFloat(hurtOp2) === 0, `${nHidden} elements, hurt opacity ${hurtOp2}`);

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
