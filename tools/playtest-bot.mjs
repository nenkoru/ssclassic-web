#!/usr/bin/env node
// Playtest bot: plays a Survivors run badly but steadily, with the playtest recorder on (?rec=1),
// to produce realistic sessions for tools/playtest-report.py and a baseline to compare human runs
// against. It walks in a random direction (changing every 1.5 s), sweeps its view slowly with aim
// assist on high (so it actually hits), holds fire,
// picks a random card at every level-up, continues through chests, and when the run ends answers
// the survey as "bot". Stops at the end of the run or after --max seconds.
//
//   node tools/playtest-bot.mjs <url> [--max 600] [--seed 1] [--extra "&svtime=300"]
// The session lands in the dev server's --playtests-dir (default data/playtests).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const url = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!url) { console.error('usage: playtest-bot.mjs <url> [--max 600] [--seed 1] [--extra "&svtime=300"]'); process.exit(2); }
const maxS = +opt('max', 600), extra = opt('extra', '');
let seed = +opt('seed', 1) || 1;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9350 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1bot-'))}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
// headless Chrome has no real pointer lock: stub it (as tools/inputtest.mjs does)
const STUB = `(() => { let el = null;
  Object.defineProperty(Document.prototype, 'pointerLockElement', { get() { return el; }, configurable: true });
  Element.prototype.requestPointerLock = function () { if (el !== this) { el = this; document.dispatchEvent(new Event('pointerlockchange')); } return Promise.resolve(); };
  Document.prototype.exitPointerLock = function () { if (el) { el = null; document.dispatchEvent(new Event('pointerlockchange')); } };
})();`;

let code = 0;
try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const KEYS = { w: ['KeyW', 87], a: ['KeyA', 65], s: ['KeyS', 83], d: ['KeyD', 68], 1: ['Digit1', 49], 2: ['Digit2', 50], 3: ['Digit3', 51], ' ': ['Space', 32] };
  const key = (k, type) => send('Input.dispatchKeyEvent', { type, key: k, code: KEYS[k][0], windowsVirtualKeyCode: KEYS[k][1], nativeVirtualKeyCode: KEYS[k][1] });
  const tap = async (k) => { await key(k, 'keyDown'); await sleep(70); await key(k, 'keyUp'); };
  const mouse = (type) => send('Input.dispatchMouseEvent', { type, x: 550, y: 500, button: 'left', clickCount: 1 });

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&rec=1' + extra });
  let session = null;
  for (let t = 0; t < 360 * TIMEOUT_SCALE; t++) {
    session = await ev('Module.se1Playtest ? Module.se1Playtest.session : null');
    if (session && await ev('Module._SE1_WantPointer ? Module._SE1_WantPointer() : 0') === 1) break;
    await sleep(250);
  }
  console.log('session ' + session);
  await mouse('mousePressed'); await mouse('mouseReleased');   // capture the mouse
  // the bot looks through SE1_TouchLook (an assisted input), so the aim assist on high pulls it onto
  // monsters and widens its bullets: without that a random sweep never hits anything
  await ev('Module._SE1_SetAimAssist && Module._SE1_SetAimAssist(3); 1');
  const start = Date.now();
  let held = null, firing = false, nextTurn = 0, ended = false;
  while ((Date.now() - start) / 1000 < maxS) {
    const s = JSON.parse(await ev(`JSON.stringify({ offer: !!Module.se1SurvivorsOffer, chest: !!Module.se1SurvivorsChestMsg,
      end: !!Module.se1SurvivorsEnd, want: Module._SE1_WantPointer ? Module._SE1_WantPointer() : 0,
      hud: Module.se1SurvivorsLast && { time: Module.se1SurvivorsLast.time, level: Module.se1SurvivorsLast.level, kills: Module.se1SurvivorsLast.kills } })`) || '{}');
    if (s.end) { ended = true; break; }
    if (s.offer) {   // level-up: a random card
      if (held) { await key(held, 'keyUp'); held = null; }
      if (firing) { await mouse('mouseReleased'); firing = false; }
      await tap(String(1 + Math.floor(rand() * 3))); await sleep(400); continue;
    }
    if (s.chest) { await tap(' '); await sleep(600); continue; }
    if (s.want !== 1) { await sleep(300); continue; }
    if (Date.now() > nextTurn) {   // new walking direction
      if (held) await key(held, 'keyUp');
      held = ['w', 'w', 'a', 'd', 's'][Math.floor(rand() * 5)];
      await key(held, 'keyDown');
      nextTurn = Date.now() + 1500;
    }
    if (!firing) { await mouse('mousePressed'); firing = true; }
    // a slow sweep (mostly one way, so it scans around) that the assist can lock onto
    await ev(`Module._SE1_TouchLook && Module._SE1_TouchLook(${Math.round((rand() - 0.25) * 16)}, ${Math.round((rand() - 0.5) * 4)}); 1`);
    await sleep(150);
    if (Math.random() < 0.02) console.log(`  t ${s.hud && s.hud.time}  level ${s.hud && s.hud.level}  kills ${s.hud && s.hud.kills}`);
  }
  if (held) await key(held, 'keyUp');
  if (firing) await mouse('mouseReleased');
  console.log(ended ? 'run ended' : 'time limit reached');
  if (!ended) await ev(`Module.se1PlaytestSurvey && Module.se1PlaytestSurvey('bot time limit'); 1`);
  // answer the survey (it opens 4 s after the run's end screen)
  for (let t = 0; t < 40 && !(await ev('!!document.querySelector("#rec-survey form")')); t++) await sleep(250);
  await ev(`(() => { const f = document.querySelector('#rec-survey form'); if (!f) return 0;
    f.querySelector('textarea[name=other]').value = 'bot'; f.requestSubmit(); return 1; })()`);
  await sleep(5000);
  console.log('done: data/playtests/' + session);
} catch (e) {
  console.log('bot failed: ' + e.message); code = 1;
} finally {
  chrome.kill();
}
process.exit(code);
