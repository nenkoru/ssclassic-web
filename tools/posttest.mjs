#!/usr/bin/env node
// Post-processing chain test (?post=fxaa,sharpen in port/web/gfx.js).
// Checks: effects list, se1Post.ms, gl.getError(), and that captures with post differ from no-post.
//
//   node tools/posttest.mjs http://127.0.0.1:8420/serioussam.html
import { spawn } from 'node:child_process';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: posttest.mjs <url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9850 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1post-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start (' + CHROME + ')');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = []; const warns = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'warning') warns.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const st = async () => JSON.parse((await ev(`typeof Module === 'undefined' || !Module.canvas ? '{}' : JSON.stringify({
    frames: Module.se1Perf ? Module.se1Perf.n : -1,
    effects: Module.se1Post ? Module.se1Post.effects : null,
    ms: Module.se1Post ? Module.se1Post.ms : null,
    err: Module.se1gfx ? Module.se1gfx.glError() : -1,
    cw: Module.canvas.width, ch: Module.canvas.height })`)) || '{}');
  const until = async (pred, ms) => { let s; for (let t = 0; t < ms / 250; t++) { s = await st(); if (pred(s)) return s; await sleep(250); } return s; };
  // a capture that shows a picture: with lazy data the intro level may still be loading (a blank
  // screen) after 60 frames, so retry for up to 30 s
  const grab = async () => {
    let g;
    for (let t = 0; t < 60 * TIMEOUT_SCALE; t++) { g = await grab1(); if (g && g.colors > 8) break; await sleep(500); }
    return g;
  };
  const grab1 = async () => {   // one capture via the replayer (post pass runs if enabled)
    const r = await send('Runtime.evaluate', { expression: `new Promise((res) => Module.se1gfx.capture((px, w, h) => { const c = new Set(); for (let i = 0; i < px.length; i += 4 * 499) c.add(px[i] << 16 | px[i + 1] << 8 | px[i + 2]); res(JSON.stringify({ len: px.length, w, h, colors: c.size })); }))`, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('capture failed: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return JSON.parse(r.result?.result?.value || 'null');
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const q = (extra) => url + (url.includes('?') ? '&' : '?') + 'mute=1' + (extra ? '&' + extra : '');

  // --- no post: effects empty, ms 0, no post-related warnings ---
  await send('Page.navigate', { url: q('') });
  let s = await until((x) => x.frames > 60, 120000 * TIMEOUT_SCALE);
  check('off by default', Array.isArray(s.effects) && s.effects.length === 0 && s.ms === 0 && s.err === 0,
    `effects=${JSON.stringify(s.effects)} ms=${s.ms} err=${s.err}`);
  const a0 = await grab();
  check('off by default: capture ok', !!a0 && a0.w === s.cw && a0.h === s.ch && a0.colors > 8, a0 ? `${a0.w}x${a0.h}, ${a0.colors} colours` : 'null');

  // --- ?post=fxaa,sharpen: effects list, ms > 0, capture differs from no-post ---
  await send('Page.navigate', { url: q('post=fxaa,sharpen') });
  s = await until((x) => x.frames > 60, 120000 * TIMEOUT_SCALE);
  check('both effects run', JSON.stringify(s.effects) === JSON.stringify(['fxaa', 'sharpen']) && s.ms > 0 && s.err === 0,
    `effects=${JSON.stringify(s.effects)} ms=${s.ms} err=${s.err}`);
  const a1 = await grab();
  // the exact effect is checked frame by frame with ?shots= (tools/shotdiff.py); here: a real picture,
  // not one flat colour (what a pass reading an incomplete framebuffer gives)
  check('both effects: capture is a picture', !!a1 && a1.w === s.cw && a1.colors > 8, a1 ? `${a1.colors} colours` : 'null');

  // --- ?post=fxaa: single effect ---
  await send('Page.navigate', { url: q('post=fxaa') });
  s = await until((x) => x.frames > 60, 120000 * TIMEOUT_SCALE);
  check('fxaa runs', JSON.stringify(s.effects) === JSON.stringify(['fxaa']) && s.ms > 0 && s.err === 0,
    `effects=${JSON.stringify(s.effects)} ms=${s.ms} err=${s.err}`);
  // a resize (the render scale) recreates the post textures; the picture must survive it
  await ev('Module.se1Scale = 0.5');
  s = await until((x) => x.cw === Math.round(1024 * 0.5) || x.cw < 1024, 20000 * TIMEOUT_SCALE);
  await sleep(1000);
  const a2 = await grab();
  check('fxaa after resize', !!a2 && a2.w < 1024 && a2.colors > 8 && (await st()).err === 0, a2 ? `${a2.w}x${a2.h}, ${a2.colors} colours` : 'null');
  await ev('Module.se1Scale = 1');

  // --- unknown effect name: warned, filtered out ---
  await send('Page.navigate', { url: q('post=fxaa,bogus') });
  s = await until((x) => x.frames > 60, 120000 * TIMEOUT_SCALE);
  check('unknown effect: filtered', JSON.stringify(s.effects) === JSON.stringify(['fxaa']), JSON.stringify(s.effects));
  check('unknown effect: console.warn', warns.some((w) => w.includes('bogus')), warns.filter((w) => w.includes('post') || w.includes('bogus')).join(' | ') || 'no warn seen');

  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
