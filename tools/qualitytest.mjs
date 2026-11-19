#!/usr/bin/env node
// Automatic quality controller test (?quality=auto, rust/se1-mod/src/quality.rs).
// Checks:
//   1. off by default: no `quality:` console lines without ?quality=auto
//   2. lowers under load: with ?quality=auto + CPU throttling, a `quality: level 1` line appears
//   3. restores when fast: after removing throttling, a lower level appears
//   4. no exceptions
//
//   node tools/qualitytest.mjs http://127.0.0.1:8330/serioussam.html
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: qualitytest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9900 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1qt-')}`,
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
  let id = 0; const pend = new Map(); const errors = []; const consoleLines = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled') {
      const args = (d.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push(args);
    }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const until = async (pred, ms) => { for (let t = 0; t < ms / 500; t++) { if (pred()) return true; await sleep(500); } return pred(); };

  await send('Runtime.enable'); await send('Page.enable');

  // --- Check 1: off by default ---
  const baseUrl = url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svstress=150';
  await send('Page.navigate', { url: baseUrl });
  // wait for the game to be in play (frames advancing)
  let inPlay = false;
  for (let t = 0; t < 120 * TIMEOUT_SCALE; t++) {
    const frames = await ev('Module.se1Perf ? Module.se1Perf.n : 0');
    if (frames > 100) { inPlay = true; break; }
    await sleep(1000);
  }
  if (!inPlay) throw new Error('game did not reach play state');
  // apply CPU throttling for 20 s
  await send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await sleep(20000 * TIMEOUT_SCALE);
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const qualityLines1 = consoleLines.filter((l) => l.includes('quality:'));
  check('off by default', qualityLines1.length === 0, qualityLines1.length ? `found ${qualityLines1.length} quality lines: ${qualityLines1.slice(0, 3).join(' | ')}` : 'no quality lines');

  // --- Check 2: lowers under load ---
  consoleLines.length = 0;
  const autoUrl = baseUrl + '&quality=auto';
  await send('Page.navigate', { url: autoUrl });
  // wait for budget detection
  let budgetSeen = false;
  for (let t = 0; t < 120 * TIMEOUT_SCALE; t++) {
    if (consoleLines.some((l) => l.includes('quality: budget'))) { budgetSeen = true; break; }
    await sleep(500);
  }
  if (!budgetSeen) throw new Error('quality: budget line never appeared');
  // apply CPU throttling
  await send('Emulation.setCPUThrottlingRate', { rate: 80 });
  let levelLine = '';
  for (let t = 0; t < 90 * TIMEOUT_SCALE; t++) {
    const found = consoleLines.find((l) => l.includes('quality: level'));
    if (found) { levelLine = found; break; }
    await sleep(500);
  }
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const levelMatch = levelLine.match(/quality: level (\d+)/);
  check('lowers under load', levelMatch !== null && parseInt(levelMatch[1]) >= 1, levelLine || 'no quality: level line within 45 s');

  // --- Check 3: restores when fast ---
  consoleLines.length = 0;
  const highestLevel = levelMatch ? parseInt(levelMatch[1]) : 0;
  let restoreLine = '';
  for (let t = 0; t < 180 * TIMEOUT_SCALE; t++) {
    const found = consoleLines.find((l) => {
      const m = l.match(/quality: level (\d+)/);
      return m && parseInt(m[1]) < highestLevel;
    });
    if (found) { restoreLine = found; break; }
    await sleep(500);
  }
  const restoreMatch = restoreLine.match(/quality: level (\d+)/);
  check('restores when fast', restoreMatch !== null && parseInt(restoreMatch[1]) < highestLevel, restoreLine || `no lower level than ${highestLevel} within 90 s`);

  // --- Check 4: no exceptions ---
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
