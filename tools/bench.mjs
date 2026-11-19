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
// --android-cores <hexmask> (rooted phones): pin Chrome's renderer and GPU processes to those CPU
// cores, e.g. 3f = the six little cores of a Snapdragon 710: a rough budget-phone stand-in. (DevTools
// CPU throttling on Android slows only the page's main thread, not the engine worker.) The pinning
// ends when Chrome restarts.
// --android-cap <kHz> (rooted phones): cap every CPU frequency domain (the whole phone) to the
// highest available frequency <= kHz for the run; each domain is set back to its hardware maximum on
// exit, also when the run fails.
// --cpu-throttle <N> slows the page's CPU N times (DevTools CPU throttling, applies to workers
// too): with --software-gl --vsync, a rough "potato device" (e.g. --cpu-throttle 4).
// Chrome binary, ANGLE backend, extra flags and timeout scaling come from the environment (CHROME,
// SE1_ANGLE, SE1_CHROME_FLAGS, SE1_TIMEOUT_SCALE: see tools/chrome.mjs). On failure the page's last
// console lines are printed to stderr.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

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
const capIdx = args.indexOf('--android-cap');
const androidCap = capIdx >= 0 ? Number(args[capIdx + 1]) : 0;
const coresIdx = args.indexOf('--android-cores');
const androidCores = coresIdx >= 0 ? args[coresIdx + 1] : null;
const pos = args.filter((a, i) => !a.startsWith('--') && !(shotsIdx >= 0 && i === shotsIdx + 1) && !(thrIdx >= 0 && i === thrIdx + 1) && !(coresIdx >= 0 && i === coresIdx + 1) && !(capIdx >= 0 && i === capIdx + 1));
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
  // keep the screen on (Chrome hides and pauses the page when it goes off) without changing any
  // device setting: WAKEUP turns a dozing screen back on, and a no-op key (KEYCODE_UNKNOWN) counts
  // as user activity, which resets the screen-off timer (WAKEUP alone doesn't when already awake)
  const keepAwake = () => { try { adb('shell', 'input keyevent KEYCODE_WAKEUP; input keyevent KEYCODE_UNKNOWN'); } catch {} };
  keepAwake();
  setInterval(keepAwake, 10000).unref();
  if (androidCap) {
    const P = '/sys/devices/system/cpu/cpufreq';
    // per policy: highest available frequency <= cap (or its lowest), applied as scaling_max_freq
    const cmd = `for d in ${P}/policy*; do f=$(for x in $(cat $d/scaling_available_frequencies); do [ $x -le ${androidCap} ] && echo $x; done | tail -1); ` +
                `[ -z "$f" ] && f=$(cat $d/scaling_available_frequencies | cut -d" " -f1); echo $f > $d/scaling_max_freq; echo $(basename $d)=$(cat $d/scaling_max_freq); done`;
    androidInfo.cap = adb('shell', `su -c '${cmd}'`).split(/\s+/).join(' ');
    const restore = () => { try { adb('shell', `su -c 'for d in ${P}/policy*; do cat $d/cpuinfo_max_freq > $d/scaling_max_freq; done'`); } catch {} };
    process.on('exit', restore);
    process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143));
  }
  if (androidCores) {   // pin every Chrome renderer + GPU process (all threads) to the given cores
    const pin = () => {
      try {
        adb('shell', `su -c 'for p in $(pidof com.android.chrome:privileged_process0) $(ps -A -o PID,NAME | grep sandboxed_process | cut -c1-6); do taskset -ap ${androidCores} $p >/dev/null 2>&1; done'`);
      } catch {}
    };
    pin(); setInterval(pin, 2000).unref();
    androidInfo.cores = androidCores;
    // the pinning would outlive this run (until Chrome restarts): give all cores back on exit
    process.on('exit', () => { try {
      adb('shell', `su -c 'for p in $(pidof com.android.chrome:privileged_process0) $(ps -A -o PID,NAME | grep sandboxed_process | cut -c1-6); do taskset -ap ff $p >/dev/null 2>&1; done'`);
    } catch {} });
    process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143));
  }
  // Chrome in front (its last tab; the benchmark brings its own tab forward too)
  try { adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main'); } catch {}
}

// open a fresh tab on the phone's Chrome; returns its WebSocket and a cleanup function
async function openAndroidTab() {
  const r = await fetch(`http://127.0.0.1:${ANDROID_PORT}/json/new?about:blank`, { method: 'PUT' });
  const body = await r.text();
  let t = null;
  try { t = JSON.parse(body); } catch { /* "Could not create new page": reuse an open tab */ }
  if (t && t.webSocketDebuggerUrl)
    return { ws: new WebSocket(t.webSocketDebuggerUrl), close: () => fetch(`http://127.0.0.1:${ANDROID_PORT}/json/close/${t.id}`).catch(() => {}) };
  const list = await (await fetch(`http://127.0.0.1:${ANDROID_PORT}/json/list`)).json();
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('no Chrome tab on the phone: open Chrome there');
  return { ws: new WebSocket(page.webSocketDebuggerUrl), close: async () => {} };
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
    ...(softwareGL ? gpuFlags('swiftshader') : gpuFlags()), ...EXTRA_FLAGS,
    'about:blank',
  ];
  const chrome = spawn(CHROME, flags, { stdio: 'ignore' });
  try {
    let ws;
    for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((p) => p.type === 'page');
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl); else await sleep(200);
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
    const log = [];   // page console + uncaught exceptions, printed when the run fails
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.consoleAPICalled') log.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      else if (d.method === 'Runtime.exceptionThrown') log.push('EXCEPTION ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || ''));
      if (log.length > 200) log.shift();
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

    if (android) await send('Page.bringToFront');   // a background tab is hidden and paused
    await send('Runtime.enable');
    try { return await measure(send, evaluate); }
    catch (e) {
      console.error('page console (last lines):\n  ' + log.slice(-40).join('\n  '));
      throw e;
    }
  } finally {
    ws.close();
  }
}

async function measure(send, evaluate) {
  const url = base + (base.includes('?') ? '&' : '?') +
    (shotsLabel ? `shots=${encodeURIComponent(shotsLabel)}&mute=1&uncapped=1` : `bench=1&uncapped=${capped ? 0 : 1}`) + `&run=${Date.now()}`;
  if (cpuThrottle > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  await send('Page.navigate', { url });
  const t0 = Date.now();
  if (shotsLabel) {
    while (Date.now() - t0 < (android ? 600000 : 120000) * TIMEOUT_SCALE) {
      await sleep(500);
      if (await evaluate('window.__shotsDone === true'))
        return { shots: shotsLabel, backend: await evaluate("window.Module && Module.se1gfx && Module.se1gfx.backend") };
    }
    throw new Error('timed out waiting for shots');
  }
  while (Date.now() - t0 < (android ? 600000 : 120000) * Math.max(1, cpuThrottle) * TIMEOUT_SCALE) {
    await sleep(1000);
    const s = await evaluate("window.__bench && window.__bench.state === 'done' && JSON.stringify(window.__bench.stats)");
    if (s) return JSON.parse(s);
  }
  throw new Error('timed out waiting for benchmark (state: ' + (await evaluate('window.__bench && window.__bench.state')) + ')');
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
