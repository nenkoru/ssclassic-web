#!/usr/bin/env node
// Time-to-menu: how long the game page takes from navigation until the engine draws frames,
// cold (the origin's storage and the HTTP cache cleared first) and warm (a reload right after),
// plus the bytes downloaded and Module.se1LazyStats() when the build has lazy data.
//
//   node tools/menutime.mjs <url> [--runs N] [--throttle MBIT] [--latency MS] [--json out.json] [--check-lazy]
//
// Defaults: runs 1, no throttle, latency 20 ms (only used with --throttle).
// Exits 1 if any load timed out or a page exception was thrown, else 0.
// --check-lazy (the test in tools/test.sh) also fails unless the build has lazy data, the cold
// load fetched chunks without errors and the warm load read every chunk from OPFS.
//
// Headless Chrome has no real window: pointer lock is stubbed as granted (otherwise the request
// throws inside the engine's call stack and stops it, which real browsers don't do).
// Chrome binary, ANGLE backend, extra flags and timeout scaling come from the environment
// (CHROME, SE1_ANGLE, SE1_CHROME_FLAGS, SE1_TIMEOUT_SCALE: see tools/chrome.mjs).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const args = process.argv.slice(2);
const flags = { runs: 1, throttle: null, latency: 20, json: null, checkLazy: false };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--runs') flags.runs = Math.max(1, parseInt(args[++i], 10));
  else if (a === '--throttle') flags.throttle = parseFloat(args[++i]);
  else if (a === '--latency') flags.latency = parseInt(args[++i], 10);
  else if (a === '--json') flags.json = args[++i];
  else if (a === '--check-lazy') flags.checkLazy = true;
  else pos.push(a);
}
const url = pos[0];
if (!url) {
  console.error('usage: menutime.mjs <url> [--runs N] [--throttle MBIT] [--latency MS] [--json out.json] [--check-lazy]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + Math.floor(Math.random() * 50);
const profile = tempProfile('se1menu-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...gpuFlags(), ...EXTRA_FLAGS,
  '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const navUrl = url + (url.includes('?') ? '&' : '?') + 'mute=1';
const TIMEOUT = 240 * 1000 * TIMEOUT_SCALE;
let exitCode = 0;

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = l.find((x) => x.type === 'page');
      if (p) ws = new WebSocket(p.webSocketDebuggerUrl);
      else await sleep(200);
    } catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  let bytes = 0;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.method === 'Network.loadingFinished') bytes += d.params.encodedDataLength || 0;
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  if (flags.throttle != null) {
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: flags.latency,
      downloadThroughput: flags.throttle * 1e6 / 8,
      uploadThroughput: flags.throttle * 1e6 / 8,
    });
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });

  const load = async (cold) => {
    // cold: forget everything the origin stored (OPFS lazy-data cache, HTTP cache, IndexedDB)
    if (cold) {
      await send('Network.clearBrowserCache');
      await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
    }
    const before = await ev('performance.timeOrigin');
    bytes = 0;
    const t0 = performance.now();
    await send('Page.navigate', { url: navUrl });
    let firstFrame = null, ready = null;
    for (let t = 0; t < TIMEOUT / 100; t++) {
      await sleep(100);
      if ((await ev('performance.timeOrigin')) === before) continue;   // still the old page
      const n = await ev('typeof Module !== "undefined" && Module.se1Perf ? Module.se1Perf.n : -1');
      if (n >= 1 && firstFrame == null) firstFrame = performance.now() - t0;
      if (n >= 60 && ready == null) { ready = performance.now() - t0; break; }
    }
    if (ready == null) return { firstFrame, ready: null, bytes: null, lazy: null, jsHeap: 0, failed: true };
    const b = bytes;
    let lazy = null;
    const lj = await ev('JSON.stringify(typeof Module !== "undefined" && Module.se1LazyStats ? Module.se1LazyStats() : null)');
    if (lj) { try { lazy = JSON.parse(lj); } catch { lazy = null; } }
    const jsHeap = await ev('performance.memory ? performance.memory.usedJSHeapSize : 0') || 0;
    return { firstFrame, ready, bytes: b, lazy, jsHeap, failed: false };
  };

  const runs = [];
  for (let i = 1; i <= flags.runs; i++) {
    const cold = await load(true);
    const warm = await load(false);
    runs.push({ cold, warm });
    const fmt = (ms) => ms == null ? 'null' : (ms / 1000).toFixed(2) + ' s';
    const fmtMB = (b) => b == null ? 'null' : (b / 1e6).toFixed(1) + ' MB';
    console.log(`run ${i} cold: first frame ${fmt(cold.firstFrame)}, 60 frames ${fmt(cold.ready)}, ${fmtMB(cold.bytes)} downloaded`);
    if (cold.lazy) console.log(`  lazy: ${JSON.stringify(cold.lazy)}`);
    console.log(`run ${i} warm: first frame ${fmt(warm.firstFrame)}, 60 frames ${fmt(warm.ready)}, ${fmtMB(warm.bytes)} downloaded`);
    if (warm.lazy) console.log(`  lazy: ${JSON.stringify(warm.lazy)}`);
  }

  const median = (arr) => {
    const v = arr.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const medCold = {
    firstFrame: median(runs.map((r) => r.cold.firstFrame)),
    ready: median(runs.map((r) => r.cold.ready)),
    bytes: median(runs.map((r) => r.cold.bytes)),
  };
  const medWarm = {
    firstFrame: median(runs.map((r) => r.warm.firstFrame)),
    ready: median(runs.map((r) => r.warm.ready)),
    bytes: median(runs.map((r) => r.warm.bytes)),
  };
  const fmtS = (ms) => ms == null ? 'null' : (ms / 1000).toFixed(2) + ' s';
  const fmtMB = (b) => b == null ? 'null' : (b / 1e6).toFixed(1) + ' MB';
  console.log(`median cold: first frame ${fmtS(medCold.firstFrame)}, 60 frames ${fmtS(medCold.ready)}, ${fmtMB(medCold.bytes)}`);
  console.log(`median warm: first frame ${fmtS(medWarm.firstFrame)}, 60 frames ${fmtS(medWarm.ready)}, ${fmtMB(medWarm.bytes)}`);

  if (flags.json) {
    writeFileSync(flags.json, JSON.stringify({
      url,
      throttle: flags.throttle,
      latency: flags.throttle != null ? flags.latency : null,
      runs: runs.map((r) => ({
        cold: { firstFrame: r.cold.firstFrame != null ? r.cold.firstFrame / 1000 : null, ready: r.cold.ready != null ? r.cold.ready / 1000 : null, bytes: r.cold.bytes, lazy: r.cold.lazy, jsHeap: r.cold.jsHeap },
        warm: { firstFrame: r.warm.firstFrame != null ? r.warm.firstFrame / 1000 : null, ready: r.warm.ready != null ? r.warm.ready / 1000 : null, bytes: r.warm.bytes, lazy: r.warm.lazy, jsHeap: r.warm.jsHeap },
      })),
      median: {
        cold: { firstFrame: medCold.firstFrame != null ? medCold.firstFrame / 1000 : null, ready: medCold.ready != null ? medCold.ready / 1000 : null, bytes: medCold.bytes },
        warm: { firstFrame: medWarm.firstFrame != null ? medWarm.firstFrame / 1000 : null, ready: medWarm.ready != null ? medWarm.ready / 1000 : null, bytes: medWarm.bytes },
      },
    }, null, 2));
  }

  const anyTimeout = runs.some((r) => r.cold.failed || r.warm.failed);
  if (anyTimeout || errors.length) {
    if (errors.length) console.log('page exceptions: ' + errors.slice(0, 2).join(' | '));
    exitCode = 1;
  }
  if (flags.checkLazy) {
    const bad = [];
    for (const r of runs) {
      const c = r.cold.lazy, w = r.warm.lazy;
      if (!c || !w) { bad.push('no Module.se1LazyStats (built without SE1_LAZY_DATA?)'); continue; }
      if (!c.requests || !c.netRequests) bad.push(`cold load fetched nothing (${c.requests} requests)`);
      if (c.errors || w.errors) bad.push(`read errors: cold ${c.errors}, warm ${w.errors}`);
      if (!w.cache) bad.push('no OPFS cache');
      else if (w.netRequests) bad.push(`warm load went to the network ${w.netRequests} times`);
    }
    if (bad.length) { console.log('FAIL lazy data: ' + [...new Set(bad)].join('; ')); exitCode = 1; }
    else console.log('PASS lazy data: chunks fetched cold, all from OPFS warm, no errors');
  }
} finally {
  await closeChrome(chrome, profile);
}
process.exit(exitCode);
