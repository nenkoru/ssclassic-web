#!/usr/bin/env node
// Static hosting bundle test (tools/package.sh + port/web/landing.html + port/web/isolate.js):
// serves the bundle with a PLAIN static server (no COOP/COEP headers, like GitHub Pages) and
// checks that visitors land on the build their page can run:
//   1. landing picks threaded   -> coi-sw.js isolates the page, mt/ runs
//   2. query kept               -> ?mute=1 survives the landing replace
//   3. fallback to single-threaded -> mt/ with coi=0 lands on st/ with the query, no error bar
//   4. landing without service workers -> coi=0 on the landing page lands on st/
//   5. error bar without a fallback -> bundle without st/ shows the red bar, stays on mt/
//   6. no exceptions
//
//   node tools/packagetest.mjs <outdir>
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const outdir = process.argv[2];
if (!outdir) { console.error('usage: packagetest.mjs <outdir>'); process.exit(2); }

// bundle without st/: the fallback HEAD must 404, so isolate.js shows the error bar
const noStDir = join(tmpdir(), 'se1-pkg-nost-' + Date.now());
mkdirSync(join(noStDir, 'mt'), { recursive: true });
cpSync(outdir, noStDir, { recursive: true });
rmSync(join(noStDir, 'st'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 9950 + Math.floor(Math.random() * 50);
let chrome = null;
const launchChrome = () => {
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(tmpdir(), 'se1pkg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))}`,
    '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
};
const servers = [];   // static servers, killed at the end
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// fresh profile per check: service worker registrations persist in a profile, and an
// installed coi-sw.js from a previous check would isolate the page for the next one
const freshProfile = async () => {
  if (chrome) { chrome.kill(); await sleep(500); }
  port = 9950 + Math.floor(Math.random() * 50);
  launchChrome();
};

try {
  const server = (dir, p) => servers[servers.push(spawn('python3', ['-m', 'http.server', String(p), '--bind', '127.0.0.1', '--directory', dir], { stdio: 'ignore' })) - 1];
  const srv8320 = server(outdir, 8320);
  const srv8321 = server(noStDir, 8321);
  let ws;
  const connect = async () => {
    ws = null;
    for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (!res.ok) { await sleep(200); continue; }
        const l = await res.json();
        const p = l.find((x) => x.type === 'page');
        if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200);
      } catch { await sleep(200); }
    }
    if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  };
  let id = 0; const pend = new Map(); const errors = [];
  const wire = () => {
    id = 0; pend.clear(); errors.length = 0;
    ws.onmessage = (m) => {
      if (!m.data) return;
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    };
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const st = async () => {
    const raw = await ev(`JSON.stringify({
      path: location.pathname, search: location.search,
      coi: window.crossOriginIsolated === true,
      frames: (typeof Module !== 'undefined' && Module.se1Perf) ? Module.se1Perf.n : -1,
      bar: [...document.querySelectorAll('div')].some((d) => d.textContent.includes('needs a cross-origin isolated page')) })`);
    return raw ? JSON.parse(raw) : null;
  };
  const until = async (pred, ms) => {
    let s;
    for (let t = 0; t < ms / 250; t++) {
      s = await st();
      if (s && pred(s)) return s;
      await sleep(250);
    }
    return s;
  };
  const open = async (url) => {
    await freshProfile();
    await connect();
    wire();
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
  };

  // 1. plain static server: landing must pick the threaded build via coi-sw.js
  await open('http://127.0.0.1:8320/?mute=1');
  let s = await until((x) => x.path === '/mt/serioussam.html' && x.coi && x.frames >= 0, 90000 * TIMEOUT_SCALE);
  check('landing picks threaded', s.path === '/mt/serioussam.html' && s.coi, `path ${s.path}, isolated ${s.coi}`);
  const f0 = s.frames;
  await sleep(2000);
  s = await st();
  check('threaded frames run', s.frames > f0 + 30, `${s.frames - f0} frames in 2 s`);
  check('query kept', s.search.includes('mute=1'), `search ${s.search}`);

  // 2. coi=0 on the mt page: isolate.js must hand off to st/, keep the query, no error bar
  await open('http://127.0.0.1:8320/mt/serioussam.html?mute=1&coi=0');
  s = await until((x) => x.path === '/st/serioussam.html' && x.frames >= 0, 90000 * TIMEOUT_SCALE);
  check('fallback to single-threaded', s.path === '/st/serioussam.html' && !s.bar, `path ${s.path}, bar ${s.bar}`);
  check('fallback keeps the query', s.search.includes('mute=1') && s.search.includes('coi=0'), `search ${s.search}`);
  const f1 = s.frames;
  await sleep(2000);
  s = await st();
  check('single-threaded frames run', s.frames > f1 + 30, `${s.frames - f1} frames in 2 s`);

  // 3. landing page with coi=0: no service worker path at all, straight to st/
  await open('http://127.0.0.1:8320/?mute=1&coi=0');
  s = await until((x) => x.path === '/st/serioussam.html' && x.frames >= 0, 90000 * TIMEOUT_SCALE);
  check('landing without service workers', s.path === '/st/serioussam.html' && !s.bar, `path ${s.path}, bar ${s.bar}`);
  const f2 = s.frames;
  await sleep(2000);
  s = await st();
  check('landing fallback frames run', s.frames > f2 + 30, `${s.frames - f2} frames in 2 s`);

  // 4. bundle without st/: the HEAD 404s, isolate.js must show the red bar and stay on mt/
  await open('http://127.0.0.1:8321/mt/serioussam.html?coi=0');
  s = await until((x) => x.bar, 30000 * TIMEOUT_SCALE);
  check('error bar without a fallback', s.bar && s.path === '/mt/serioussam.html', `bar ${s.bar}, path ${s.path}`);

  // 5. the intentional fail() path throws 'se1: waiting for cross-origin isolation' — filter it
  const unexpected = errors.filter((e) => !e.includes('se1: waiting for cross-origin isolation'));
  check('no exceptions', unexpected.length === 0, unexpected.slice(0, 3).join(' | ') || '(expected isolation throw only)');
} catch (e) {
  console.log('FAIL  harness  ' + e.message + '\n' + (e.stack || '')); failed++;
} finally {
  if (chrome) chrome.kill();
  for (const s of servers) s.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
