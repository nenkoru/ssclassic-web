#!/usr/bin/env node
// Multiplayer lobby UI test:
// starts the LAN switch, two headless Chrome pages with ?mute=1&net=ws://127.0.0.1:9310 and no room,
// then drives the lobby UI: opens the overlay, validates room input, hosts, joins, checks peer count,
// leaves. All checks are PASS/FAIL lines; exit 1 on any failure.
//
//   node tools/lobbytest.mjs http://127.0.0.1:8310/serioussam.html
//
// Needs the switch binary: (cd rust && cargo build -p se1-server --release).
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2];
if (!url) { console.error('usage: lobbytest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const swPort = 9310;
const swBin = join(ROOT, 'rust/target/release/se1-server');
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const procs = [];
const chromes = [];

const sw = spawn(swBin, ['--port', String(swPort)], { stdio: 'ignore' });
procs.push(sw);

async function browser(port) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempProfile('se1lobby-')}`,
    '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  chromes.push(chrome);
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
  return { ev, errors, send };
}

async function clickElement(b, sel) {
  const rect = await b.ev(`(function(){var e=document.querySelector('${sel}'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  if (!rect) throw new Error(`element ${sel} not found`);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

async function setRoom(b, value) {
  await b.ev(`(function(){var e=document.getElementById('lobby-room'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}

async function readOverlay(b) {
  return b.ev(`(function(){var e=document.getElementById('lobby'); return e ? e.innerText : '';})()`);
}

async function urlParams(b) {
  const u = await b.ev('location.href');
  const p = new URL(u).searchParams;
  return { href: u, params: p };
}

const net = `ws://127.0.0.1:${swPort}`;
const sep = url.includes('?') ? '&' : '?';
const pageUrl = `${url}${sep}mute=1&net=${encodeURIComponent(net)}`;

try {
  await sleep(300);
  const host = await browser(9850);
  const client = await browser(9851);
  await host.send('Page.navigate', { url: pageUrl });
  await client.send('Page.navigate', { url: pageUrl });
  // Wait for both pages to load and the engine to boot
  for (let t = 0; t < 60 * TIMEOUT_SCALE; t++) {
    const hm = await host.ev('typeof Module !== "undefined" && Module.se1Net ? 1 : 0');
    const cm = await client.ev('typeof Module !== "undefined" && Module.se1Net ? 1 : 0');
    if (hm && cm) break;
    await sleep(1000);
  }

  // Check 1: button present
  const mpInBar = await host.ev(`(function(){var bar=document.getElementById('bar'); var mp=document.getElementById('mp'); return bar && mp && bar.contains(mp) ? 1 : 0;})()`);
  check('button present', !!mpInBar, `#mp in #bar: ${mpInBar ? 'yes' : 'no'}`);

  // Check 2: overlay opens
  await clickElement(host, '#mp');
  await sleep(200);
  const overlayOpen = await host.ev(`(function(){var l=document.getElementById('lobby'); var room=document.getElementById('lobby-room'); var level=document.getElementById('lobby-level'); var h=document.getElementById('lobby-host'); var j=document.getElementById('lobby-join'); var vis=l && getComputedStyle(l).display!=='none'; var opts=level?level.options.length:0; return vis&&room&&level&&opts>=1&&h&&j ? 1 : 0;})()`);
  check('overlay opens', !!overlayOpen, `#lobby visible with room/level/host/join: ${overlayOpen ? 'yes' : 'no'}`);

  // Check 3: invalid room rejected
  await setRoom(host, 'bad name!');
  await clickElement(host, '#lobby-host');
  await sleep(300);
  const errVis = await host.ev(`(function(){var e=document.getElementById('lobby-error'); return e && getComputedStyle(e).display!=='none' ? 1 : 0;})()`);
  const urlAfter = await urlParams(host);
  const urlUnchanged = !urlAfter.params.has('room');
  check('invalid room rejected', !!errVis && urlUnchanged, `error visible: ${!!errVis}, URL unchanged: ${urlUnchanged}`);

  // Check 4: host navigates
  await setRoom(host, 'lobbytest');
  await clickElement(host, '#lobby-host');
  await sleep(300);
  const hUrl = await urlParams(host);
  const hRoom = hUrl.params.get('room');
  const hHost = hUrl.params.get('host');
  const hLevel = hUrl.params.get('level');
  const hNet = hUrl.params.get('net');
  const hMute = hUrl.params.get('mute');
  check('host navigates', hRoom === 'lobbytest' && hHost === '1' && hLevel && hNet === net && hMute === '1',
    `room=${hRoom} host=${hHost} level=${hLevel} net=${hNet} mute=${hMute}`);
  let hIp = '';
  for (let t = 0; t < 60 * TIMEOUT_SCALE; t++) {
    hIp = await host.ev('Module.se1Net ? Module.se1Net.ip : ""');
    if (hIp === '10.77.0.1') break;
    await sleep(1000);
  }
  check('host ip 10.77.0.1', hIp === '10.77.0.1', `ip=${hIp}`);

  // Check 5: join navigates
  await clickElement(client, '#mp');
  await sleep(200);
  await setRoom(client, 'lobbytest');
  await clickElement(client, '#lobby-join');
  await sleep(300);
  const cUrl = await urlParams(client);
  const cRoom = cUrl.params.get('room');
  const cNoHost = !cUrl.params.has('host');
  check('join navigates', cRoom === 'lobbytest' && cNoHost, `room=${cRoom} no host=${cNoHost}`);
  let cIp = '';
  for (let t = 0; t < 60 * TIMEOUT_SCALE; t++) {
    cIp = await client.ev('Module.se1Net ? Module.se1Net.ip : ""');
    if (cIp === '10.77.0.2') break;
    await sleep(1000);
  }
  check('client ip 10.77.0.2', cIp === '10.77.0.2', `ip=${cIp}`);

  // Check 6: status shows peers — re-open overlay on host (page reloaded after navigation)
  await clickElement(host, '#mp');
  await sleep(300);
  const overlayText = await readOverlay(host);
  const hasRoom = overlayText.includes('lobbytest');
  const hasPeer = /peer/i.test(overlayText) && /1/.test(overlayText);
  check('status shows peers', hasRoom && hasPeer, `room in text: ${hasRoom}, peer count 1: ${hasPeer}`);

  // Check 7: leave — re-open overlay on client (page reloaded after navigation)
  await clickElement(client, '#mp');
  await sleep(300);
  await clickElement(client, '#lobby-leave');
  await sleep(300);
  const lUrl = await urlParams(client);
  const lNoRoom = !lUrl.params.has('room');
  const lNet = lUrl.params.has('net');
  const lMute = lUrl.params.has('mute');
  check('leave', lNoRoom && lNet && lMute, `no room: ${lNoRoom}, net: ${lNet}, mute: ${lMute}`);

  // Check 8: no exceptions
  check('no exceptions', !host.errors.length && !client.errors.length,
    [...host.errors, ...client.errors].slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await Promise.all(chromes.map((p) => closeChrome(p)));
  procs.forEach((p) => p.kill());
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
