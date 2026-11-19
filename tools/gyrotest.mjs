#!/usr/bin/env node
// Gyro test (port/web/gyro.js): a fake WebHID DualSense drives the game.
// Headless Chrome, fake navigator.hid injected before page load; checks that
// gyro reports rotate the view, drift is compensated, touchpad toggles, and
// ?gyro=0 disables the script.
//   node tools/gyrotest.mjs http://127.0.0.1:8471/serioussam.html
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url] = process.argv.slice(2);
if (!url) { console.error('usage: gyrotest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9870 + Math.floor(Math.random() * 49);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1gyro-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// Fake WebHID: one DualSense, records feature-report reads, dispatches input reports.
const SPY = `(() => {
  var listeners = {};
  var featCalls = [];
  var dev = {
    vendorId: 0x054c, productId: 0x0ce6, opened: false,
    open: function() { this.opened = true; return Promise.resolve(); },
    close() { return Promise.resolve(); },
    receiveFeatureReport(id) { featCalls.push(id); return Promise.resolve(new DataView(new ArrayBuffer(64))); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(function(f){return f!==fn;}); }
  };
  var hidListeners = {};
  Object.defineProperty(navigator, 'hid', { value: {
    getDevices: () => Promise.resolve([dev]),
    requestDevice: () => Promise.resolve([dev]),
    addEventListener(t, fn) { (hidListeners[t] = hidListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { hidListeners[t] = (hidListeners[t] || []).filter(function(f){return f!==fn;}); }
  }, configurable: true });
  // like Chrome: unplugging is reported on navigator.hid, with the device in the event
  window.__hidUnplug = function() { (hidListeners.disconnect || []).forEach(function(fn){ fn({ device: dev }); }); };
  window.__hidDev = dev;
  window.__hidFeatCalls = featCalls;
  window.__hidSend = function(reportId, gyro, buttonsByte) {
    var isBt = reportId === 0x31;
    var len = isBt ? 22 : 21;
    var buf = new ArrayBuffer(len);
    var dv = new DataView(buf);
    var off = isBt ? 1 : 0;
    dv.setInt16(15 + off, gyro[0], true);
    dv.setInt16(17 + off, gyro[1], true);
    dv.setInt16(19 + off, gyro[2], true);
    if (buttonsByte !== undefined) dv.setUint8(9 + off, buttonsByte);
    var ev = { reportId: reportId, data: dv, device: dev };
    (listeners['inputreport'] || []).forEach(function(fn) { fn(ev); });
  };
  window.__hidRun = function(reportId, gyro, ms, buttonsByte) {
    if (window.__hidTimer) clearInterval(window.__hidTimer);
    window.__hidTimer = setInterval(function() {
      window.__hidSend(reportId, gyro, buttonsByte);
    }, 4);
    setTimeout(function() {
      clearInterval(window.__hidTimer);
      window.__hidTimer = null;
    }, ms);
  };
})();`;

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => { const r = (await send('Runtime.evaluate', { expression: e, returnByValue: true })); return r?.result?.result?.value; };
  const st = async () => { const v = await ev(`JSON.stringify({
    want: Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : -1,
    hud: Module.se1SurvivorsLast || null,
    gyro: Module.se1Gyro || null,
    featCalls: window.__hidFeatCalls || [],
  })`); return v ? JSON.parse(v) : { want: -1, hud: null, gyro: null, featCalls: [] }; };
  const until = async (pred, ms) => { let s; for (let t = 0; t < ms / 250; t++) { s = await st(); if (pred(s)) return s; await sleep(250); } return s; };
  const yawDelta = (a, b) => { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
  const load = async (qs) => {
    await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + qs });
    return until((x) => x.want === 1, 90000 * TIMEOUT_SCALE);
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
  await load('mute=1&mode=survivors&svauto=1&svgod=1&aimassist=0');
  await sleep(1000);

  // Continuous zero-gyro feed: no dt gaps between test phases.
  // __hidSet changes the values for the next tick.
  await ev(`
    window.__hidGyro = [0,0,0];
    window.__hidBtn = 0;
    window.__hidId = 0x01;
    window.__hidSet = function(id, gyro, btn) { window.__hidId = id; window.__hidGyro = gyro; if (btn !== undefined) window.__hidBtn = btn; };
    window.__hidTimer = setInterval(function() {
      window.__hidSend(window.__hidId, window.__hidGyro, window.__hidBtn);
    }, 4);
    true`);
  await sleep(500);

  // 1. measure COUNTS_PER_DEG: _SE1_PadLook(200, 0) → yaw change. Keep the turn well under 180°:
  // a bigger one wraps around and reads as a turn the other way (1000 counts = 250° read as -110°).
  let h = await st();
  const yaw0 = h.hud ? h.hud.yaw : null;
  await ev(`Module._SE1_PadLook(200, 0); true`);
  await sleep(1000);
  h = await st();
  const yaw1 = h.hud ? h.hud.yaw : null;
  const rightSign = yaw0 != null && yaw1 != null ? Math.sign(yawDelta(yaw0, yaw1)) : 0;   // HUD yaw sign of a right turn
  const cpdChange = yaw0 != null && yaw1 != null ? Math.abs(yawDelta(yaw0, yaw1)) : 0;
  const cpd = cpdChange > 0.1 ? 200 / cpdChange : 0;
  console.log(`counts per degree: ${cpd.toFixed(2)}`);
  check('measured', cpdChange > 1 && Math.abs(cpd - 4) < 0.5, `yaw ${yaw0} -> ${yaw1} (Δ${cpdChange.toFixed(2)}°, ${cpd.toFixed(2)} counts/° — gyro.js assumes 4)`);

  // 2. connects via getDevices (no click needed)
  h = await st();
  check('connects', !!(h.gyro && h.gyro.connected === true), JSON.stringify(h.gyro ? { connected: h.gyro.connected } : null));


  // 3. yaw left: 30 dps for 1 s → 45° of controller rotation → 45*sens*cpd counts
  // Pre-seed bias to zero; the pulse starts immediately so the quiet timer
  // (0.5 s) doesn't expire and absorb the first part of the pulse.
  await ev(`Module.se1Gyro.bias = [0,0,0]; true`);
  h = await st();
  const countsYBefore = h.gyro ? h.gyro.counts[0] : 0;
  const yawBefore = h.hud ? h.hud.yaw : null;
  await ev(`window.__hidSet(0x01, [0, 491, 0]); true`);   // 491 ≈ 30*16.384
  await sleep(1000);
  await ev(`window.__hidSet(0x01, [0, 0, 0]); true`);
  await sleep(800);
  h = await st();
  const dCounts = (h.gyro ? h.gyro.counts[0] : 0) - countsYBefore;
  const yawAfter = h.hud ? h.hud.yaw : null;
  // the view itself: 30 dps * 1 s * 1.5 sens = 45° to the LEFT (opposite to step 1's right turn)
  const turned = yawBefore != null && yawAfter != null ? yawDelta(yawBefore, yawAfter) : 0;
  const okMoved = Math.abs(Math.abs(turned) - 45) < 12;
  const okLeft = rightSign !== 0 && Math.sign(turned) === -rightSign && dCounts < 0;
  const okCounts = true;
  check('yaw left', okMoved && okLeft, `view turned ${turned.toFixed(1)}° (expect 45° left), counts Δ${dCounts}`);


  // 4. pitch up: positive raw pitch → counts[1] decreased (dy negative)
  await ev(`Module.se1Gyro.bias = [0,0,0]; true`);
  h = await st();
  const countsBefore = h.gyro ? [...h.gyro.counts] : [0, 0];
  await ev(`window.__hidSet(0x01, [491, 0, 0]); true`);   // positive pitch
  await sleep(500);
  await ev(`window.__hidSet(0x01, [0, 0, 0]); true`);
  await sleep(300);
  h = await st();
  const countsAfter = h.gyro ? h.gyro.counts : [0, 0];
  const dPitch = countsAfter[1] - countsBefore[1];
  check('pitch up', dPitch < 0, `counts[1] ${countsBefore[1]} -> ${countsAfter[1]} (Δ${dPitch})`);

  // 5. bluetooth: report id 0x31 (+1 offsets) also works, feature report 0x05 was read
  await ev(`Module.se1Gyro.bias = [0,0,0]; true`);
  h = await st();
  const countsBtBefore = h.gyro ? h.gyro.counts[0] : 0;
  await ev(`window.__hidSet(0x31, [0, 491, 0]); true`);
  await sleep(1000);
  await ev(`window.__hidSet(0x01, [0, 0, 0]); true`);
  await sleep(300);
  h = await st();
  const countsBtAfter = h.gyro ? h.gyro.counts[0] : 0;
  const dCountsBt = countsBtAfter - countsBtBefore;
  const featOk = h.featCalls && h.featCalls.includes(0x05);
  const okBt = Math.abs(dCountsBt) > 100 && featOk;
  check('bluetooth', okBt, `counts Δ${dCountsBt}, featCalls ${JSON.stringify(h.featCalls)}`);

  // 6. drift: constant 1.5 dps for 6 s → <2° in the last 2 s
  await ev(`Module.se1Gyro.bias = [0,0,0]; true`);
  await sleep(200);
  await ev(`window.__hidSet(0x01, [0, 25, 0]); true`);   // 25/16.384 ≈ 1.5 dps
  await sleep(4000);   // bias converges
  h = await st();
  const yawDriftBefore = h.hud ? h.hud.yaw : null;
  await sleep(2000);   // last 2 s of the 6 s total
  h = await st();
  const yawDriftAfter = h.hud ? h.hud.yaw : null;
  const dDrift = yawDriftBefore != null && yawDriftAfter != null ? Math.abs(yawDelta(yawDriftBefore, yawDriftAfter)) : 999;
  check('drift', dDrift < 2, `Δ${dDrift.toFixed(2)}° in last 2 s (bias ${JSON.stringify(h.gyro ? h.gyro.bias : null)})`);

  // 7. touchpad toggle: one click (press + release) turns gyro off, yaw then moves nothing;
  // the release alone must not toggle back; a second click turns it on
  const click = async () => {
    await ev(`window.__hidSet(0x01, [0, 0, 0], 0x02); true`); await sleep(300);
    await ev(`window.__hidSet(0x01, [0, 0, 0], 0x00); true`); await sleep(300);
  };
  await ev(`window.__hidSet(0x01, [0, 0, 0], 0); true`);
  await sleep(500);
  await click();
  h = await st();
  const offOk = h.gyro && h.gyro.on === false;
  const cOffBefore = h.gyro ? [...h.gyro.counts] : [0, 0];
  await ev(`window.__hidSet(0x01, [0, 491, 0], 0x00); true`);
  await sleep(500);
  await ev(`window.__hidSet(0x01, [0, 0, 0], 0x00); true`);
  h = await st();
  const cOffAfter = h.gyro ? h.gyro.counts : [0, 0];
  const movedWhileOff = Math.abs(cOffAfter[0] - cOffBefore[0]) > 0;
  await click();
  h = await st();
  const onAgain = h.gyro && h.gyro.on === true;
  check('touchpad toggle', offOk && !movedWhileOff && onAgain,
    `off=${offOk}, movedWhileOff=${movedWhileOff}, onAgain=${onAgain}`);

  // unplugging: disconnected, and the button to connect again is back
  await ev(`window.__hidUnplug(); true`);
  await sleep(300);
  h = await st();
  const btnBack = await ev(`[...document.querySelectorAll('button')].some(function(b){return b.textContent === 'Enable gyro';})`);
  check('unplug', h.gyro && h.gyro.connected === false && btnBack === true, `connected=${h.gyro && h.gyro.connected}, button=${btnBack}`);

  // 8. off by option: ?gyro=0 → se1Gyro undefined, no button
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&gyro=0' });
  await until((x) => x.want === 1, 90000 * TIMEOUT_SCALE);
  await sleep(1000);
  const gyroOff = await ev(`typeof Module.se1Gyro`);
  const btnCount = await ev(`document.querySelectorAll('button').length`);
  check('off by option', gyroOff === 'undefined', `se1Gyro=${gyroOff}, buttons=${btnCount}`);

  // 9. no exceptions (filter out the engine's own pointer-lock errors)
  const gyroErrors = errors.filter((e) => !e.includes('pointer lock') && !e.includes('PointerLock'));
  check('no exceptions', gyroErrors.length === 0, gyroErrors.slice(0, 3).join('; ') || 'clean');

} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
