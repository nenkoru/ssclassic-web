#!/usr/bin/env node
// Bot navigation test (notes/bots.md, phase 3): bots roam a level on their own (?botroam=N: they
// ignore the players and walk to random points of the nav graph up to N m away) and the test reads
// how many of those goals they reach. Each bot's status line ends with `goals <reached>/<given up>`
// (rust/se1-mod/src/bots/brain.rs: a goal is given up after a timeout or being stuck three times).
//
//   node tools/navroamtest.mjs <url> [level.wld] [seconds]
//   node tools/navroamtest.mjs http://127.0.0.1:8096/serioussam.html Levels/01_Hatshepsut.wld 150
//
// Survivors mode gives a god-mode player in an arena; svcap=1 keeps its monsters away (a fight
// interrupts roaming).
//
// Checks: the level's baked graph is loaded, every bot reaches 5 goals or more, 85% of the goals
// are reached, and 3 of the 4 bots get 60 m from where they started. Hatshepsut, 2026-11-20:
// 93-95%, every bot past 100 m.
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, level = 'Levels/01_Hatshepsut.wld', secs = '150'] = process.argv.slice(2);
if (!url) { console.error('usage: navroamtest.mjs <url> [level.wld] [seconds]'); process.exit(2); }
const BOTS = 4, RADIUS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 40);
const profile = tempProfile('se1roam-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=800,600', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); }
    catch { await sleep(200); }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const errors = []; const msgs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled') msgs.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^\[se1mod\]\s*/, ''));
  };
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  send('Runtime.enable'); send('Page.enable');
  // a headless page has no focus, and the game pauses itself without focus: emulate it
  send('Emulation.setFocusEmulationEnabled', { enabled: true });
  send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  const sep = url.includes('?') ? '&' : '?';
  send('Page.navigate', { url: `${url}${sep}mode=survivors&svauto=1&svgod=1&svcap=1&mute=1&bots=${BOTS}&botroam=${RADIUS}&level=${encodeURIComponent(level)}` });

  // [<id> <state> hp <hp> at <x> <z> ... goals <reached>/<missed>]
  const bots = (line) => [...line.matchAll(/\[(\d+) \w+ hp \S+ at (-?\d+) (-?\d+) [^\]]*goals (\d+)\/(\d+)[^\]]*\]/g)]
    .map((m) => ({ id: +m[1], x: +m[2], z: +m[3], reached: +m[4], missed: +m[5] }));
  const statusLines = () => msgs.filter((m) => m.startsWith('se1mod: bots: '));
  let start = null;
  for (let t = 0; t < 180 * TIMEOUT_SCALE && !start; t++) {
    await sleep(1000);
    const l = statusLines().at(-1);
    if (l && bots(l).length === BOTS) start = l;
  }
  const nav = msgs.find((m) => m.startsWith('se1mod: bots nav ready:'));
  check('baked graph', !!nav && nav.includes('(baked)'), nav || 'no nav-ready line');
  check('bots joined', !!start, start ? `${BOTS} bots` : `no status line with ${BOTS} bots in 180 s`);
  if (start) {
    const from = new Map(bots(start).map((b) => [b.id, b]));
    const far = new Map();
    const until = Date.now() + +secs * 1000 * TIMEOUT_SCALE;
    while (Date.now() < until) {
      await sleep(2000);
      for (const b of bots(statusLines().at(-1) || '')) {
        const f = from.get(b.id);
        if (f) far.set(b.id, Math.max(far.get(b.id) || 0, Math.hypot(b.x - f.x, b.z - f.z)));
      }
    }
    const end = bots(statusLines().at(-1) || '');
    const r = end.reduce((s, b) => s + b.reached, 0), m = end.reduce((s, b) => s + b.missed, 0);
    for (const b of end) console.log(`  bot ${b.id}: goals reached ${b.reached}, given up ${b.missed}, farthest ${Math.round(far.get(b.id) || 0)} m from its start`);
    check('every bot reaches goals', end.length === BOTS && end.every((b) => b.reached >= 5), end.map((b) => `${b.id}: ${b.reached}`).join(', '));
    check('most goals reached', r + m > 0 && r / (r + m) >= 0.85, `${r} reached, ${m} given up (${Math.round(100 * r / Math.max(1, r + m))}%)`);
    check('bots spread out', [...far.values()].filter((d) => d >= 60).length >= BOTS - 1, [...far.values()].map((d) => `${Math.round(d)} m`).join(', '));
  }
  check('no exceptions', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await closeChrome(chrome, profile);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
