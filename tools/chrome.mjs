// Shared headless-Chrome settings for the browser test tools (bench.mjs, flowtest.mjs,
// profile-worker.mjs), so they run the same on a Mac with a GPU and on a GPU-less Linux CI runner.
//
// Environment:
//   CHROME             Chrome binary (default: the macOS app, or google-chrome / chromium on Linux)
//   SE1_ANGLE          ANGLE backend: metal (macOS default), swiftshader (default elsewhere: software
//                      GL, no GPU needed), vulkan, gl, ...
//   SE1_CHROME_FLAGS   extra Chrome flags, space separated (e.g. "--no-sandbox" in containers/CI)
//   SE1_TIMEOUT_SCALE  multiply the tools' timeouts and measuring windows (slow machines, SwiftShader)
import { existsSync } from 'node:fs';

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
