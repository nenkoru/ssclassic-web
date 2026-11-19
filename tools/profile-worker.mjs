#!/usr/bin/env node
// CPU-profile the engine worker (threaded build) during the timedemo, over DevTools auto-attach.
// Prints the top self-time functions and the call stacks of time spent waiting on the main thread
// (synchronous proxies show up as _do_futex_wait).
//   node tools/profile-worker.mjs "http://127.0.0.1:8094/serioussam.html?bench=1&uncapped=1" out.txt [seconds=5] [--android]
// --android: profile Chrome on a phone over adb (see tools/bench.mjs --android; ADB_SERIAL picks the device)
import { spawn, execFileSync } from 'node:child_process'; import { writeFileSync } from 'node:fs';
import { CHROME, gpuFlags, EXTRA_FLAGS, tempProfile, closeChrome } from './chrome.mjs';   // CHROME, SE1_ANGLE, SE1_CHROME_FLAGS
const argv = process.argv.slice(2), android = argv.includes('--android');
const [url, out, secs] = argv.filter(a => a !== '--android');
let port = 9600 + Math.floor(Math.random() * 30), c = { kill() {} };
const adb = (...a) => execFileSync(process.env.ADB || 'adb', [...(process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : []), ...a], { encoding: 'utf8' });
if (android) {
  port = 9222;
  adb('forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote');
  adb('reverse', `tcp:${new URL(url).port}`, `tcp:${new URL(url).port}`);
  const awake = () => { try { adb('shell', 'input keyevent KEYCODE_WAKEUP; input keyevent KEYCODE_UNKNOWN'); } catch {} };
  awake(); setInterval(awake, 10000).unref();
} else c = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('wp-')}`, '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws; for (let t = 0; t < 50 && !ws; t++) { try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); } catch { await sleep(200); } }
await new Promise(r => ws.onopen = r); let id = 0; const pend = new Map(); const workers = [];
let page;
ws.onmessage = m => { const d = JSON.parse(m.data);
  if (d.method === 'Target.attachedToTarget') { const ti = d.params.targetInfo; if (ti.type === 'worker') workers.push(d.params.sessionId); else if (ti.type === 'page') page = d.params.sessionId;
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, d.params.sessionId);
    send('Runtime.runIfWaitingForDebugger', {}, d.params.sessionId); }
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}, sessionId) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params })); });
const { result: { targetInfos } } = await send('Target.getTargets');
const pg = targetInfos.find(t => t.type === 'page');
if (android) await send('Target.activateTarget', { targetId: pg.targetId });   // a background tab is paused
await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
for (let t = 0; t < 20 && !page; t++) await sleep(100);
await send('Page.navigate', { url }, page);
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true }, page)).result?.result?.value;
for (let t = 0; t < (android ? 1200 : 120); t++) { await sleep(500); if (await ev("window.__bench && window.__bench.state==='running'")) break; }
console.error('workers:', workers.length);
for (const w of workers) { await send('Profiler.enable', {}, w); await send('Profiler.setSamplingInterval', { interval: 100 }, w); await send('Profiler.start', {}, w); }
await sleep((+secs || 5) * 1000);
let best = null;
for (const w of workers) { const r = await send('Profiler.stop', {}, w); const p = r.result?.profile; if (!p) continue;
  const self = {}; let tot = 0; const byId = new Map(p.nodes.map(n => [n.id, n]));
  const cnt = {}; for (const s of p.samples) cnt[s] = (cnt[s] || 0) + 1;
  for (const [nid, k] of Object.entries(cnt)) { const n = byId.get(+nid); const nm = n.callFrame.functionName || '(anon ' + n.callFrame.url.split('/').pop() + ')'; if (nm === '(idle)' || nm === '(program)') continue; self[nm] = (self[nm] || 0) + k; tot += k; }
  // stacks ending in a futex wait: who is waiting on the main thread?
  const par = new Map(); for (const n of p.nodes) for (const ch of (n.children || [])) par.set(ch, n.id);
  const st = {};
  for (const [nid, k] of Object.entries(cnt)) { const n = byId.get(+nid); if (n.callFrame.functionName !== '_do_futex_wait') continue;
    let chain = [], x = par.get(+nid); while (x && chain.length < 7) { const fn = byId.get(x).callFrame.functionName; if (fn && !/futex|proxy|wait|EmAsm|em_asm|(root)/i.test(fn)) chain.push(fn); x = par.get(x); }
    const key = chain.slice(0, 4).join(' < '); st[key] = (st[key] || 0) + k; }
  if (!best || tot > best.tot) best = { tot, self, st }; }
const top = Object.entries(best.self).sort((a, b) => b[1] - a[1]).slice(0, 45).map(([n, k]) => (100 * k / best.tot).toFixed(1).padStart(5) + '%  ' + n);
const stk = Object.entries(best.st).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, k]) => (100 * k / best.tot).toFixed(1).padStart(5) + '%  ' + n);
writeFileSync(out, top.join('\n') + '\n\n== futex-wait stacks\n' + stk.join('\n')); console.log('busy samples', best.tot); await closeChrome(c); process.exit(0);
