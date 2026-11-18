#!/usr/bin/env node
// Headless demo benchmark: launches Chrome (GPU on, muted, off-screen), opens
// <url>?bench=1 and waits for the in-page harness (port/web/bench.js) to report.
// No npm dependencies: DevTools protocol over Node's built-in WebSocket.
//
//   node tools/bench.mjs http://127.0.0.1:8092/serioussam.html [runs=3] [--software-gl] [--vsync]
//   node tools/bench.mjs http://127.0.0.1:8092/serioussam.html --shots <label>   (visual regression frames)
//
// --software-gl uses SwiftShader instead of the GPU: a rough "potato GPU" stand-in.
// --cpu-throttle <N> slows the page's CPU N times (DevTools CPU throttling, applies to workers
// too): with --software-gl --vsync, a rough "potato device" (e.g. --cpu-throttle 4).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const softwareGL = args.includes('--software-gl');
const capped = args.includes('--vsync');   // default: uncapped timedemo (fps = throughput)
// --shots <label>: instead of benchmarking, capture the visual-regression frames
// (port/data/SE1Mod/shots.ini, saved by tools/devserver.py under data/shots/<label>/)
const shotsIdx = args.indexOf('--shots');
const shotsLabel = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
const thrIdx = args.indexOf('--cpu-throttle');
const cpuThrottle = thrIdx >= 0 ? Number(args[thrIdx + 1]) : 0;
const pos = args.filter((a, i) => !a.startsWith('--') && !(shotsIdx >= 0 && i === shotsIdx + 1) && !(thrIdx >= 0 && i === thrIdx + 1));
const base = pos[0];
const runs = Number(pos[1] || 3);
if (!base) { console.error('usage: bench.mjs <url> [runs] [--software-gl]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(i) {
  const port = 9300 + i;
  const profile = mkdtempSync(join(tmpdir(), 'se1bench-'));
  const flags = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1024,768', '--no-first-run', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    softwareGL ? '--use-angle=swiftshader' : '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    'about:blank',
  ];
  const chrome = spawn(CHROME, flags, { stdio: 'ignore' });
  try {
    let ws;
    for (let t = 0; t < 50 && !ws; t++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((p) => p.type === 'page');
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
      } catch { await sleep(200); }
    }
    if (!ws) throw new Error('chrome did not start');
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

    const url = base + (base.includes('?') ? '&' : '?') +
      (shotsLabel ? `shots=${encodeURIComponent(shotsLabel)}&mute=1&uncapped=1` : `bench=1&uncapped=${capped ? 0 : 1}`) + `&run=${Date.now()}`;
    if (cpuThrottle > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    await send('Page.navigate', { url });
    const t0 = Date.now();
    if (shotsLabel) {
      while (Date.now() - t0 < 120000) {
        await sleep(500);
        if (await evaluate('window.__shotsDone === true')) return { shots: shotsLabel };
      }
      throw new Error('timed out waiting for shots');
    }
    while (Date.now() - t0 < 120000 * Math.max(1, cpuThrottle)) {
      await sleep(1000);
      const s = await evaluate("window.__bench && window.__bench.state === 'done' && JSON.stringify(window.__bench.stats)");
      if (s) return JSON.parse(s);
    }
    throw new Error('timed out waiting for benchmark (state: ' + (await evaluate('window.__bench && window.__bench.state')) + ')');
  } finally {
    chrome.kill();
  }
}

if (shotsLabel) {
  console.log(JSON.stringify(await runOnce(0)));
  process.exit(0);
}
const results = [];
for (let i = 0; i < runs; i++) {
  const r = await runOnce(i);
  results.push(r);
  const { profile, ...nums } = r;
  console.log(`run ${i + 1}: ${JSON.stringify(nums)}`);
  if (profile) {
    console.log(`  profile (${profile.busySamples} busy samples), self time:`);
    profile.self.forEach((l) => console.log('    ' + l));
    console.log('  inclusive:');
    profile.inclusive.forEach((l) => console.log('    ' + l));
  }
}
const med = (k) => { const v = results.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`median of ${runs}: fps ${med('fps')}  mean ${med('meanMs')} ms  p50 ${med('p50')}  p95 ${med('p95')}  p99 ${med('p99')}  max ${med('max')}  >16.7ms ${med('over16_7')}`);
