#!/usr/bin/env node
// Vertex-range A/B test for the gl1shim (port/common/gl1shim.c): the timedemo is run twice in
// the same build — once with the full-range client-array copy (?vrange=0) and once with the
// indexed-draw vertex range (the default) — and the vertex bytes copied by put_vertices are
// compared (Module._SE1_GL1Shim_VertexBytes()). Passes when the range build copies at least
// 10% fewer bytes.
//
//   node tools/vrangetest.mjs http://127.0.0.1:8430/serioussam.html
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const [url] = process.argv.slice(2);
if (!url) { console.error('usage: vrangetest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1vr-'))}`,
  '--window-size=1024,768', '--no-first-run', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ...gpuFlags(), ...EXTRA_FLAGS, 'about:blank'], { stdio: 'ignore' });
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
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');

  // one timedemo run; returns the vertex bytes copied during the demo
  const run = async (extra) => {
    const u = url + (url.includes('?') ? '&' : '?') + `bench=1&uncapped=1${extra ? '&' + extra : ''}&run=${Date.now()}`;
    await send('Page.navigate', { url: u });
    const t0 = Date.now();
    let stats;
    while (Date.now() - t0 < 120000 * TIMEOUT_SCALE) {
      await sleep(1000);
      stats = await ev("window.__bench && window.__bench.state === 'done' && JSON.stringify(window.__bench.stats)");
      if (stats) break;
    }
    if (!stats) throw new Error('timed out waiting for benchmark');
    const bytes = await ev('Module._SE1_GL1Shim_VertexBytes ? Module._SE1_GL1Shim_VertexBytes() : NaN');
    if (!Number.isFinite(bytes)) throw new Error('Module._SE1_GL1Shim_VertexBytes() missing');
    return { bytes, fps: JSON.parse(stats).fps };
  };

  const full = await run('vrange=0');
  const range = await run('');
  check('timedemo completes (both runs)', true, `fps ${full.fps} / ${range.fps}`);
  const mb = (b) => (b / (1 << 20)).toFixed(2);
  const pct = (1 - range.bytes / full.bytes) * 100;
  console.log(`full-range copy: ${mb(full.bytes)} MB (${full.bytes} B)`);
  console.log(`vertex-range copy: ${mb(range.bytes)} MB (${range.bytes} B)`);
  check('fewer vertex bytes', range.bytes < full.bytes && pct >= 10, `full ${mb(full.bytes)} MB -> range ${mb(range.bytes)} MB (${pct.toFixed(1)}%)`);
  ws.close();
} catch (e) {
  console.log('FAIL  harness  ' + e.message);
  failed++;
} finally {
  chrome.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
