#!/usr/bin/env node
// Monster stress test: how many enemies the engine handles at once. For each count it loads
// ?mode=survivors&svstress=N (rust/se1-mod/src/survivors.rs keeps N monsters alive around a god-mode
// player, no abilities), lets them close in, then reports the engine thread's CPU ms per frame
// (Module.se1Perf) and the main thread's replay ms (Module.se1Replay, threaded build).
//
//   node tools/stress.mjs http://127.0.0.1:8094/serioussam.html [counts=50,100,200,400] [kind=0]
//   kind: 0 Headman, 1 Boneman, 2 Eyeman, 3 Scorpman, 4 Werebull
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const [url, countsArg = '50,100,200,400', kind = '0'] = process.argv.slice(2);
if (!url) { console.error('usage: stress.mjs <url> [counts] [kind]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(n) {
  const port = 9850 + Math.floor(Math.random() * 50);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1st-'))}`,
    '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let ws;
    for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
      try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
      catch { await sleep(200); }
    }
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { const k = ++id; pend.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
    const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
    await send('Page.navigate', { url: `${url}${url.includes('?') ? '&' : '?'}mute=1&mode=survivors&svstress=${n}&svkind=${kind}` });
    let alive = 0;
    for (let t = 0; t < 240 && alive < n; t++) { await sleep(500); alive = (await ev('Module.se1SurvivorsLast ? Module.se1SurvivorsLast.alive : 0')) || 0; }
    await sleep(8000 * TIMEOUT_SCALE);   // let them close in
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    writeFileSync(join(tmpdir(), `se1-stress-${n}.jpg`), Buffer.from(shot.result.data, 'base64'));
    const r = JSON.parse(await ev(`(async () => {
      const P = Module.se1Perf, R = Module.se1Replay, n0 = P.n, r0 = R ? R.n : 0, t0 = performance.now();
      await new Promise((ok) => setTimeout(ok, 5000));
      const n1 = P.n, r1 = R ? R.n : 0, secs = (performance.now() - t0) / 1000;
      const pick = (arr, a, b) => Array.from(arr.slice(a % 65536, b % 65536)).sort((x, y) => x - y);
      const w = pick(P.work, n0, n1), rp = R ? pick(R.ms, r0, r1) : [];
      const q = (a, p) => a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null;
      return JSON.stringify({ alive: Module.se1SurvivorsLast && Module.se1SurvivorsLast.alive, fps: +((n1 - n0) / secs).toFixed(1),
        work50: q(w, .5), work95: q(w, .95), replay50: q(rp, .5), replay95: q(rp, .95) });
    })()`));
    return r;
  } finally { chrome.kill(); }
}

for (const n of countsArg.split(',').map(Number)) {
  const r = await run(n);
  console.log(`${String(n).padStart(4)} monsters: alive ${r.alive}, ${r.fps} fps, engine ms p50 ${r.work50} p95 ${r.work95}, render replay ms p50 ${r.replay50} p95 ${r.replay95}`);
}
