#!/usr/bin/env node
// Archipelago end-to-end test: build the APWorld, generate a 1-player multiworld, host it with the
// AP server, open the game in the se1d daemon, pick up the "Single Shotgun 2" location in
// Hatshepsut, and check that the location check reaches the server and the item from that
// location comes back and is applied. Design notes: notes/archipelago.md.
//
// The game server must already be running: node tools/dev.mjs serve full.
//
//   node tools/aptest.mjs [--base URL] [--ap DIR] [--port N] [--keep]
//     --base   game page base (default http://127.0.0.1:8096/serioussam.html)
//     --ap     Archipelago source checkout with .venv/bin/python (default ~/code/repos/Archipelago)
//     --port   AP server port (default 38281)
//     --keep   leave the se1d session open at the end
//
// Exits 1 on any failure; logs go to data/dev/aptest/<time>/.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(args, name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  if (name === '--keep') return true;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node tools/aptest.mjs [--base URL] [--ap DIR] [--port N] [--keep]\n' +
    '  end-to-end headless test of the Archipelago client (see notes/archipelago.md)\n' +
    '  --base URL   game page base (default http://127.0.0.1:8096/serioussam.html; server must run)\n' +
    '  --ap DIR     Archipelago checkout with .venv/bin/python (default ~/code/repos/Archipelago)\n' +
    '  --port N     AP server port (default 38281)\n' +
    '  --keep       leave the se1d session open at the end');
  process.exit(0);
}
const BASE = flag(args, '--base', 'http://127.0.0.1:8096/serioussam.html');
const AP = flag(args, '--ap', join(homedir(), 'code/repos/Archipelago'));
const PORT = Number(flag(args, '--port', '38281'));
const KEEP = flag(args, '--keep', false);
const SE1D = `http://127.0.0.1:${process.env.SE1D_PORT || 9230}`;
const OUT = join(ROOT, 'data/dev/aptest', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(OUT, { recursive: true });

const log = (s) => console.log(`aptest: ${s}`);
let server = null, done = false;
async function fail(reason) {
  if (done) process.exit(1);
  done = true;
  console.log(`aptest: FAIL ${reason}`);
  await cleanup();
  process.exit(1);
}
async function cleanup() {
  if (server) {
    server.kill('SIGTERM');
    const t = setTimeout(() => server.kill('SIGKILL'), 3000);
    await Promise.race([new Promise((r) => server.on('exit', r)), sleep(3500)]);
    clearTimeout(t);
  }
  if (!KEEP) try { await fetch(`${SE1D}/quit`); } catch {}
}
process.on('SIGINT', () => { cleanup().then(() => process.exit(1)); });

// se1d HTTP API: api(route, params, body) -> parsed JSON (POST when body given)
async function api(route, params = {}, body) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();
  const r = await fetch(`${SE1D}/${route}${qs ? '?' + qs : ''}`, body !== undefined ? { method: 'POST', body } : {});
  if (r.status !== 200) throw new Error(`${route}: HTTP ${r.status}`);
  return r.json();
}
const wait = async (re, timeout, since) => {
  const r = await api('wait', { re, timeout, since });
  if (!r.ok) throw new Error(`timed out (${timeout} s) waiting for /${re}/`);
  log(`log: ${r.line}`);
};

try {
  log(`out: ${OUT}`);
  const apvenv = join(AP, '.venv/bin/python');
  if (!existsSync(apvenv)) throw new Error(`no ${apvenv}`);

  // 1. build the APWorld
  log('building APWorld');
  execFileSync('python3', ['archipelago/build_apworld.py'], { cwd: ROOT, stdio: 'inherit' });
  mkdirSync(join(AP, 'custom_worlds'), { recursive: true });
  writeFileSync(join(AP, 'custom_worlds/serioussam_tfe.apworld'),
    readFileSync(join(ROOT, 'archipelago/dist/serioussam_tfe.apworld')));

  // 2. generate a 1-player multiworld
  log('generating multiworld (seed 1)');
  const genLog = join(OUT, 'generate.log');
  let genOut = '';
  try {
    genOut = execFileSync(apvenv, ['Generate.py', '--player_files_path', join(ROOT, 'archipelago/players'),
      '--outputpath', OUT, '--seed', '1'], { cwd: AP, stdio: 'pipe', timeout: 180e3 });
  } catch (e) {
    genOut = String(e.stdout || '') + String(e.stderr || '');
    throw new Error(`Generate.py failed: ${e.message}`);
  }
  writeFileSync(genLog, genOut.toString());
  const zip = readdirSync(OUT).find((f) => /^AP_.*\.zip$/.test(f));
  if (!zip) throw new Error('no AP_*.zip in ' + OUT);
  log(`world: ${zip}`);

  // 3. spoiler: the item for our location
  let EXPECTED = null;
  try {
    const spoiler = execFileSync('unzip', ['-p', join(OUT, zip), '*Spoiler.txt'], { cwd: AP }).toString();
    const m = spoiler.match(/^Hatshepsut: Single Shotgun 2(?: \([^)]*\))?: (.+?)(?: \([^)]*\))?\s*$/m);
    if (m) EXPECTED = m[1];
  } catch {}
  if (EXPECTED) log(`expected item for Hatshepsut: Single Shotgun 2: ${EXPECTED}`);
  else log('warning: no spoiler found; any received item will pass');

  // 4. AP server
  log(`starting AP server on port ${PORT}`);
  const serverLog = join(OUT, 'server.log');
  server = spawn(apvenv, ['MultiServer.py', '--port', String(PORT), '--disable_save', join(OUT, zip)],
    { cwd: AP, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (b) => { try { appendFileSync(serverLog, b); } catch {} };
  server.stdout.on('data', append);
  server.stderr.on('data', append);
  for (let t = 0; t < 60; t++) {
    if (existsSync(serverLog) && readFileSync(serverLog, 'utf8').includes('Hosting game at')) break;
    await sleep(1000);
  }
  if (!readFileSync(serverLog, 'utf8').includes('Hosting game at')) throw new Error('AP server did not start in 60 s (see ' + serverLog + ')');
  log('AP server up');

  // 5. se1d: start the daemon, open the game
  execFileSync(process.execPath, ['tools/se1d.mjs', 'status'], { cwd: ROOT, stdio: 'inherit' });
  log('opening the game');
  const open = await api('open', { url: `${BASE}?ap=127.0.0.1:${PORT}&slot=Sam&level=Levels/01_Hatshepsut.wld&mute=1` });
  if (!open.ready) throw new Error(`game not ready: ${JSON.stringify(open.errors)}`);
  const FROM = open.from;

  // 6. play: skip the intro, teleport to the pickup, touch it
  await wait('\\[ap\\] connected as Sam', 60, FROM);
  await wait('Saved game', 120, FROM);
  for (let i = 0; i < 5; i++) {
    await api('eval', {}, 'Module._SE1Mod_DebugSkipIntro()');
    await sleep(2000);
  }
  log('teleporting to the Single Shotgun 2 pickup (entity 1402)');
  await api('eval', {}, 'Module._SE1Mod_DebugTeleport(-21, 32.5, -415); Module._SE1Mod_DebugTouch(1402)');
  await wait('ap: check 5341003', 20, FROM);
  await wait('\\[ap\\] check sent .*5341003', 20, FROM);
  const reItem = 'ap: received ' + (EXPECTED ? EXPECTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '');
  await wait(reItem, 30, FROM);
  log(`item received${EXPECTED ? ` and applied: ${EXPECTED}` : ''}`);

  // 7. inspect
  const state = await api('eval', {}, 'JSON.stringify(Module.se1ApClient)');
  log('ap client state: ' + state.value);
  const logLines = await api('log', { since: FROM, grep: '^(ap|\\[ap\\]|!! )' });
  for (const l of logLines.lines) console.log(l);

  done = true;
  log(`PASS (logs in ${OUT})`);
  await cleanup();
  process.exit(0);
} catch (e) {
  await fail(e.message);
}
