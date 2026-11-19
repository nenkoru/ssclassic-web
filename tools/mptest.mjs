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
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rtc = args.includes('--rtc');
const posArgs = args.filter((a) => !a.startsWith('--'));
const [url, level = 'Levels/KarnakDemo.wld', outdir = join(tmpdir(), 'se1-mp')] = posArgs;
if (!url) { console.error('usage: mptest.mjs <url> [level] [outdir] [--rtc]'); process.exit(2); }
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
  const rtcFlags = rtc ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [];
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1mp-'))}`,
    '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, ...rtcFlags, '--window-size=1100,1000', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  procs.push(chrome);
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
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
  const rtcParam = rtc ? '&rtc=1' : '';
  const host = await browser('host', `${url}${sep}mute=1&room=${room}&host=1&level=${encodeURIComponent(level)}&net=${encodeURIComponent(net)}${rtcParam}`);
  await sleep(8000 * TIMEOUT_SCALE);   // host loads the level and starts the server first
  const client = await browser('client', `${url}${sep}mute=1&room=${room}&net=${encodeURIComponent(net)}${rtcParam}`);
  const stat = (b) => b.ev('JSON.stringify({ip: Module.se1Net && Module.se1Net.ip, sent: Module.se1Net && Module.se1Net.sent, recv: Module.se1Net && Module.se1Net.recv, recvU: Module.se1Net && (Module.se1Net.recvUnicast||0), err: Module.se1Net && Module.se1Net.error, frames: Module.se1Perf ? Module.se1Perf.n : -1, rtc: Module.se1Net && Module.se1Net.rtc ? {links: Module.se1Net.rtc.links, sent: Module.se1Net.rtc.sent, recv: Module.se1Net.rtc.recv, recvU: Module.se1Net.rtc.recvUnicast||0} : null})');
  let h = {}, c = {};
  for (let t = 0; t < 90 * TIMEOUT_SCALE; t++) {   // up to 90 s: both load the level, client connects
    await sleep(1000);
    h = JSON.parse((await stat(host)) || '{}'); c = JSON.parse((await stat(client)) || '{}');
    const hTotalRecv = h.recv + (h.rtc ? h.rtc.recv : 0);
    const cTotalRecv = c.recv + (c.rtc ? c.rtc.recv : 0);
    if (hTotalRecv > 50 && cTotalRecv > 50 && c.frames > 300) break;
  }
  check('host joined as 10.77.0.1', h.ip === '10.77.0.1', JSON.stringify(h));
  check('client joined the room', /^10\.77\.0\.\d+$/.test(c.ip || '') && c.ip !== '10.77.0.1', JSON.stringify(c));
  const hTr = h.recv + (h.rtc ? h.rtc.recv : 0), hTs = h.sent + (h.rtc ? h.rtc.sent : 0);
  const cTr = c.recv + (c.rtc ? c.rtc.recv : 0), cTs = c.sent + (c.rtc ? c.rtc.sent : 0);
  check('packets flow both ways', hTr > 50 && cTr > 50 && hTs > 50 && cTs > 50, `host ${hTs}/${hTr}, client ${cTs}/${cTr} (sent/received, switch+rtc)`);
  const f0 = c.frames; await sleep(2000); c = JSON.parse((await stat(client)) || '{}');
  check('client keeps running', c.frames - f0 > 20, `${c.frames - f0} frames in 2 s`);
  if (rtc) {
    // Wait for RTC links to open (up to 30 s)
    let linkOpen = false;
    for (let t = 0; t < 30; t++) {
      await sleep(1000);
      h = JSON.parse((await stat(host)) || '{}'); c = JSON.parse((await stat(client)) || '{}');
      const hLinks = h.rtc ? h.rtc.links : {};
      const cLinks = c.rtc ? c.rtc.links : {};
      const hOpen = Object.values(hLinks).some((s) => s === 'open');
      const cOpen = Object.values(cLinks).some((s) => s === 'open');
      if (hOpen && cOpen) { linkOpen = true; break; }
    }
    check('rtc link open', linkOpen, `host links ${JSON.stringify(h.rtc ? h.rtc.links : {})}, client links ${JSON.stringify(c.rtc ? c.rtc.links : {})}`);
    if (linkOpen) {
      // Measure unicast traffic split over 10 s
      const h0 = { ru: h.rtc.recvU, su: h.recvU };
      const c0 = { ru: c.rtc.recvU, su: c.recvU };
      await sleep(10000);
      h = JSON.parse((await stat(host)) || '{}'); c = JSON.parse((await stat(client)) || '{}');
      const hRtcU = h.rtc.recvU - h0.ru;
      const hSwU = h.recvU - h0.su;
      const cRtcU = c.rtc.recvU - c0.ru;
      const cSwU = c.recvU - c0.su;
      const hTotalU = hRtcU + hSwU;
      const cTotalU = cRtcU + cSwU;
      const hPct = hTotalU > 0 ? (hRtcU / hTotalU) * 100 : 0;
      const cPct = cTotalU > 0 ? (cRtcU / cTotalU) * 100 : 0;
      check('game traffic goes peer to peer', hPct >= 80 && cPct >= 80,
        `host rtc ${hRtcU}/${hTotalU} (${hPct.toFixed(0)}%), client rtc ${cRtcU}/${cTotalU} (${cPct.toFixed(0)}%)`);
    }
  }
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
