#!/usr/bin/env node
// Engine performance bench: one Chrome for the whole session, several builds compared run by run
// in alternation (A B A B ...), so machine noise hits them alike. For each scenario it reports the
// engine thread's CPU ms per frame (Module.se1Perf: work between resuming and the next swap).
//
//   node tools/perfbench.mjs [options] <url | label=url> ...
//     --scenarios demo,stress300   which scenarios (default demo,stress300)
//     --reps N                     runs per build and scenario (default 3)
//     --secs S                     measured window per run (default 5)
//     --profile DIR                one extra profiled run per build and scenario: the engine worker's
//                                  top self-time functions go to DIR/<label>-<scenario>.txt
//     --json FILE                  every run as JSON
//     --check                      behaviour oracle first: play the whole timedemo on every build with
//                                  ?simhash=1 (port/common/SimHash.cpp: the engine's sync checksum
//                                  of every entity, per game tick) and compare each build's ticks to
//                                  the first build's; a difference names the first tick that changed
//     --check-only                 only the check
//
// Scenarios (the demo builds: build-web-tfe-mt, build-test-*):
//   demo       the timedemo (bench.ini, Auto-Demo0001) uncapped: rendering and demo playback
//   stressN    Survivors with N monsters held around a god-mode player (?svstress=N), paced:
//              AI, ray casts, collision, path-finding, model animation (KarnakDemo on the demo data)
//   botsN[mM]  N co-op bots (server-side virtual players, rust/se1-mod/src/bots) and M Survivors
//              monsters (default 100) around a god-mode player, paced: the per-player cost (CPlayer
//              entities, weapons, actions, player models) on top of stressM; the bots' own AI (the
//              mod) shows separately in the profile. Bots join one per tick, so the settle time
//              grows with N (notes/perf/players.md)
//   menu       the main menu, uncapped (fixed costs)
//
// Prints per scenario: mean and median ms per frame for each build, the ratio to the first build,
// and the spread over the runs. The first URL is the baseline.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const args = process.argv.slice(2);
const opt = { scenarios: 'demo,stress300', reps: 3, secs: 5, profile: null, json: null, check: false };
const builds = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--check' || a === '--check-only') { opt.check = true; opt.checkOnly = a === '--check-only'; continue; }
  if (a.startsWith('--')) { opt[a.slice(2)] = args[++i]; continue; }
  const m = a.match(/^([\w.-]+)=(https?:.*)$/);
  builds.push(m ? { label: m[1], url: m[2] } : { label: String.fromCharCode(65 + builds.length), url: a });
}
if (!builds.length) { console.error('usage: perfbench.mjs [--scenarios demo,stress300] [--reps 3] [--secs 5] [--profile DIR] <url|label=url>...'); process.exit(2); }
const reps = +opt.reps, secs = +opt.secs;
const scenarios = opt.scenarios.split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withQ = (u, q) => u + (u.includes('?') ? '&' : '?') + q;

function scenarioSpec(name) {
  if (name === 'demo') return { q: 'bench=1&uncapped=1&mute=1', ready: `!!(window.__bench && window.__bench.state === 'running')`, settle: 0, timeout: 120000 };
  if (name === 'menu') return { q: 'uncapped=1&mute=1', ready: `typeof Module !== 'undefined' && !!Module.se1Perf && Module.se1Perf.n > 300`, settle: 2000, timeout: 120000 };
  const m = name.match(/^stress(\d+)(?:k(\d+))?$/);
  if (m) {
    const n = +m[1];
    return { q: `mute=1&spin=0&mode=survivors&svstress=${n}&svkind=${m[2] || 0}`, ready: `typeof Module !== 'undefined' && !!Module.se1SurvivorsLast && Module.se1SurvivorsLast.alive >= ${n}`, settle: 6000, timeout: 180000 };
  }
  const b = name.match(/^bots(\d+)(?:m(\d+))?$/);
  if (b) {
    const n = +b[1], mons = b[2] === undefined ? 100 : +b[2];
    return { q: `mute=1&spin=0&mode=survivors&svstress=${Math.max(mons, 1)}&bots=${n}`, ready: `typeof Module !== 'undefined' && !!Module.se1SurvivorsLast && Module.se1SurvivorsLast.alive >= ${Math.max(mons, 1)}`, settle: 8000 + n * 60, timeout: 180000 };
  }
  throw new Error('unknown scenario ' + name);
}

const port = 9700 + Math.floor(Math.random() * 50);
const profileDir = tempProfile('se1pb-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0, page = null;
const pend = new Map();
let workers = [];
const send = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, page);
  return r.result?.result?.value;
};

async function connect() {
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Target.attachedToTarget') {
      const ti = d.params.targetInfo, sid = d.params.sessionId;
      if (ti.type === 'worker') workers.push(sid);
      else if (ti.type === 'page' && !page) page = sid;
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
    }
    if (d.method === 'Target.detachedFromTarget') workers = workers.filter((w) => w !== d.params.sessionId);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const { result: { targetInfos } } = await send('Target.getTargets');
  const pg = targetInfos.find((t) => t.type === 'page');
  await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  for (let t = 0; t < 50 && !page; t++) await sleep(100);
  await send('Page.enable', {}, page);
  await send('Runtime.enable', {}, page);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, page);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' }, page);
}

async function profileStart() {
  for (const w of workers) {
    await send('Profiler.enable', {}, w);
    await send('Profiler.setSamplingInterval', { interval: 200 }, w);
    await send('Profiler.start', {}, w);
  }
}
async function profileStop() {
  let best = null;
  for (const w of workers) {
    const r = await send('Profiler.stop', {}, w);
    const p = r.result?.profile;
    if (!p) continue;
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const par = new Map(); for (const n of p.nodes) for (const ch of n.children || []) par.set(ch, n.id);
    const cnt = {}; for (const s of p.samples) cnt[s] = (cnt[s] || 0) + 1;
    const self = {}, incl = {}, callers = {}; let tot = 0;
    for (const [nid, k] of Object.entries(cnt)) {
      const n = byId.get(+nid);
      const nm = n.callFrame.functionName || '(anon)';
      if (nm === '(idle)' || nm === '(program)' || nm === '(garbage collector)') continue;
      // waiting, not working (SwapBuffers' self time is the inlined frame wait, WebFrame.cpp)
      if (/futex_wait|emscripten_futex|_emscripten_thread_sleep|do_sleep|nanosleep|SwapBuffers/.test(nm)) continue;
      self[nm] = (self[nm] || 0) + k; tot += k;
      const pf = par.get(+nid) && byId.get(par.get(+nid)).callFrame.functionName;
      const c = (callers[nm] = callers[nm] || {}); c[pf || '?'] = (c[pf || '?'] || 0) + k;
      const seen = new Set();
      for (let x = +nid; x; x = par.get(x)) {
        const f = byId.get(x).callFrame.functionName;
        if (f && !seen.has(f)) { seen.add(f); incl[f] = (incl[f] || 0) + k; }
      }
    }
    if (!best || tot > best.tot) best = { tot, self, incl, callers };
  }
  return best;
}
function profileText(b) {
  if (!b) return 'no profile\n';
  const fmt = (o, n) => Object.entries(o).sort((a, c) => c[1] - a[1]).slice(0, n).map(([nm, k]) => (100 * k / b.tot).toFixed(1).padStart(5) + '%  ' + nm).join('\n');
  const top = Object.entries(b.self).sort((a, c) => c[1] - a[1]).slice(0, 20);
  const calls = top.map(([nm, k]) => `${(100 * k / b.tot).toFixed(1).padStart(5)}%  ${nm}\n` +
    Object.entries(b.callers[nm]).sort((a, c) => c[1] - a[1]).slice(0, 5).map(([f, j]) => `          ${(100 * j / k).toFixed(0).padStart(3)}% from ${f}`).join('\n')).join('\n');
  return `busy samples ${b.tot} (waits excluded)\n\n== self\n${fmt(b.self, 60)}\n\n== inclusive\n${fmt(b.incl, 100)}\n\n== callers of the top 20\n${calls}\n`;
}

async function run(build, scen, profile) {
  const spec = scenarioSpec(scen);
  workers = [];
  await send('Page.navigate', { url: 'about:blank' }, page);
  await sleep(300);
  await send('Page.navigate', { url: withQ(build.url, spec.q) }, page);
  const end = Date.now() + spec.timeout * TIMEOUT_SCALE;
  let ok = false;
  while (Date.now() < end) {
    await sleep(250);
    try { if (await ev(spec.ready)) { ok = true; break; } } catch {}
  }
  if (!ok) throw new Error(`${build.label} ${scen}: not ready in time`);
  await sleep(spec.settle);
  if (profile) await profileStart();
  const r = JSON.parse(await ev(`(async () => {
    const P = Module.se1Perf, n0 = P.n, t0 = performance.now();
    await new Promise((ok) => setTimeout(ok, ${secs * 1000}));
    const n1 = P.n, s = (performance.now() - t0) / 1000;
    const w = []; for (let i = n0; i < n1; i++) w.push(P.work[i % 65536]);
    const sorted = w.slice().sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
    const sum = w.reduce((a, b) => a + b, 0);
    return JSON.stringify({ frames: n1 - n0, fps: (n1 - n0) / s, mean: w.length ? sum / w.length : null, p50: q(.5), p95: q(.95), busy: sum / (s * 1000),
      alive: Module.se1SurvivorsLast ? Module.se1SurvivorsLast.alive : null });
  })()`));
  if (profile) r.profile = await profileStop();
  return r;
}

// play the whole timedemo with ?simhash=1, return the per-tick hashes
async function simhash(build) {
  workers = [];
  await send('Page.navigate', { url: 'about:blank' }, page);
  await sleep(300);
  await send('Page.navigate', { url: withQ(build.url, 'bench=1&uncapped=1&mute=1&simhash=1') }, page);
  const end = Date.now() + 300000 * TIMEOUT_SCALE;
  let st = '';
  while (Date.now() < end) {
    await sleep(500);
    try { st = await ev(`window.__bench ? window.__bench.state : ''`); } catch {}
    if (st === 'done') break;
  }
  if (st !== 'done') throw new Error(`${build.label}: the demo did not finish`);
  return ev(`(() => { const n = Module._SE1_SimHashCount(), a = []; for (let i = 0; i < n; i++) a.push(Module._SE1_SimHashAt(i) >>> 0); return a; })()`);
}
async function check() {
  let base = null, ok = true;
  for (const b of builds) {
    const h = await simhash(b);
    if (!h || !h.length) { console.log(`check ${b.label}: no ticks hashed (build without SimHash.cpp?)`); ok = false; continue; }
    if (!base) { base = h; console.log(`check ${b.label}: ${h.length} ticks, final ${h[h.length - 1].toString(16)} (reference)`); continue; }
    const n = Math.min(base.length, h.length);
    let first = -1;
    for (let i = 0; i < n; i++) if (base[i] !== h[i]) { first = i; break; }
    if (first < 0 && base.length === h.length) console.log(`check ${b.label}: SAME simulation, ${h.length} ticks`);
    else { ok = false; console.log(`check ${b.label}: DIFFERENT simulation: ${first >= 0 ? `first at tick ${first} of ${n}` : `tick counts ${base.length} vs ${h.length}`}`); }
  }
  return ok;
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const all = [];
try {
  await connect();
  if (opt.check && !(await check())) process.exitCode = 1;
  for (const scen of opt.checkOnly ? [] : scenarios) {
    for (let rep = 0; rep < reps; rep++) {
      for (const b of builds) {
        const r = await run(b, scen, false);
        all.push({ build: b.label, scen, rep, ...r });
        console.error(`  ${scen.padEnd(10)} ${b.label.padEnd(8)} rep ${rep}: mean ${r.mean.toFixed(3)} p50 ${r.p50.toFixed(3)} p95 ${r.p95.toFixed(3)} ms, ${r.fps.toFixed(0)} fps${r.alive != null ? `, alive ${r.alive}` : ''}`);
      }
    }
    if (opt.profile) {
      mkdirSync(opt.profile, { recursive: true });
      for (const b of builds) {
        const r = await run(b, scen, true);
        const f = join(opt.profile, `${b.label}-${scen}.txt`);
        writeFileSync(f, `${b.label} ${scen} ${b.url}\nmean ${r.mean.toFixed(3)} ms (profiled)\n` + profileText(r.profile));
        console.error(`  profile -> ${f}`);
      }
    }
  }
  if (opt.checkOnly) throw Object.assign(new Error('done'), { quiet: true });
  console.log(`\n${'scenario'.padEnd(11)}${'build'.padEnd(10)}${'mean ms'.padStart(9)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'fps'.padStart(7)}${'speedup'.padStart(9)}  spread`);
  for (const scen of scenarios) {
    let base = null;
    for (const b of builds) {
      const rs = all.filter((x) => x.build === b.label && x.scen === scen);
      const mean = med(rs.map((x) => x.mean)), p50 = med(rs.map((x) => x.p50)), p95 = med(rs.map((x) => x.p95)), fps = med(rs.map((x) => x.fps));
      if (base == null) base = mean;
      const lo = Math.min(...rs.map((x) => x.mean)), hi = Math.max(...rs.map((x) => x.mean));
      console.log(`${scen.padEnd(11)}${b.label.padEnd(10)}${mean.toFixed(3).padStart(9)}${p50.toFixed(3).padStart(8)}${p95.toFixed(3).padStart(8)}${fps.toFixed(0).padStart(7)}${(base / mean).toFixed(2).padStart(8)}x  ${lo.toFixed(3)}–${hi.toFixed(3)}`);
    }
  }
  if (opt.json) writeFileSync(opt.json, JSON.stringify(all, null, 1));
} catch (e) {
  if (!e.quiet) { console.error('perfbench: ' + e.message); process.exitCode = 1; }
} finally {
  await closeChrome(chrome, profileDir);
  process.exit(process.exitCode || 0);
}
