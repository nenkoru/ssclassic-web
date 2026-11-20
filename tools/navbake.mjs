#!/usr/bin/env node
// Bake the bots' nav graphs (notes/bots.md, "Baked nav graphs"): for each level, open it in headless
// Chrome with ?navbake=1, wait for the mod to map the whole level (rust/se1-mod/src/bots/runtime.rs,
// `bake`), read the graph from the page's in-memory filesystem and write it under the game data
// folder as Nav/Levels/<level>.nav. The next build packages it, and bots load it at level start.
//
//   node tools/navbake.mjs <url> <data dir> [--jobs N] [level.wld ...]
//   node tools/navbake.mjs http://127.0.0.1:8096/serioussam.html data/tfe-full-web Levels/01_Hatshepsut.wld
//
// With no levels it bakes every Levels/*.wld in the data dir (not Levels/Deathmatch etc.).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const argv = process.argv.slice(2);
let jobs = 2;
const ji = argv.indexOf('--jobs');
if (ji >= 0) { jobs = Math.max(1, +argv[ji + 1] || 1); argv.splice(ji, 2); }
const [url, dataDir, ...given] = argv;
if (!url || !dataDir) { console.error('usage: navbake.mjs <url> <data dir> [--jobs N] [level.wld ...]'); process.exit(2); }
const levels = given.length ? given
  : readdirSync(join(dataDir, 'Levels')).filter((f) => f.endsWith('.wld')).sort().map((f) => `Levels/${f}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the same mapping as runtime.rs `nav_file`
const navFile = (world) => `Nav/${world.replace(/\\/g, '/').replace(/\.wld$/, '')}.nav`;

async function bake(level, slot) {
  const port = 9600 + slot * 7 + Math.floor(Math.random() * 7);
  const profile = tempProfile('se1nav-');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=800,600', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const t0 = Date.now();
  try {
    let ws;
    for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
      try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); }
      catch { await sleep(200); }
    }
    if (!ws) throw new Error('no Chrome page');
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map(); const msgs = []; const errors = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || '').split('\n')[0]);
      if (d.method === 'Runtime.consoleAPICalled') {
        const s = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^\[se1mod\]\s*/, '');
        if (s.startsWith('se1mod: nav bake')) console.log(`[${level}] ${s}`);
        msgs.push(s);
      }
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    };
    const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable'); await send('Page.enable');
    // a headless page has no focus, and the game pauses itself without focus: emulate it
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const sep = url.includes('?') ? '&' : '?';
    await send('Page.navigate', { url: `${url}${sep}navbake=1&mute=1&args=${encodeURIComponent(`+level ${level}`)}` });

    // loading takes a while, the bake itself a minute or more on a big level
    let done = null;
    for (let t = 0; t < 1800 * TIMEOUT_SCALE && !done; t++) {
      await sleep(1000);
      done = msgs.find((m) => /^se1mod: nav (baked|bake failed):/.test(m));
      if (errors.length) throw new Error(`page error: ${errors[0]}`);
    }
    if (!done) throw new Error('no `se1mod: nav baked` line in 30 min');
    if (done.includes('bake failed')) throw new Error(done);
    const path = done.match(/^se1mod: nav baked: (\S+)/)[1];
    // read it in slices: one CDP message for a multi-megabyte file is asking for trouble
    const size = await ev(`Module.FS.stat(${JSON.stringify(path)}).size`);
    const parts = [];
    const SLICE = 1 << 20;
    for (let o = 0; o < size; o += SLICE) {
      parts.push(Buffer.from(await ev(`(function(){var b=Module.FS.readFile(${JSON.stringify(path)}).subarray(${o},${o + SLICE});var s='';for(var i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));return btoa(s);})()`), 'base64'));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== size || bytes.subarray(0, 6).toString() !== 'SE1NAV') throw new Error(`read ${bytes.length} of ${size} bytes`);
    const out = join(dataDir, navFile(level));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    console.log(`[${level}] wrote ${out} (${(size / 1e6).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return true;
  } catch (e) {
    console.log(`[${level}] FAILED: ${e.message}`);
    return false;
  } finally {
    await closeChrome(chrome, profile);
  }
}

const queue = [...levels];
let failed = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async (_, slot) => {
  while (queue.length) if (!(await bake(queue.shift(), slot))) failed++;
}));
console.log(`${levels.length - failed} of ${levels.length} levels baked`);
process.exit(failed ? 1 : 0);
