#!/usr/bin/env node
// "Serious Survivors" mode test (rust/se1-mod/src/survivors.rs + port/web/survivors.js).
// Loads ?mode=survivors&svauto=1&svxp=5 (no lobby, enough XP for an immediate level-up), then checks:
// the level-up offer appears and pauses the game, key 1 takes that card and resumes, monsters keep
// spawning; then the lobby without svauto, and Enter starting a run.
// Screenshots: <outdir>/sv-offer.png, sv-play.png, sv-lobby.png.
//
//   node tools/svtest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-sv')] = process.argv.slice(2);
if (!url) { console.error('usage: svtest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9950 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1sv-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
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
  const last = async () => JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsLast || null)')) || 'null');
  const offer = async () => JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsOffer || null)')) || 'null');
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outdir, f), Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  // a headless page has no focus, and the game pauses itself without focus/input: emulate focus
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svxp=5' });

  let o = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !o; t++) { await sleep(500); o = await offer(); }
  check('level-up offer appears', !!(o && o.cards.length >= 3), o ? `level ${o.level}, offer ${o.cards.map((c) => c.name).join(' / ')}` : 'no offer');
  const modal = await ev("(function(){var e=document.querySelector('#svv .modal');return e?getComputedStyle(e).display:'none'})()");
  check('cards are shown', modal === 'flex', `modal display ${modal}`);
  await shot('sv-offer.png');
  let m = await last();
  const t0 = m && m.time; await sleep(1500); const m2 = await last();
  check('game paused while choosing', m2 && Math.abs(m2.time - t0) < 0.3, `time ${t0} -> ${m2 && m2.time}`);

  const picked = o && o.cards[0].name;
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, nativeVirtualKeyCode: 49 });
  await sleep(3500 * TIMEOUT_SCALE);
  m = await last();
  check('upgrade taken and game resumed', !!(m && m.ranks.some((r) => r.name === picked) && m.time > t0 + 1 && !(await offer())), m ? `ranks ${m.ranks.map((r) => r.name + ' ' + r.rank).join(', ')}, time ${m.time}` : 'none');
  await sleep(8000 * TIMEOUT_SCALE);
  m = await last();
  check('monsters spawn around the player', !!(m && (m.alive > 0 || m.kills > 0)), m ? `alive ${m.alive}, kills ${m.kills}, level ${m.level}` : 'none');
  await shot('sv-play.png');
  // the lobby (no svauto): start screen, then a run starts with Enter
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors' });
  let lobby = false;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !lobby; t++) { await sleep(500); lobby = await ev("!!(document.querySelector('#svv .lobby') && getComputedStyle(document.querySelector('#svv .modal')).display === 'flex')"); }
  check('lobby shows', lobby, lobby ? 'character, difficulty and shop' : 'no lobby');
  await shot('sv-lobby.png');
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(4000 * TIMEOUT_SCALE);
  m = await last();
  check('Enter starts a run', !!(m && m.state === 'run' && m.time > 1), m ? `state ${m.state}, time ${m.time}` : 'no HUD');
  // abilities (Consecration, Chain Lightning, Sirian Missiles, Arcane Explosion, Rain of Fire at rank 5)
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svtime=200&svgive=15872' });
  m = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !(m && m.time > 215); t++) { await sleep(500); m = await last(); }
  const hits = await ev('Module.se1SurvivorsHits || 0');
  check('abilities hit and kill', !!(m && m.kills > 0 && hits > 0), m ? `${m.kills} kills, ${hits} damage numbers, level ${m.level}` : 'no HUD');
  await shot('sv-abilities.png');
  // evolution: Revolver V + Fleet Foot + a chest after 10:00 = High Noon
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svtime=600&svgive=32770&svchest=1' });
  let c = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !c; t++) { await sleep(500); c = JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsChestMsg || null)')) || 'null'); }
  check('chest evolves a maxed gun', !!(c && c.items.some((i) => i.evo && i.name === 'High Noon')), c ? c.items.map((i) => i.name).join(', ') : 'no chest');
  await sleep(2000);
  await shot('sv-chest.png');
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
