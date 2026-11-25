#!/usr/bin/env node
// Open a game URL in headless Chrome, attach to every worker, and print uncaught exceptions with
// their stack (the engine worker's wasm faults reach the page only as "worker sent an error").
//   node tools/crashcatch.mjs <url> [seconds=60] [--grep RE]   console lines matching RE are printed too
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';
const args = process.argv.slice(2);
const gi = args.indexOf('--grep'); const grep = gi >= 0 ? new RegExp(args.splice(gi, 2)[1]) : null;
const [url, secs = 60] = args;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9600 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1cc-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pend = new Map(); let page = null; let crashes = 0;
const send = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params })); });
try {
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); } catch { await sleep(200); }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Target.attachedToTarget') {
      const sid = d.params.sessionId;
      if (d.params.targetInfo.type === 'page' && !page) page = sid;
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      send('Runtime.enable', {}, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
    }
    if (d.method === 'Runtime.exceptionThrown') {
      crashes++;
      const e = d.params.exceptionDetails;
      console.log('!! ' + (e.exception?.description || e.text));
      for (const f of (e.stackTrace?.callFrames || []).slice(0, 40)) console.log('   at ' + f.functionName + ' ' + f.url.split('/').pop() + ':' + f.lineNumber + ':' + f.columnNumber);
    }
    if (grep && d.method === 'Runtime.consoleAPICalled') {
      const s = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (grep.test(s)) console.log(s.slice(0, 300));
    }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const { result: { targetInfos } } = await send('Target.getTargets');
  await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  for (let t = 0; t < 50 && !page; t++) await sleep(100);
  await send('Page.enable', {}, page);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, page);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' }, page);
  await send('Page.navigate', { url }, page);
  const end = Date.now() + secs * 1000;
  while (Date.now() < end && crashes < 3) await sleep(500);
  console.log(`done: ${crashes} exceptions`);
} finally { await closeChrome(chrome); process.exit(0); }
