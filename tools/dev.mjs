#!/usr/bin/env node
// One CLI for the dev loop: background dev servers, builds, and a status page of what is running,
// what is stale and what was played.
//
//   node tools/dev.mjs status                 servers, stale builds, headless Chromes and the
//                                             Chrome lock, git, new play sessions
//   node tools/dev.mjs serve <name...>        start dev servers in the background (names below)
//   node tools/dev.mjs stop <name...|all>     stop them
//   node tools/dev.mjs logs <name> [-n N]     the last N lines of a server's log
//   node tools/dev.mjs build <name|dir...>    ninja -C <build dir>
//   node tools/dev.mjs urls                   handy game URLs on the `full` server
//
// Pid files: data/dev/run/<name>.pid; logs: data/dev/logs/<name>.log (data/ is not committed).
// A build is STALE when a git-tracked source under rust/se1-mod, port/ or src/, or a file of its
// data dir, is newer than its serioussam.wasm (`ninja -n` can't tell: it always lists the cargo
// and link steps).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devserver = (port, dir) => ({ cmd: ['python3', 'tools/devserver.py', '--port', String(port), dir], port, build: dir,
  url: `http://127.0.0.1:${port}/serioussam.html`, ready: 15 });
const SERVICES = {
  full: devserver(8096, 'build-web-tfe-full'),   // full TFE data, threaded: what is played
  mt: devserver(8094, 'build-web-tfe-mt'),       // demo data, threaded: what the tests use
  rel: devserver(8092, 'build-web-tfe-rel'),
  web: devserver(8090, 'build-web-tfe'),         // single-threaded (JSPI)
  // the public page: no game data, the player imports their folder (notes/user-data.md)
  pub: { ...devserver(8088, 'build-pub-mt/byod'), build: 'build-pub-mt', target: 'serioussam_byod' },
  switch: { cmd: ['cargo', 'run', '-p', 'se1-server', '--release'], cwd: 'rust', port: 9002, url: 'ws://127.0.0.1:9002', ready: 300 },
  se1d: { cmd: ['node', 'tools/se1d.mjs', 'serve'], port: 9230, url: 'http://127.0.0.1:9230/status', ready: 15 },
};
const BUILDS = ['build-web-tfe-full', 'build-web-tfe-mt', 'build-web-tfe-rel', 'build-web-tfe', 'build-test-mt', 'build-test-st', 'build-pub-mt/byod', 'build-pub-st/byod'];
const RUN = join(ROOT, 'data/dev/run'), LOGS = join(ROOT, 'data/dev/logs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pidFile = (name) => join(RUN, `${name}.pid`);
const logFile = (name) => join(LOGS, `${name}.log`);
const readPid = (name) => { try { return Number(readFileSync(pidFile(name), 'utf8')) || 0; } catch { return 0; } };
const ago = (ms) => ms < 90e3 ? `${Math.round(ms / 1e3)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : ms < 48 * 3600e3 ? `${(ms / 3600e3).toFixed(1)} h` : `${Math.round(ms / 86400e3)} d`;
const portOpen = (port) => new Promise((r) => {
  const s = connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); r(true); });
  s.once('error', () => r(false));
  s.setTimeout(500, () => { s.destroy(); r(false); });
});
function tail(file, n) {
  try { return readFileSync(file, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l).slice(-n).join('\n'); }
  catch { return '(no log)'; }
}
function unknown(names) {
  const bad = names.filter((n) => !SERVICES[n]);
  if (bad.length) { console.error(`unknown service: ${bad.join(', ')} (known: ${Object.keys(SERVICES).join(', ')})`); process.exit(2); }
}

async function serve(names) {
  unknown(names);
  mkdirSync(RUN, { recursive: true }); mkdirSync(LOGS, { recursive: true });
  let failed = 0;
  for (const name of names) {
    const s = SERVICES[name], pid = readPid(name), open = await portOpen(s.port);
    if (pid && alive(pid) && open) { console.log(`${name}: already running (pid ${pid}) ${s.url}`); continue; }
    if (open) { console.log(`${name}: port ${s.port} is in use by another process`); failed++; continue; }
    if (s.build && !existsSync(join(ROOT, s.build, 'serioussam.html'))) {
      console.log(`${name}: ${s.build}/serioussam.html missing, build it first (node tools/dev.mjs build ${name})`); failed++; continue;
    }
    appendFileSync(logFile(name), `--- ${new Date().toISOString()} serve ${name}: ${s.cmd.join(' ')}\n`);
    const out = openSync(logFile(name), 'a');
    const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: join(ROOT, s.cwd || '.'), detached: true, stdio: ['ignore', out, out] });
    child.unref();
    writeFileSync(pidFile(name), String(child.pid));
    let up = false;
    for (const end = Date.now() + s.ready * 1000; Date.now() < end && alive(child.pid);) {
      if (await portOpen(s.port)) { up = true; break; }
      await sleep(250);
    }
    if (up) console.log(`${name}: up (pid ${child.pid}) ${s.url}`);
    else {
      console.log(`${name}: ${alive(child.pid) ? `not listening on ${s.port} after ${s.ready} s` : 'exited'}; last log lines:\n${tail(logFile(name), 20)}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

async function stop(names) {
  if (names.includes('all')) names = Object.keys(SERVICES).filter((n) => existsSync(pidFile(n)));
  else unknown(names);
  for (const name of names) {
    const pid = readPid(name);
    if (!pid || !alive(pid)) { rmSync(pidFile(name), { force: true }); console.log(`${name}: not running`); continue; }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
    if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    rmSync(pidFile(name), { force: true });
    console.log(`${name}: stopped`);
  }
  return 0;
}

// newest mtime among files: [mtimeMs, path]
function newest(files) {
  let best = [0, ''];
  for (const f of files) { try { const m = statSync(f).mtimeMs; if (m > best[0]) best = [m, f]; } catch {} }
  return best;
}
function walk(dir, out = []) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function buildStatus() {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'rust/se1-mod', 'rust/se1-host', 'port', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0').filter(Boolean).map((f) => join(ROOT, f));
  const [srcM, srcF] = newest(tracked);
  const lines = [];
  for (const b of BUILDS) {
    const dir = join(ROOT, b);
    if (!existsSync(dir)) continue;
    const root = join(ROOT, b.split('/')[0]);   // <build>/byod: the cache is in the build dir
    let wasm;
    try { wasm = statSync(join(dir, 'serioussam.wasm')).mtimeMs; } catch { lines.push(`  ${b.padEnd(20)} not built`); continue; }
    let [m, f] = [srcM, srcF];
    const data = (readFileSync(join(root, 'CMakeCache.txt'), 'utf8').match(/^DATA_DIR:[A-Z]+=(.*)$/m) || [])[1];
    if (data && existsSync(data)) { const [dm, df] = newest(walk(data)); if (dm > m) [m, f] = [dm, df]; }
    const age = ago(Date.now() - wasm);
    lines.push(m > wasm
      ? `  ${b.padEnd(20)} STALE      built ${age} ago; ${relative(ROOT, f)} is ${ago(m - wasm)} newer`
      : `  ${b.padEnd(20)} up to date built ${age} ago`);
  }
  return lines;
}

function chromeStatus() {
  let ps = '';
  try { ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }); } catch {}
  const mains = ps.split('\n').filter((l) => /chrome/i.test(l) && l.includes('--headless') && !l.includes('--type='));
  const lines = [`  headless Chromes: ${mains.length}${mains.length > 1 ? '  (more than one: memory!)' : ''}`];
  const lock = join(tmpdir(), 'se1-chrome.lock');
  if (existsSync(lock)) {
    const [pid, cmd] = readFileSync(lock, 'utf8').split('\n');
    lines.push(`  Chrome lock: pid ${pid} (${alive(Number(pid)) ? 'alive' : 'dead: stale, the next tool takes it'}) ${cmd || ''}`);
  } else lines.push('  Chrome lock: free');
  return lines;
}

function gitStatus() {
  const g = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const changed = (g('status', '--porcelain') || '').split('\n').filter(Boolean).length;
  const ab = g('rev-list', '--left-right', '--count', '@{u}...HEAD');
  const [behind, ahead] = ab ? ab.split(/\s+/) : ['?', '?'];
  return [`  ${g('branch', '--show-current')}: ${changed} changed file(s), ahead ${ahead}, behind ${behind}`];
}

function playStatus() {
  const r = spawnSync('python3', ['tools/playtriage.py', '--inbox'], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return out ? out.split('\n').map((l) => '  ' + l) : ['  no new play sessions'];
}

async function status() {
  console.log('services:');
  for (const [name, s] of Object.entries(SERVICES)) {
    const pid = readPid(name), mine = pid && alive(pid), open = await portOpen(s.port);
    const state = mine && open ? `up    pid ${pid}` : open ? 'port busy (not ours)' : mine ? `starting? pid ${pid}` : 'down';
    console.log(`  ${name.padEnd(7)} ${state.padEnd(22)} ${s.url}`);
  }
  console.log('builds:'); for (const l of buildStatus()) console.log(l);
  console.log('chrome:'); for (const l of chromeStatus()) console.log(l);
  console.log('git:'); for (const l of gitStatus()) console.log(l);
  if (existsSync(join(ROOT, 'tools/playtriage.py'))) { console.log('plays:'); for (const l of playStatus()) console.log(l); }
  return 0;
}

function build(args) {
  for (const a of args) {
    const dir = SERVICES[a]?.build || a;
    const t0 = Date.now();
    const target = SERVICES[a]?.target;
    const r = spawnSync('ninja', ['-C', dir, ...(target ? [target] : [])], { cwd: ROOT, stdio: 'inherit' });
    console.log(`${dir}: ${r.status === 0 ? 'built' : 'FAILED'} in ${ago(Date.now() - t0)}`);
    if (r.status !== 0) return r.status || 1;
  }
  return 0;
}

function urls() {
  const base = SERVICES.full.url;
  const rows = [['menu', ''], ['bots', '?bots=3&args=%2Blevel%20Levels%2F01_Hatshepsut.wld'], ['survivors', '?mode=survivors&bots=3'],
    ['aimassist', '?aimassist=3'], ['gyro', '?gyrosens=2'], ['coop host', '?room=test&host=1'], ['coop join', '?room=test'],
    ['no recording', '?rec=0'], ['playtest+survey', '?rec=1']];
  for (const [k, q] of rows) console.log(`${k.padEnd(16)}${base}${q}`);
  return 0;
}

const USAGE = `usage: node tools/dev.mjs <command>
  status                    servers, stale builds, Chromes, git, new play sessions
  serve <name...>           start in the background: ${Object.keys(SERVICES).join(', ')}
  stop <name...|all>        stop them
  logs <name> [-n N]        last N (40) lines of a server's log
  build <name|dir...>       ninja -C <build dir> (name: a server's build)
  urls                      game URLs on the full server`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': console.log(USAGE); return 0;
    case 'status': return status();
    case 'serve': if (!args.length) break; return serve(args);
    case 'stop': if (!args.length) break; return stop(args);
    case 'logs': {
      if (!args[0]) break;
      unknown([args[0]]);
      const i = args.indexOf('-n');
      console.log(tail(logFile(args[0]), i >= 0 ? Number(args[i + 1]) || 40 : 40));
      return 0;
    }
    case 'build': if (!args.length) break; return build(args);
    case 'urls': return urls();
  }
  console.error(USAGE);
  return 2;
}
main().then((c) => process.exit(c));
