#!/usr/bin/env node
// se1d: a game session that stays open between commands, for poking at the running game quickly.
// One headless Chrome (taken under the one-Chrome lock of tools/chrome.mjs) with one game page; a
// small HTTP server on 127.0.0.1 drives it. The client commands start the daemon on first use, and
// the daemon exits after SE1D_IDLE minutes (default 20) without a command, freeing the memory.
//
//   node tools/se1d.mjs open [url | ?query | query]   load the game (default base: the `full` dev
//                                                     server, http://127.0.0.1:8096/serioussam.html;
//                                                     SE1D_BASE overrides; mute=1 is added)
//   node tools/se1d.mjs cmd '<console line>' [--ms 600]  run a console line in the engine (e.g.
//                                                     "cht_bGod=1", "say(\"hi\")"); prints the log
//                                                     lines from its echo on, for --ms milliseconds
//   node tools/se1d.mjs log [--since N] [--grep RE] [--tail N]   console lines (N = line number)
//   node tools/se1d.mjs wait <RE> [--timeout S]       wait for a console line (default 120 s)
//   node tools/se1d.mjs eval '<js>'                   evaluate in the page, print the JSON result
//   node tools/se1d.mjs shot [file.png]               screenshot (default data/dev/shots/<time>.png)
//   node tools/se1d.mjs status | quit | serve
//
// Console lines are the page's console (the engine's CPrintF output, mod lines without the
// "[se1mod] " prefix) plus "!! " lines for uncaught exceptions.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SE1D_PORT) || 9230;
const BASE = process.env.SE1D_BASE || 'http://127.0.0.1:8096/serioussam.html';
const IDLE_MIN = Number(process.env.SE1D_IDLE) || 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- daemon
async function serve() {
  const { CHROME, gpuFlags, EXTRA_FLAGS, tempProfile, closeChrome } = await import('./chrome.mjs');
  const lines = [];            // { n, t, text }
  let nextN = 0, chrome = null, ws = null, url = null, cdpId = 0, idleAt = Date.now();
  const pend = new Map();
  const push = (text) => { lines.push({ n: nextN++, t: Date.now(), text }); if (lines.length > 50000) lines.splice(0, 10000); };

  async function ensureChrome() {
    if (ws && ws.readyState === 1) return;
    const port = 9900 + Math.floor(Math.random() * 40);
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1d-')}`,
      '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1280,720', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    chrome.on('exit', () => { ws = null; chrome = null; push('!! chrome exited'); });
    for (let t = 0; t < 100 && !ws; t++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const p = l.find((x) => x.type === 'page');
        if (p) ws = new WebSocket(p.webSocketDebuggerUrl);
      } catch { await sleep(200); }
    }
    if (!ws) throw new Error('Chrome did not start');
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^\[se1mod\]\s*/, ''));
      } else if (d.method === 'Runtime.exceptionThrown') {
        const x = d.params.exceptionDetails;
        push('!! ' + ((x.exception?.description || x.text || '').split('\n')[0]));
      }
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    // a headless page has no focus, and the game pauses without it; pointer lock needs a gesture
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };' });
  }
  const cdp = (method, params = {}) => new Promise((r) => { const n = ++cdpId; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => {
    const d = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || d.result.exceptionDetails.text);
    return d.result?.result?.value;
  };
  const waitFor = async (re, timeoutS, fromN) => {
    const end = Date.now() + timeoutS * 1000;
    while (Date.now() < end) {
      const hit = lines.find((l) => l.n >= fromN && re.test(l.text));
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const pageUrl = (arg) => {
    let u = !arg ? BASE : /^https?:/.test(arg) ? arg : BASE + '?' + arg.replace(/^\?/, '');
    if (!/[?&]mute=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'mute=1';
    return u;
  };

  const routes = {
    async status() {
      return { pid: process.pid, chrome: !!ws, url, lines: nextN, idleMinutesLeft: Math.round((idleAt + IDLE_MIN * 60e3 - Date.now()) / 60e3) };
    },
    async open(q) {
      await ensureChrome();
      url = pageUrl(q.get('url'));
      const from = nextN;
      push(`-- open ${url}`);
      await cdp('Page.navigate', { url });
      // ready: the engine is running frames (perf ring counting)
      const end = Date.now() + 120e3;
      let ready = false;
      while (!ready && Date.now() < end) {
        await sleep(300);
        try { ready = await evaluate('!!(window.Module && Module._SE1_CommandBusy && Module.se1Perf && Module.se1Perf.n > 30)'); } catch {}
      }
      return { url, ready, from, errors: lines.filter((l) => l.n >= from && l.text.startsWith('!! ')).map((l) => l.text) };
    },
    async cmd(q, body) {
      await ensureChrome();
      const line = body || q.get('line') || '';
      const from = nextN;
      await evaluate(`Module.se1Cmd(${JSON.stringify(line)})`);
      const echo = await waitFor(/web: > /, 10, from);   // (unanchored: Echo() leaves no newline)
      if (!echo) return { ok: false, error: 'no echo from the engine in 10 s (is a game page open? se1d open)', lines: [] };
      await sleep(Number(q.get('ms')) || 600);
      return { ok: true, lines: lines.filter((l) => l.n >= echo.n).map((l) => l.text) };
    },
    async log(q) {
      const since = Number(q.get('since') ?? 0), tail = Number(q.get('tail') || 0);
      const re = q.get('grep') ? new RegExp(q.get('grep'), 'i') : null;
      let out = lines.filter((l) => l.n >= since && (!re || re.test(l.text)));
      if (tail) out = out.slice(-tail);
      return { next: nextN, lines: out.map((l) => `${l.n}\t${l.text}`) };
    },
    async wait(q) {
      const hit = await waitFor(new RegExp(q.get('re'), 'i'), Number(q.get('timeout')) || 120, Number(q.get('since') ?? 0));
      return hit ? { ok: true, line: `${hit.n}\t${hit.text}` } : { ok: false };
    },
    async eval(q, body) { await ensureChrome(); return { value: await evaluate(body || q.get('js')) }; },
    async shot(q) {
      await ensureChrome();
      const file = resolve(ROOT, q.get('file') || join('data/dev/shots', new Date().toISOString().replace(/[:.]/g, '-') + '.png'));
      mkdirSync(dirname(file), { recursive: true });
      const d = await cdp('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(d.result.data, 'base64'));
      return { file };
    },
    async quit() { setTimeout(() => stop(0), 50); return { ok: true }; },
  };

  async function stop(code) { if (chrome) await closeChrome(chrome); process.exit(code); }
  process.on('SIGTERM', () => stop(143));
  setInterval(() => { if (Date.now() - idleAt > IDLE_MIN * 60e3) { console.log('idle, exiting'); stop(0); } }, 30e3).unref();

  createServer(async (req, res) => {
    idleAt = Date.now();
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const fn = routes[u.pathname.slice(1)];
    let out, status = 200;
    try { out = fn ? await fn(u.searchParams, body) : (status = 404, { error: 'unknown route' }); }
    catch (e) { status = 500; out = { error: e.message }; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  }).listen(PORT, '127.0.0.1', () => console.log(`se1d listening on 127.0.0.1:${PORT} (pid ${process.pid})`));
}

// ---------------------------------------------------------------- client
async function call(route, params = {}, body) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();
  const u = `http://127.0.0.1:${PORT}/${route}${qs ? '?' + qs : ''}`;
  const r = await fetch(u, body !== undefined ? { method: 'POST', body } : {});
  return [r.status, await r.json()];
}

async function ensureDaemon() {
  try { await call('status'); return; } catch {}
  const logDir = join(ROOT, 'data/dev/logs');
  mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, 'se1d.log'), 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', out, out], cwd: ROOT }).unref();
  for (let t = 0; t < 50; t++) { await sleep(200); try { await call('status'); return; } catch {} }
  throw new Error('se1d did not start; see data/dev/logs/se1d.log');
}

function flag(args, name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(readUsage());
    return 0;
  }
  if (cmd === 'serve') { await serve(); return null; }
  if (cmd === 'quit') { try { await call('quit'); console.log('se1d: stopped'); } catch { console.log('se1d: not running'); } return 0; }
  await ensureDaemon();
  let status, out;
  switch (cmd) {
    case 'status': [status, out] = await call('status'); break;
    case 'open': [status, out] = await call('open', { url: args[0] }); break;
    case 'cmd': { const ms = flag(args, '--ms'); [status, out] = await call('cmd', { ms }, args.join(' ')); break; }
    case 'log': [status, out] = await call('log', { since: flag(args, '--since'), grep: flag(args, '--grep'), tail: flag(args, '--tail') }); break;
    case 'wait': { const timeout = flag(args, '--timeout'); [status, out] = await call('wait', { re: args[0], timeout }); break; }
    case 'eval': [status, out] = await call('eval', {}, args.join(' ')); break;
    case 'shot': [status, out] = await call('shot', { file: args[0] }); break;
    default: console.error(readUsage()); return 2;
  }
  if (out.lines && (cmd === 'log' || cmd === 'cmd')) {
    for (const l of out.lines) console.log(l);
    if (cmd === 'log') console.log(`-- next: ${out.next}`);
    if (out.error) console.error(out.error);
  } else {
    console.log(JSON.stringify(out, null, 1));
  }
  return status === 200 && out.ok !== false && out.ready !== false ? 0 : 1;
}

function readUsage() {
  return 'usage: node tools/se1d.mjs open [url|query] | cmd <line> [--ms N] | log [--since N] [--grep RE] [--tail N]\n' +
    '                            | wait <RE> [--timeout S] | eval <js> | shot [file.png] | status | quit | serve';
}

main().then((code) => { if (code !== null) process.exit(code); }, (e) => { console.error('se1d: ' + e.message); process.exit(1); });
