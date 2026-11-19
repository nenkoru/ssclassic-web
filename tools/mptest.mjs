#!/usr/bin/env node
// Two-player multiplayer test over the virtual LAN (rust/se1-server + port/common/NetLan.c):
// starts the LAN switch, a host browser (?room=..&host=1: +server +level) and a client browser
// (?room=..: +connect 10.77.0.1), then checks that both joined the room, packets flow both ways,
// and the client is in the level (frames advance). Screenshots: <outdir>/mp-host.png, mp-client.png.
//
//   node tools/mptest.mjs http://127.0.0.1:8094/serioussam.html [level] [outdir]
//
// Needs the switch binary: (cd rust && cargo build -p se1-server --release).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ANGLE = process.env.SE1_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const [url, level = 'Levels/KarnakDemo.wld', outdir = join(tmpdir(), 'se1-mp')] = process.argv.slice(2);
if (!url) { console.error('usage: mptest.mjs <url> [level] [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const swPort = 9100 + Math.floor(Math.random() * 50);
const swBin = join(ROOT, 'rust/target/release/se1-server');
if (!existsSync(swBin)) { console.error('missing ' + swBin + ' (cargo build -p se1-server --release)'); process.exit(2); }
const sw = spawn(swBin, ['--port', String(swPort)], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const procs = [sw];

async function browser(tag, pageUrl) {
  const port = 9750 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1mp-'))}`,
    '--mute-audio', `--use-angle=${ANGLE}`, '--enable-gpu', '--window-size=1100,1000', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  procs.push(chrome);
  let ws;
  for (let t = 0; t < 50 && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); }
    catch { await sleep(200); }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  await send('Page.navigate', { url: pageUrl });
  return { tag, ev, errors, shot: async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); } };
}

try {
  await sleep(300);
  const room = 'mptest' + Date.now();
  const net = `ws://127.0.0.1:${swPort}`;
  const sep = url.includes('?') ? '&' : '?';
  const host = await browser('host', `${url}${sep}mute=1&room=${room}&host=1&level=${encodeURIComponent(level)}&net=${encodeURIComponent(net)}`);
  await sleep(8000);   // host loads the level and starts the server first
  const client = await browser('client', `${url}${sep}mute=1&room=${room}&net=${encodeURIComponent(net)}`);
  const stat = (b) => b.ev('JSON.stringify({ip: Module.se1Net && Module.se1Net.ip, sent: Module.se1Net && Module.se1Net.sent, recv: Module.se1Net && Module.se1Net.recv, err: Module.se1Net && Module.se1Net.error, frames: Module.se1Perf ? Module.se1Perf.n : -1})');
  let h = {}, c = {};
  for (let t = 0; t < 90; t++) {   // up to 90 s: both load the level, client connects
    await sleep(1000);
    h = JSON.parse((await stat(host)) || '{}'); c = JSON.parse((await stat(client)) || '{}');
    if (h.recv > 50 && c.recv > 50 && c.frames > 300) break;
  }
  check('host joined as 10.77.0.1', h.ip === '10.77.0.1', JSON.stringify(h));
  check('client joined the room', /^10\.77\.0\.\d+$/.test(c.ip || '') && c.ip !== '10.77.0.1', JSON.stringify(c));
  check('packets flow both ways', h.recv > 50 && c.recv > 50 && h.sent > 50 && c.sent > 50, `host ${h.sent}/${h.recv}, client ${c.sent}/${c.recv} (sent/received)`);
  const f0 = c.frames; await sleep(2000); c = JSON.parse((await stat(client)) || '{}');
  check('client keeps running', c.frames - f0 > 20, `${c.frames - f0} frames in 2 s`);
  await host.shot(join(outdir, 'mp-host.png')); await client.shot(join(outdir, 'mp-client.png'));
  check('no exceptions', !host.errors.length && !client.errors.length, [...host.errors, ...client.errors].slice(0, 3).join(' | '));
  if (failed && process.env.SE1_MPLOG) {   // engine log tails (single-threaded build: FS is on the page)
    for (const b of [host, client]) {
      const log = await b.ev("(function(){try{return FS.readFile('/libsdl/Serious-Engine/serioussam/SeriousSam.log',{encoding:'utf8'}).slice(-" + (+process.env.SE1_MPLOG || 1500) + ")}catch(e){return 'no log: '+e}})()");
      console.log(`---- ${b.tag} log tail ----\n${log}`);
    }
  }
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  procs.forEach((p) => p.kill());
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
