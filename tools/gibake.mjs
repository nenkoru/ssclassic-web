#!/usr/bin/env node
// gibake: prebake global illumination (port/common/Se1GI.cpp) for whole levels, through se1d.
//
//   node tools/gibake.mjs [--cell 0.5] [--rays 256] [--bounces 3] [--threads 4] [--sky 0] Levels/12_Karnak.wld ...
//
// Needs a dev server for a build with Se1GI and the level's data that also takes the uploads
// (tools/devserver.py: POST /__gi/... -> data/gi/...), as SE1D_BASE, e.g.
//   python3 tools/devserver.py --port 8142 build-gi &
//   SE1D_PORT=9242 SE1D_BASE=http://127.0.0.1:8142/serioussam.html node tools/gibake.mjs Levels/KarnakDemo.wld
// Per level: open it, wait until it has started, GI_Compute(); GI_Save(); and post the bytes, which
// land in data/gi/Levels/<name>.gi. Install them as <data dir>/GI/Levels/<name>.gi and relink: the
// engine loads GI/<world path>.gi when the world loads (gi_bLoad). The console's GI: lines go
// to data/gi/bake-log.txt. Uses the one-Chrome lock (tools/chrome.mjs) through se1d; quits se1d at the end.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SE1D_PORT) || 9230;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cell = Number(opt('--cell', '0.5')), rays = Number(opt('--rays', '256')), bounces = Number(opt('--bounces', '3'));
const threads = Number(opt('--threads', '4')), sky = Number(opt('--sky', '0'));
const levels = args.filter((a) => /\.wld$/i.test(a));
if (!levels.length) {
  console.error('usage: node tools/gibake.mjs [--cell M] [--rays N] [--bounces N] [--threads N] [--sky F] Levels/<name>.wld ...');
  process.exit(2);
}
if (threads > 4) console.warn('gibake: more than 4 threads; the Mac has rebooted under load before');

const logFile = join(ROOT, 'data/gi/bake-log.txt');
mkdirSync(dirname(logFile), { recursive: true });
const log = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };

function se1d(...a) {
  // the CLI starts the daemon on first use (idle limit raised: one bake can take long)
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/se1d.mjs'), ...a], {
    encoding: 'utf8', env: { ...process.env, SE1D_IDLE: process.env.SE1D_IDLE || '240' } });
  if (r.status !== 0) throw new Error(`se1d ${a[0]} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}
async function api(route, params = {}, body) {
  const u = new URL(`http://127.0.0.1:${PORT}/${route}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { method: body === undefined ? 'GET' : 'POST', body });
  return r.json();
}
const next = async () => (await api('log', { tail: 1 })).next;

log(`== gibake ${new Date().toISOString()} cell ${cell} m, ${rays} rays, ${bounces} bounces, ${threads} threads, sky ${sky}`);
let failed = 0;
for (const level of levels) {
  const t0 = Date.now();
  const opened = JSON.parse(se1d('open', `?args=${encodeURIComponent('+level ' + level)}`));
  if (!opened.ready) { log(`${level}: page not ready`); failed++; continue; }
  const started = await api('wait', { re: 'started\\.', since: opened.from, timeout: 600 });
  if (!started.ok) { log(`${level}: the level did not start`); failed++; continue; }
  await sleep(3000);   // let the first frames run (entities settle, shadow maps prepared)
  const from = await next();
  await api('cmd', { ms: 300 }, `gi_iThreads=${threads}; gi_fCellSize=${cell}; gi_iRays=${rays}; gi_iBounces=${bounces}; gi_fSky=${sky}; GI_Compute(); GI_Save();`);
  const done = await api('wait', { re: 'GI: (saved|nothing baked)', since: from, timeout: 4 * 3600 });
  const out = await api('log', { since: from, grep: '^GI: ' });
  for (const l of out.lines) log(`${level}: ${l.split('\t')[1]}`);
  if (!done.ok || !/saved/.test(done.line)) { log(`${level}: bake failed`); failed++; continue; }
  const dest = level.replace(/\\/g, '/').replace(/\.wld$/i, '.gi');
  const up = await api('eval', {}, `(async () => {
    const p = Module._SE1GI_BlobData(), n = Module._SE1GI_BlobSize();
    if (!p || !n) return 'no blob';
    const b = Module.HEAPU8.slice(p, p + n);
    if (b.length !== n) return 'short read ' + b.length + ' of ' + n;
    const r = await fetch('/__gi/${dest}', { method: 'POST', body: b });
    Module._SE1GI_BlobFree();
    return r.status + ' ' + n;
  })()`);
  if (!/^204 /.test(String(up.value))) { log(`${level}: upload failed: ${JSON.stringify(up)}`); failed++; continue; }
  log(`${level}: -> data/gi/${dest} (${up.value.split(' ')[1]} bytes), ${((Date.now() - t0) / 1000).toFixed(0)} s with load`);
}
se1d('quit');
log(`== gibake done, ${levels.length - failed}/${levels.length} levels`);
process.exit(failed ? 1 : 0);
