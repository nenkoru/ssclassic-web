// Shared headless-Chrome settings for the browser test tools (bench.mjs, flowtest.mjs,
// profile-worker.mjs), so they run the same on a Mac with a GPU and on a GPU-less Linux CI runner.
//
// Environment:
//   CHROME             Chrome binary (default: the macOS app, or google-chrome / chromium on Linux)
//   SE1_ANGLE          ANGLE backend: metal (macOS default), swiftshader (default elsewhere: software
//                      GL, no GPU needed), vulkan, gl, ...
//   SE1_CHROME_FLAGS   extra Chrome flags, space separated (e.g. "--no-sandbox" in containers/CI)
//   SE1_TIMEOUT_SCALE  multiply the tools' timeouts and measuring windows (slow machines, SwiftShader)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const LINUX_CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export const CHROME = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : LINUX_CHROMES.find((p) => existsSync(p)) || 'google-chrome');

export const ANGLE = process.env.SE1_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');

export const TIMEOUT_SCALE = Math.max(1, Number(process.env.SE1_TIMEOUT_SCALE) || 1);

// GPU flags for an ANGLE backend. SwiftShader (CPU rendering) must be opted into explicitly since
// Chrome 137 (--enable-unsafe-swiftshader); it is fine for tests, which load only local pages.
export function gpuFlags(angle = ANGLE) {
  return [`--use-angle=${angle}`, ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
    '--enable-gpu', '--ignore-gpu-blocklist'];
}

export const EXTRA_FLAGS = (process.env.SE1_CHROME_FLAGS || '').split(/\s+/).filter(Boolean);

// Chrome profiles for the test tools: tempProfile() makes one and remembers it, closeChrome()
// stops a Chrome and deletes the profiles its Chromes have finished using, and a synchronous
// safety net deletes whatever is left on exit (Chrome writes ~350 MB of profile per test run,
// and os.tmpdir() fills up).
const profiles = [];   // remembered profile dirs, in creation order

export function tempProfile(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  profiles.push(dir);
  return dir;
}

const rmProfile = (dir) => {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) {   // Chrome may still be flushing: one retry after 200 ms
    if (e.code === 'ENOTEMPTY' || e.code === 'EBUSY') setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 200).unref?.();
  }
};

export async function closeChrome(proc) {
  // each Chrome gets the oldest unclaimed profile: the tools launch one Chrome per profile,
  // closing them in launch order, and the profile path is what a signal handler uses to find
  // and kill a stray Chrome
  const profile = profiles.shift();
  if (proc && proc.exitCode === null && !proc.killed) proc.kill();
  if (!proc) return;
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  if (profile) rmProfile(profile);
}

// A tool killed with SIGKILL (a timeout, a killed agent shell) runs none of the handlers below, and
// its headless Chrome lives on with the parent gone: one stray burned CPU for hours and kept a
// ~400 MB profile. So every tool, on load, reaps those strays first: a headless Chrome whose parent
// is gone (ppid 1) and whose profile is in the temp folder (ours are tmpdir/se1*; omp's ad-hoc
// scripts use other prefixes), then the profiles no Chrome uses (see below). 176 of them had
// piled up once, 9.6 GB.
function reapStrays() {
  if (process.platform === 'win32') return;
  const prefix = join(tmpdir(), '/');
  let ps;
  try { ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch { return; }
  const procs = [];   // [pid, ppid, profile dir] of our headless Chromes and their helpers
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    const dir = m && m[3].match(/--user-data-dir=(\S+)/)?.[1];
    if (dir && dir.startsWith(prefix)) procs.push([Number(m[1]), Number(m[2]), dir]);
  }
  // a profile is stray when its headless main process has lost its parent; kill the whole family
  // (renderer and GPU helpers would keep writing to the profile)
  const strayDirs = new Set(procs.filter(([, ppid]) => ppid === 1).map(([, , dir]) => dir));
  const killed = procs.filter(([, , dir]) => strayDirs.has(dir)).map(([pid]) => pid);
  const inUse = new Set(procs.filter(([, , dir]) => !strayDirs.has(dir)).map(([, , dir]) => dir));
  for (const pid of killed) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  // wait (up to 2 s) for them to go, so their profiles can be deleted now
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 40 && !killed.every(gone); i++) sleep(50);
  for (const dir of strayDirs) if (!dir.slice(prefix.length).startsWith('se1')) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
  // left-over profiles: ours (se1*) after 10 minutes; any other Chrome profile in the temp folder
  // (has "Local State": ad-hoc probe scripts, omp's debug scripts) after an hour. In use: never.
  let names = [];
  try { names = readdirSync(tmpdir()); } catch {}
  for (const n of names) {
    const dir = join(tmpdir(), n);
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || inUse.has(dir)) continue;
      const age = Date.now() - st.mtimeMs;
      const stale = n.startsWith('se1') ? age > 10 * 60e3 : existsSync(join(dir, 'Local State')) && age > 60 * 60e3;
      if (stale) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
}
reapStrays();

process.on('exit', () => { for (const dir of profiles) rmProfile(dir); });
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    // kill any Chrome still using a remembered profile (matches --user-data-dir=<dir> in its
    // command line), then delete the profiles
    for (const dir of [...profiles]) {
      try { execFileSync('pkill', ['-f', `user-data-dir=${dir}`]); } catch {}
      rmProfile(dir);
    }
    process.exit(code);
  });
}
