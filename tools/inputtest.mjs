#!/usr/bin/env node
// Page input test (port/web/input.js + port/web/shell.html): mouse capture, keys, layout, fullscreen.
// Headless Chrome has no real pointer lock, so it is modelled the way Chrome behaves: a lock request
// succeeds only with transient user activation (a recent click/key), and the browser can drop the
// lock at any time (Escape, alt-tab). The test checks that
//   - a click on the game captures the mouse,
//   - a lock the browser dropped comes back on the next click (long after the last gesture),
//   - the menu releases the mouse and returning to play captures it again,
//   - Space in play doesn't scroll the page (and the page can't scroll at all),
//   - Fullscreen keeps the canvas sized and the game running.
//
//   node tools/inputtest.mjs http://127.0.0.1:8094/serioussam.html [outdir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE } from './chrome.mjs';

const [url, outdir = join(tmpdir(), 'se1-input')] = process.argv.slice(2);
if (!url) { console.error('usage: inputtest.mjs <url> [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9800 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'se1in-'))}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// pointer lock as Chrome does it: needs transient activation; the "browser" can drop it (__loseLock)
const STUB = `(() => {
  let el = null; window.__pl = { req: 0, ok: 0, denied: 0, exit: 0 };
  Object.defineProperty(Document.prototype, 'pointerLockElement', { get() { return el; }, configurable: true });
  const change = () => document.dispatchEvent(new Event('pointerlockchange'));
  Element.prototype.requestPointerLock = function () {
    __pl.req++;
    if (!navigator.userActivation.isActive) { __pl.denied++; document.dispatchEvent(new Event('pointerlockerror')); return Promise.reject(new DOMException('no user gesture')); }
    __pl.ok++; if (el !== this) { el = this; change(); } return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function () { __pl.exit++; if (el) { el = null; change(); } };
  window.__loseLock = () => { if (el) { el = null; change(); } };
})();`;

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const st = async () => JSON.parse(await ev(`JSON.stringify({ want: Module.se1WantPointer ? Module.se1WantPointer() : -1,
    locked: document.pointerLockElement === Module.canvas, pl: __pl, frames: Module.se1Perf ? Module.se1Perf.n : -1,
    hint: getComputedStyle(document.getElementById('hint')).display, scrollY: window.scrollY,
    scrollable: document.scrollingElement.scrollHeight > innerHeight + 1 || document.scrollingElement.scrollWidth > innerWidth + 1,
    cw: Module.canvas.width, ch: Module.canvas.height, css: [Module.canvas.clientWidth, Module.canvas.clientHeight],
    fs: !!document.fullscreenElement, space: window.__space })`));
  const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outdir, f), Buffer.from(r.result.data, 'base64')); };
  const click = async (x = 550, y = 500) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async (k, code, vk, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const until = async (pred, ms) => { let s; for (let t = 0; t < ms / 250; t++) { s = await st(); if (pred(s)) return s; await sleep(250); } return s; };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "addEventListener('keydown', (e) => { if (e.code === 'Space') window.__space = e.defaultPrevented ? 'prevented' : 'default'; });" });
  // Survivors drops straight into play on a level
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1' });

  let s = await until((x) => x.want === 1, 90000 * TIMEOUT_SCALE);
  check('game wants the mouse in play', s.want === 1, `want ${s.want}, frames ${s.frames}, hint ${s.hint}`);
  check('page fits the window', !s.scrollable && s.css[0] > 0 && s.css[0] <= 1100 && s.css[1] <= 1000, `canvas ${s.cw}x${s.ch} shown ${s.css.join('x')}, scrollable ${s.scrollable}`);

  await click();
  s = await until((x) => x.locked, 2000);
  check('click captures the mouse', s.locked, `locked ${s.locked}, requests ${JSON.stringify(s.pl)}`);

  await ev('__loseLock()');           // the browser drops the lock (alt-tab, Escape, …)
  await sleep(6000);                  // long after the last gesture: no activation left
  s = await st();
  check('hint shown while the mouse is free', s.hint === 'block' && !s.locked, `hint ${s.hint}, locked ${s.locked}`);
  await click();
  s = await until((x) => x.locked, 2000);
  check('click re-captures a dropped lock', s.locked, `locked ${s.locked}, requests ${JSON.stringify(s.pl)}`);

  await key(' ', 'Space', 32, ' ');
  await sleep(300); s = await st();
  check('Space in play does not scroll', s.space === 'prevented' && s.scrollY === 0, `Space default ${s.space}, scrollY ${s.scrollY}`);

  await key('Escape', 'Escape', 27);
  s = await until((x) => x.want === 0 && !x.locked, 4000);
  check('menu releases the mouse', s.want === 0 && !s.locked, `want ${s.want}, locked ${s.locked}`);
  await shot('input-menu.png');
  await key('Escape', 'Escape', 27);
  s = await until((x) => x.want === 1 && x.locked, 4000);
  check('back to play captures it again', s.want === 1 && s.locked, `want ${s.want}, locked ${s.locked}`);

  // the Fullscreen button (bottom right); it hides while the mouse is captured, so free it first
  await ev('__loseLock()'); await sleep(400);
  const fs = JSON.parse(await ev("JSON.stringify((r => [r.x + r.width / 2, r.y + r.height / 2])(document.getElementById('fs').getBoundingClientRect()))"));
  const f0 = (await st()).frames;
  await click(fs[0], fs[1]);
  await sleep(2000);
  s = await st();
  check('fullscreen keeps the game visible', s.cw > 0 && s.ch > 0 && s.css[0] > 0 && s.css[1] > 0 && s.frames > f0 + 20,
    `fullscreen ${s.fs}, canvas ${s.cw}x${s.ch} shown ${s.css.join('x')}, ${s.frames - f0} frames in 2 s`);
  await shot('input-fullscreen.png');

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  chrome.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
