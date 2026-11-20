#!/usr/bin/env node
// Co-op bot test (rust/se1-mod/src/bots). Loads ?mode=survivors&svauto=1&svgod=1&mute=1&bots=2
// (single player: the engine adds the bots on the host too) and reads the engine's
// `se1mod: bots` console log lines to check: two bots join, they move, one fights, the nav
// graph builds (more than 100 nodes), the human stays put, and no exceptions are thrown;
// then a reload with bots=0 shows no bots.
//
//   node tools/bottest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-bots')] = process.argv.slice(2);
if (!url) { console.error('usage: bottest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9950 + Math.floor(Math.random() * 40);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1bots-')}`,
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
  let id = 0; const pend = new Map(); const errors = []; const consoleMsgs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled' && ['log', 'error', 'warn'].includes(d.params.type)) {
      // the engine prints mod logs as "[se1mod] se1mod: ...": keep the part from "se1mod:" on
      consoleMsgs.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^\[se1mod\]\s*/, ''));
    }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const last = async () => JSON.parse((await ev('JSON.stringify(Module.se1SurvivorsLast || null)')) || 'null');
  // one `se1mod: bots: <n> [<id> <state> hp <hp> at <x> <z>; ...]` line
  const botsLine = (msgs) => msgs.filter((m) => m.startsWith('se1mod: bots: ')).at(-1) || '';
  const botAt = (msgs, bid) => {
    const m = (typeof msgs === 'string' ? msgs : botsLine(msgs)).match(new RegExp(`\\[${bid}\\s+\\w+\\s+hp\\s+\\S+\\s+at\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)`));
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };
  await send('Runtime.enable'); await send('Page.enable');
  // a headless page has no focus, and the game pauses itself without focus/input: emulate focus
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mode=survivors&svauto=1&svgod=1&mute=1&bots=2' });

  // the bots join once a human is in the level (2/s log cadence)
  let joined = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !joined; t++) {
    await sleep(500);
    const l = botsLine(consoleMsgs);
    const m = l.match(/^se1mod: bots: (\d+) \[/);
    if (m && +m[1] === 2) joined = l;
  }
  check('bots joined', !!joined, joined || 'no `se1mod: bots: 2 [` line in 120 s');

  // nav graph built around the player (a few hundred thousand rays, at most 4 ms of them a tick:
  // a couple of minutes on a big map)
  let nav = null;
  for (let t = 0; t < 480 * TIMEOUT_SCALE && !nav; t++) {
    nav = consoleMsgs.find((m) => /^se1mod: bots nav ready: (\d+) nodes/.test(m));
    if (!nav) await sleep(500);
  }
  const navN = nav ? parseInt(nav.match(/^se1mod: bots nav ready: (\d+)/)[1], 10) : 0;
  check('nav built', navN > 100, nav || `no nav-ready line (saw ${navN} nodes)`);

  // each bot got more than 5 m from where it joined, in any log line since: they follow a player
  // who stands still, so most of their walking can happen while the nav is still being built
  const ids = [...new Set([...botsLine(consoleMsgs).matchAll(/\[(\d+)\s/g)].map((m) => +m[1]))];
  const moved = [];
  for (const bid of ids) {
    const first = joined && botAt(joined, bid);
    for (let t = 0; t < 120 * TIMEOUT_SCALE && first && !moved.includes(bid); t++) {
      const far = consoleMsgs.filter((m) => m.startsWith('se1mod: bots: ')).map((l) => botAt(l, bid))
        .some((p) => p && Math.hypot(p[0] - first[0], p[1] - first[1]) > 5);
      if (far) moved.push(bid); else await sleep(500);
    }
  }
  check('bots move', ids.length > 0 && moved.length === ids.length, moved.length ? `bots ${moved.join(', ')} moved > 5 m` : 'no bot moved > 5 m');

  // some bot is in the Fight state
  let fight = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !fight; t++) {
    await sleep(500);
    fight = botsLine(consoleMsgs).match(/\[\d+\s+Fight\b/)?.[0] || null;
  }
  check('bots fight', !!fight, fight ? `bot state Fight (${fight})` : 'no bot in Fight state');

  // the human does not move in this test: the HUD pos stays within 3 m of its first value
  let h0 = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !h0; t++) { await sleep(500); h0 = (await last())?.pos || null; }
  await sleep(10000);   // the bots keep playing meanwhile
  const h1 = (await last())?.pos || null;
  const hd = h0 && h1 ? Math.hypot(h1[0] - h0[0], h1[2] - h0[2]) : Infinity;
  check('human unaffected', hd <= 3, `pos ${h0 ? h0.map((v) => v.toFixed(1)).join(',') : 'none'} -> ${h1 ? h1.map((v) => v.toFixed(1)).join(',') : 'none'} (d ${hd === Infinity ? 'n/a' : hd.toFixed(1)})`);
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
  // on a failure, the last status lines say what the bots were doing
  if (failed) console.log(consoleMsgs.filter((m) => /^se1mod: bots/.test(m)).slice(-4).map((m) => '  ' + m.slice(0, 400)).join('\n'));

  // off by default: a reload with bots=0 never logs bots > 0
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&bots=0' });
  const n0 = consoleMsgs.length;
  let hud = null;
  for (let t = 0; t < 120 * TIMEOUT_SCALE && !hud; t++) { await sleep(500); hud = await last(); }
  await sleep(30 * TIMEOUT_SCALE);
  const off = consoleMsgs.slice(n0).some((m) => /^se1mod: bots: (\d+) \[/.test(m) && +m.match(/^se1mod: bots: (\d+)/)[1] > 0);
  check('off by default', !!hud && !off, off ? 'bots > 0 logged with bots=0' : 'no bots logged with bots=0');
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
