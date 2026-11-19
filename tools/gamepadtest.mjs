#!/usr/bin/env node
// Gamepad test (port/web/gamepad.js): a fake navigator.getGamepads pad drives the game.
// Headless Chrome, fake pad injected before page load; checks that stick axes become
// key events, buttons map to keys/mouse/wheel, start opens the menu, aim assist pulls
// (and does not, at level 0), and back cycles the assist level with a toast.
//   node tools/gamepadtest.mjs http://127.0.0.1:8300/serioussam.html
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const [url] = process.argv.slice(2);
if (!url) { console.error('usage: gamepadtest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9870 + Math.floor(Math.random() * 49);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1pad-'))}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// fake pad + event recorder, injected before the page loads
const SPY = `(() => {
  window.__pad = {
    id: 'test pad',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({length: 17}, () => ({ pressed: false, value: 0 }))
  };
  var _padArray = new Array(16); _padArray.fill(null); _padArray[0] = window.__pad;
  navigator.getGamepads = () => _padArray;
  window.__ev = [];
  addEventListener('keydown', (e) => __ev.push(['kd', e.code]), true);
  addEventListener('keyup', (e) => __ev.push(['ku', e.code]), true);
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
    keys: window.__ev || [],
    hud: Module.se1SurvivorsLast || null,
    pad: Module.se1Pad || null,
    toast: (function () { const els = document.body ? document.body.querySelectorAll('div') : []; for (const el of els) { const t = el.textContent || ''; if (t.indexOf('Aim assist') === 0) return t.trim().slice(0, 120); } return null; })()
  })`); return v ? JSON.parse(v) : { want: -1, keys: [], hud: null, pad: null, toast: null }; };
  const until = async (pred, ms) => { let s; for (let t = 0; t < ms / 250; t++) { s = await st(); if (pred(s)) return s; await sleep(250); } return s; };
  const saw = (s, kind, val) => s.keys.some((k) => k[0] === kind && (val === undefined || k[1] === val));
  const posDist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  const yawDelta = (a, b) => { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d); };
  const setPad = async (expr) => ev(`(() => { ${expr}; })()`);
  const setAssist = async (level) => ev(`Module._SE1_SetAimAssist(${level}); Module.se1Pad.assist = ${level}; true`);
  const load = async (qs) => {
    await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + qs });
    return until((x) => x.want === 1, 90000 * TIMEOUT_SCALE);
  };
  // reset the recorder between scenarios so checks compare against fresh state
  const resetEv = async () => { await ev(`window.__ev = []; true`); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
  await load('mute=1&mode=survivors&svauto=1&svgod=1&aimassist=0&svstress=30&svkind=9');
  await ev(`if (Module && Module.canvas) { Module.canvas.addEventListener('mousedown', (e) => window.__ev.push(['md', e.button])); Module.canvas.addEventListener('mouseup', (e) => window.__ev.push(['mu', e.button])); Module.canvas.addEventListener('wheel', (e) => window.__ev.push(['wh', e.deltaY])); } true`);
  await sleep(500);

  // 1. pad detected
  let s = await st();
  console.log('DEBUG st:', JSON.stringify(s).slice(0, 300));
  check('pad detected', !!(s.pad && s.pad.connected === true), JSON.stringify(s.pad ? { connected: s.pad.connected, assist: s.pad.assist } : null));

  // 2. left stick moves
  await resetEv();
  let h = await st();
  const posBefore = h.hud && h.hud.pos;
  await setPad(`window.__pad.axes[1] = -1;`);
  await sleep(1500);
  await setPad(`window.__pad.axes[1] = 0;`);
  await sleep(500);
  s = await st();
  h = s.hud;
  const posAfter = h && h.pos;
  check('left stick moves', saw(s, 'kd', 'KeyW') && saw(s, 'ku', 'KeyW') && posBefore && posAfter && posDist(posBefore, posAfter) > 1.0,
    `kd ${saw(s, 'kd', 'KeyW')}, ku ${saw(s, 'ku', 'KeyW')}, pos ${JSON.stringify(posBefore)} -> ${JSON.stringify(posAfter)}`);

  // 3. right stick turns
  await resetEv();
  h = await st();
  const yawBefore = h.hud ? h.hud.yaw : null;
  await setPad(`window.__pad.axes[2] = 1;`);
  await sleep(1000);
  await setPad(`window.__pad.axes[2] = 0;`);
  await sleep(500);
  s = await st();
  const yawAfter = s.hud ? s.hud.yaw : null;
  check('right stick turns', yawBefore != null && yawAfter != null && yawDelta(yawBefore, yawAfter) > 20, `yaw ${yawBefore} -> ${yawAfter}`);

  // 4. buttons map
  await resetEv();
  // A -> Space
  await setPad(`window.__pad.buttons[0].pressed = true; window.__pad.buttons[0].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[0].pressed = false; window.__pad.buttons[0].value = 0;`);
  await sleep(200);
  s = await st();
  check('button A maps to Space', saw(s, 'kd', 'Space') && saw(s, 'ku', 'Space'), `kd ${saw(s, 'kd', 'Space')}, ku ${saw(s, 'ku', 'Space')}`);
  // RT -> mousedown button 0
  await resetEv();
  await setPad(`window.__pad.buttons[7].pressed = true; window.__pad.buttons[7].value = 1;`);
  await sleep(200);
  s = await st();
  const rtDown = saw(s, 'md', 0);
  await setPad(`window.__pad.buttons[7].pressed = false; window.__pad.buttons[7].value = 0;`);
  await sleep(200);
  s = await st();
  check('button RT maps to fire', rtDown && saw(s, 'mu', 0), `md ${rtDown}, mu ${saw(s, 'mu', 0)}`);
  // a slow pull: the browser's "pressed" flips at a low value first, the value crosses ours later
  await resetEv();
  await setPad(`window.__pad.buttons[7].pressed = true; window.__pad.buttons[7].value = 0.15;`);
  await sleep(150);
  await setPad(`window.__pad.buttons[7].value = 0.8;`);
  await sleep(200);
  s = await st();
  const slowDown = saw(s, 'md', 0);
  await setPad(`window.__pad.buttons[7].pressed = false; window.__pad.buttons[7].value = 0;`);
  await sleep(200);
  check('slow trigger pull fires', slowDown, `md ${slowDown}`);
  // a very quick tap: pressed and released within one poll; the shot must still be held >= 50 ms
  await resetEv();
  await ev(`window.__mt = []; Module.canvas.addEventListener('mousedown', () => window.__mt.push(['d', performance.now()])); Module.canvas.addEventListener('mouseup', () => window.__mt.push(['u', performance.now()])); 1`);
  await setPad(`window.__pad.buttons[7].pressed = true; window.__pad.buttons[7].value = 1; setTimeout(() => { window.__pad.buttons[7].pressed = false; window.__pad.buttons[7].value = 0; }, 20);`);
  await sleep(400);
  const mt = await ev(`JSON.stringify(window.__mt)`);
  const ts = JSON.parse(mt || '[]'), d0 = ts.find((x) => x[0] === 'd'), u0 = ts.find((x) => x[0] === 'u');
  const held = d0 && u0 ? Math.round(u0[1] - d0[1]) : -1;
  check('quick trigger tap is held long enough', held >= 50, `held ${held} ms`);
  // RB -> wheel deltaY > 0
  await resetEv();
  await setPad(`window.__pad.buttons[5].pressed = true; window.__pad.buttons[5].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[5].pressed = false; window.__pad.buttons[5].value = 0;`);
  s = await st();
  check('button RB wheels forward', s.keys.some((k) => k[0] === 'wh' && k[1] > 0), `wheels ${JSON.stringify(s.keys.filter((k) => k[0] === 'wh'))}`);
  // LB -> wheel deltaY < 0
  await resetEv();
  await setPad(`window.__pad.buttons[4].pressed = true; window.__pad.buttons[4].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[4].pressed = false; window.__pad.buttons[4].value = 0;`);
  s = await st();
  check('button LB wheels back', s.keys.some((k) => k[0] === 'wh' && k[1] < 0), `wheels ${JSON.stringify(s.keys.filter((k) => k[0] === 'wh'))}`);

  // 5. start opens the menu, A confirms there
  await resetEv();
  const assistBefore = s.pad ? s.pad.assist : null;
  await setPad(`window.__pad.buttons[9].pressed = true; window.__pad.buttons[9].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[9].pressed = false; window.__pad.buttons[9].value = 0;`);
  s = await until((x) => x.want === 0, 3000);
  const inMenu = s.want === 0;
  // d-pad down -> ArrowDown
  await resetEv();
  await setPad(`window.__pad.buttons[13].pressed = true; window.__pad.buttons[13].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[13].pressed = false; window.__pad.buttons[13].value = 0;`);
  await sleep(200);
  s = await st();
  const dpad = saw(s, 'kd', 'ArrowDown') && saw(s, 'ku', 'ArrowDown');
  // B -> Escape back to play
  await setPad(`window.__pad.buttons[1].pressed = true; window.__pad.buttons[1].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[1].pressed = false; window.__pad.buttons[1].value = 0;`);
  s = await until((x) => x.want === 1, 3000);
  check('start opens the menu, A confirms there', inMenu && dpad && s.want === 1,
    `menu ${inMenu}, dpad ${dpad}, back ${s.want === 1}`);

  // 8. back cycles the assist level
  await resetEv();
  const a0 = s.pad ? s.pad.assist : null;
  await setPad(`window.__pad.buttons[8].pressed = true; window.__pad.buttons[8].value = 1;`);
  await sleep(200);
  await setPad(`window.__pad.buttons[8].pressed = false; window.__pad.buttons[8].value = 0;`);
  await sleep(500);
  s = await st();
  const a1 = s.pad ? s.pad.assist : null;
  check('back cycles the level', a0 != null && a1 != null && a0 !== a1, `assist ${a0} -> ${a1}, toast ${JSON.stringify(s.toast)}`);

  // 9. no exceptions (check before aim assist tests which may add more)
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 6-7. aim assist, each on a fresh page facing the stress monsters: a short right-stick nudge
  // marks the pad as in use (assist only helps pad/touch look for 3 s), then no input for 1.5 s.
  // Module._SE1_AimDebug() is the engine's angle to its current target (-1: none).
  const aimRun = async (level) => {
    await load(`mute=1&mode=survivors&svauto=1&svgod=1&aimassist=${level}&svstress=30&svkind=9`);
    await sleep(5000);                                   // stress monsters spawn in front after 3 s
    await setAssist(level);
    await setPad(`window.__pad.axes[2] = 0.25;`); await sleep(150); await setPad(`window.__pad.axes[2] = 0;`);
    await sleep(300);
    const aim = () => ev('Module._SE1_AimDebug ? Module._SE1_AimDebug() : -2');
    const y0 = (await st()).hud?.yaw, a0 = await aim();
    // sample the angle for 1.5 s (a walking monster can step out of sight for a moment)
    let aMin = a0, aLast = a0;
    for (let i = 0; i < 15; i++) { await sleep(100); aLast = await aim(); if (aLast >= 0 && (aMin < 0 || aLast < aMin)) aMin = aLast; }
    const y1 = (await st()).hud?.yaw;
    // fire for 0.5 s (the stick nudge keeps the pad "in use"): the engine reports the bullet radius
    await ev('Module._SE1_AimRayDebug && Module._SE1_AimRayDebug(); 1');
    await setPad(`window.__pad.axes[2] = 0.2; window.__pad.buttons[7].pressed = true; window.__pad.buttons[7].value = 1;`);
    await sleep(500);
    const rayR = await ev('Module._SE1_AimRayDebug ? Module._SE1_AimRayDebug() : -2');
    await setPad(`window.__pad.axes[2] = 0; window.__pad.buttons[7].pressed = false; window.__pad.buttons[7].value = 0;`);
    return { y0, y1, dyaw: y0 != null && y1 != null ? yawDelta(y0, y1) : 999, a0, a1: aLast, aMin, rayR };
  };
  const off = await aimRun(0);
  check('aim assist off does not pull', off.dyaw < 2 && off.a0 === -1 && off.aMin === -1,
    `yaw ${off.y0} -> ${off.y1}, target angle ${off.a0} -> ${off.a1}`);
  check('bullets not widened when assist is off', off.rayR === -1, `bullet radius ${off.rayR}`);
  const high = await aimRun(3);
  check('bullets widened on high', high.rayR >= 0.55, `bullet radius ${high.rayR} m (co-op base 0.1 or single 0.3, +0.5 on high)`);
  check('aim assist high pulls toward a target', high.a0 > 0 && high.aMin >= 0 && (high.aMin < high.a0 * 0.5 || high.aMin < 1.0),
    `yaw ${high.y0} -> ${high.y1}, target angle ${high.a0} -> min ${high.aMin} (degrees)`);
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  chrome.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
