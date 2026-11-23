#!/usr/bin/env node
// Playtest recorder test (port/web/playtest.js, ?rec=1): plays a short scripted Survivors session and
// checks that the dev server received the session's meta.json, telemetry.jsonl (HUD snapshots, mod
// messages, card answers, input and state samples, mod "tel" samples, markers) and survey.json.
//
//   node tools/playtesttest.mjs <url> <playtests-dir>
// <playtests-dir> must be the --playtests-dir of the dev server serving <url>.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, gpuFlags, EXTRA_FLAGS, TIMEOUT_SCALE, tempProfile, closeChrome } from './chrome.mjs';

const [url, dir] = process.argv.slice(2);
if (!url || !dir) { console.error('usage: playtesttest.mjs <url> <playtests-dir>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempProfile('se1rec-')}`,
  '--mute-audio', ...gpuFlags(), ...EXTRA_FLAGS, '--window-size=1100,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

try {
  let ws;
  for (let t = 0; t < 50 * TIMEOUT_SCALE && !ws; t++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); else await sleep(200); }
    catch { await sleep(200); }
  }
  if (!ws) throw new Error('chrome did not start');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n')[0]);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  const key = async (k, code, vk, type) => send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  const tap = async (k, code, vk) => { await key(k, code, vk, 'keyDown'); await sleep(60); await key(k, code, vk, 'keyUp'); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&mode=survivors&svauto=1&svgod=1&svxp=8&rec=1' });
  let session = null;
  for (let t = 0; t < 360 * TIMEOUT_SCALE; t++) {
    session = await ev('Module.se1Playtest ? Module.se1Playtest.session : null');
    const w = await ev('Module._SE1_WantPointer ? Module._SE1_WantPointer() : -1');
    const off = await ev('!!Module.se1SurvivorsOffer');
    if (session && (w === 1 || off)) break;
    await sleep(250);
  }
  check('recorder started', !!session, `session ${session}`);
  // play a little: walk, pick a card when one is offered, press the three markers
  await key('w', 'KeyW', 87, 'keyDown'); await sleep(1500); await key('w', 'KeyW', 87, 'keyUp');
  for (let t = 0; t < 40; t++) {
    if (await ev('!!Module.se1SurvivorsOffer')) break;   // survivors.js: the offer being shown
    await sleep(250);
  }
  // answer every offer (each level-up pauses the run until a card is picked)
  for (let i = 0; i < 6 && await ev('!!Module.se1SurvivorsOffer'); i++) { await tap('1', 'Digit1', 49); await sleep(800); }
  await sleep(1500);
  await tap('F7', 'F7', 118); await sleep(300);
  await tap('F8', 'F8', 119); await sleep(300);
  await tap('F10', 'F10', 121);
  await sleep(6000);
  // the survey: open it, answer, send
  await ev(`Module.se1PlaytestSurvey('test'); 1`);
  await sleep(300);
  await ev(`(() => { const f = document.querySelector('#rec-survey form');
    f.querySelector('input[name=fun][value="4"]').checked = true;
    f.querySelector('input[name=pacing][value="about right"]').checked = true;
    f.querySelector('textarea[name=best]').value = 'test run';
    f.requestSubmit(); return 1; })()`);
  await sleep(6000);

  const sdir = join(dir, session || 'none');
  check('session folder', existsSync(sdir), sdir);
  const meta = existsSync(join(sdir, 'meta.json')) ? JSON.parse(readFileSync(join(sdir, 'meta.json'), 'utf8')) : null;
  check('meta.json', !!(meta && meta.options && meta.options.rec === '1'), meta ? `options ${JSON.stringify(meta.options)}` : 'missing');
  const lines = existsSync(join(sdir, 'telemetry.jsonl')) ? readFileSync(join(sdir, 'telemetry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const types = {};
  for (const e of lines) { const k = e.type === 'mod' ? 'mod:' + e.msg.type : e.type === 'marker' ? 'marker:' + e.kind : e.type; types[k] = (types[k] || 0) + 1; }
  console.log('info  events by type  ' + JSON.stringify(types));
  check('telemetry has HUD snapshots', (types.hud || 0) >= 10, `${types.hud || 0}`);
  check('telemetry has mod messages', Object.keys(types).some((k) => k.startsWith('mod:')), Object.keys(types).filter((k) => k.startsWith('mod:')).join(' '));
  check('telemetry has a card answer', (types.answer || 0) >= 1, `${types.answer || 0}`);
  check('telemetry has input and state samples', (types.input || 0) >= 5 && (types.state || 0) >= 5, `input ${types.input || 0}, state ${types.state || 0}`);
  check('telemetry has tel samples', (types.tel || 0) >= 5, `${types.tel || 0}`);
  check('telemetry has the three markers', types['marker:fun'] === 1 && types['marker:boring'] === 1 && types['marker:bug'] === 1, `${types['marker:fun']}/${types['marker:boring']}/${types['marker:bug']}`);
  const walked = lines.some((e) => e.type === 'input' && e.codes && e.codes.KeyW);
  check('input saw the walk', walked, '');
  const times = lines.map((e) => e.t);
  check('times increase', times.every((t, i) => i === 0 || t >= times[i - 1] - 1), `${times[0]} .. ${times[times.length - 1]} s`);
  const sv = existsSync(join(sdir, 'survey.json')) ? JSON.parse(readFileSync(join(sdir, 'survey.json'), 'utf8')) : null;
  check('survey.json', !!(sv && sv.answers && sv.answers.fun === '4' && sv.answers.best === 'test run'), sv ? JSON.stringify(sv.answers) : 'missing');
  check('no exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (existsSync(sdir)) console.log('info  session size  ' + readdirSync(sdir).map((f) => `${f} ${statSync(join(sdir, f)).size} B`).join(', '));

  // quiet mode (the default on dev hosts; headless Chrome needs it asked for): console capture and
  // the screenshot flight recorder, flushed by a trigger
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'mute=1&rec=quiet' });
  let qs = null;
  for (let t = 0; t < 360 * TIMEOUT_SCALE; t++) {
    qs = await ev('Module.se1Playtest && Module._SE1_WantPointer ? Module.se1Playtest.session : null');
    if (qs && qs !== session && (await ev('Module.se1Perf ? Module.se1Perf.n : 0')) > 60) break;
    await sleep(250);
  }
  check('quiet recorder started', !!qs && qs !== session, `session ${qs}`);
  await sleep(7000);                                // a few flight-recorder frames
  await ev(`Module.se1PlaytestTrigger && Module.se1PlaytestTrigger('test'); 1`);
  await sleep(9000);                                // the ring, then the next 2 shots, then a flush
  const qdir = join(dir, qs || 'none');
  const qmeta = existsSync(join(qdir, 'meta.json')) ? JSON.parse(readFileSync(join(qdir, 'meta.json'), 'utf8')) : null;
  check('quiet meta.json', !!(qmeta && qmeta.mode === 'quiet'), qmeta ? `mode ${qmeta.mode}` : 'missing');
  const con = existsSync(join(qdir, 'console.txt')) ? readFileSync(join(qdir, 'console.txt'), 'utf8') : '';
  check('quiet console.txt has engine lines', con.split('\n').filter((l) => l.split('\t').length >= 3).length >= 5, `${con.length} B`);
  const shots = existsSync(qdir) ? readdirSync(qdir).filter((f) => /^shot-\d+\.jpg$/.test(f)) : [];
  check('quiet flight-recorder shots', shots.length >= 3 && shots.every((f) => statSync(join(qdir, f)).size > 1000), `${shots.length}: ${shots.slice(0, 6).join(' ')}`);
  const qtel = existsSync(join(qdir, 'telemetry.jsonl')) ? readFileSync(join(qdir, 'telemetry.jsonl'), 'utf8') : '';
  check('quiet telemetry has start and build', /"type":"start"/.test(qtel) && /"type":"build"/.test(qtel), `${qtel.length} B`);
} catch (e) {
  console.log('FAIL  harness  ' + e.message); failed++;
} finally {
  await closeChrome(chrome);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
