#!/usr/bin/env node
// Headless demo benchmark: launches Chrome (GPU on, muted, off-screen), opens
// <url>?bench=1 and waits for the in-page harness (port/web/bench.js) to report.
// No npm dependencies: DevTools protocol over Node's built-in WebSocket.
//
//   node tools/bench.mjs http://127.0.0.1:8092/serioussam.html [runs=3] [--software-gl] [--vsync]
//   node tools/bench.mjs http://127.0.0.1:8092/serioussam.html --shots <label>   (visual regression frames)
//
// --software-gl uses SwiftShader instead of the GPU: a rough "potato GPU" stand-in.
// --android runs on Chrome on an Android phone over adb (USB, or Wi-Fi after `adb tcpip 5555` +
// `adb connect <ip>`): DevTools is forwarded with `adb forward`, and the page's port is mapped back
// to this Mac with `adb reverse`, so the phone loads http://127.0.0.1:<port> (a secure context).
// Set ADB_SERIAL to pick a device when several are attached.
// --cpu-throttle <N> slows the page's CPU N times (DevTools CPU throttling, applies to workers
// too): with --software-gl --vsync, a rough "potato device" (e.g. --cpu-throttle 4).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const softwareGL = args.includes('--software-gl');
const android = args.includes('--android');
const ADB = process.env.ADB || 'adb';
const adb = (...a) => execFileSync(ADB, [...(process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : []), ...a], { encoding: 'utf8' }).trim();
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

// Android: one DevTools forward for the whole session, the page port mapped back to this Mac
const ANDROID_PORT = 9222;
let androidInfo = null;
if (android) {
  adb('forward', `tcp:${ANDROID_PORT}`, 'localabstract:chrome_devtools_remote');
  const pagePort = new URL(base).port || '80';
  adb('reverse', `tcp:${pagePort}`, `tcp:${pagePort}`);
  let ver = {};
  try { ver = await (await fetch(`http://127.0.0.1:${ANDROID_PORT}/json/version`)).json(); } catch {
    console.error('Chrome DevTools not reachable on the phone: is Chrome open, and USB debugging allowed?'); process.exit(1);
  }
  androidInfo = { device: adb('shell', 'getprop', 'ro.product.model'), android: adb('shell', 'getprop', 'ro.build.version.release'), chrome: ver.Browser };
  console.log('android: ' + JSON.stringify(androidInfo));
}

// open a fresh tab on the phone's Chrome; returns its WebSocket and a cleanup function
async function openAndroidTab() {
  const t = await (await fetch(`http://127.0.0.1:${ANDROID_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  return { ws, close: () => fetch(`http://127.0.0.1:${ANDROID_PORT}/json/close/${t.id}`).catch(() => {}) };
}

async function runOnce(i) {
  if (android) {
    const tab = await openAndroidTab();
    try { return await drive(tab.ws); } finally { await tab.close(); }
  }
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
    return await drive(ws);
  } finally {
    chrome.kill();
  }
}

async function drive(ws) {
  try {
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
    ws.close();
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
