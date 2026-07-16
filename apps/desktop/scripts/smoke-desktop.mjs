#!/usr/bin/env bun
/**
 * Packaged-desktop boot smoke.
 *
 * Builds an UNSIGNED packaged app (`electron-builder --dir`, no notarization),
 * launches the real packaged binary, attaches to its renderer over the Chrome
 * DevTools Protocol (see cdp-client.mjs for why raw CDP instead of Playwright),
 * and asserts the app actually boots: a window for the loopback daemon rendered,
 * the app shell is present and sized (a blank window — renderer that couldn't
 * reach the daemon — leaves #root empty), no uncaught main-process exceptions,
 * then it shuts down cleanly.
 *
 * The mock provider never registers in packaged builds, so this asserts the shell
 * renders and the local server booted — it does NOT create sessions.
 *
 * On failure, a screenshot (when a renderer is reachable) + the captured
 * main-process log land in smoke-artifacts/.
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitForAppPageTarget, connectCdp } from './cdp-client.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.env.NUNCIO_CHANNEL || 'stable';
const artifactsDir = join(desktopDir, 'smoke-artifacts');

// Present on every route of the app shell (the hover rail lives outside <Routes>).
// If a redesign renames it, the same PR runs this smoke (web paths are in the CI
// filter) and the author updates it here.
const SHELL_SELECTOR = '[data-testid="desktop-sidebar-rail"]';
const FATAL_MAIN_MARKERS = [
  'A JavaScript error occurred in the main process',
  'Uncaught Exception',
  'UnhandledPromiseRejection',
];
const DEVTOOLS_RE = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//;

let logBuffer = '';
function record(chunk) {
  logBuffer += chunk;
  process.stdout.write(chunk);
}

function run(cmd, env = {}) {
  record(`\n$ ${cmd}\n`);
  execSync(cmd, { cwd: desktopDir, stdio: 'inherit', env: { ...process.env, ...env } });
}

function findPackagedBinary() {
  const outDir = join(desktopDir, 'dist', channel);
  if (!existsSync(outDir)) throw new Error(`electron-builder produced no output at ${outDir}`);
  // electron-builder's mac output lives under mac / mac-arm64 / mac-x64.
  for (const macDir of readdirSync(outDir).filter((d) => d.startsWith('mac'))) {
    const base = join(outDir, macDir);
    const app = readdirSync(base).find((d) => d.endsWith('.app'));
    if (!app) continue;
    const macosDir = join(base, app, 'Contents', 'MacOS');
    const exe = readdirSync(macosDir)[0];
    if (exe) return join(macosDir, exe);
  }
  throw new Error(`no packaged .app found under ${outDir}`);
}

// Kill the whole process group, not just the electron parent: Electron does not
// reliably reap its spawned daemon child on SIGTERM, so a bare kill orphans a bun
// server holding the persisted port. A later run would then render the shell off
// that stale daemon instead of its own — a false pass. The app is launched
// detached (its own group), so a negative-pid signal takes the daemon with it.
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function shutdown(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((res) => {
    const forceKill = setTimeout(() => killGroup(child, 'SIGKILL'), 3_000);
    child.once('exit', () => {
      clearTimeout(forceKill);
      res();
    });
    killGroup(child, 'SIGTERM');
  });
}

function dumpArtifacts(screenshotBase64) {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'main-process.log'), logBuffer);
  if (screenshotBase64) {
    writeFileSync(join(artifactsDir, 'boot.png'), Buffer.from(screenshotBase64, 'base64'));
  }
}

function captureShot(cdp) {
  if (!cdp) return Promise.resolve(null);
  return cdp
    .send('Page.captureScreenshot', { format: 'png' })
    .then((r) => r.data)
    .catch(() => null);
}

function probeShell(cdp) {
  return cdp
    .send('Runtime.evaluate', {
      expression: `(() => {
        const rail = document.querySelector('${SHELL_SELECTOR}');
        const root = document.querySelector('#root');
        return {
          hasShell: !!rail && rail.getBoundingClientRect().width > 0,
          rootLen: root ? root.innerHTML.trim().length : 0,
          visible: document.visibilityState,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    .then((r) => r.result.value);
}

rmSync(artifactsDir, { recursive: true, force: true });

let child = null;
let cdp = null;
let failureShot = null;
try {
  run('bun run build:resources');
  run('bunx electron-builder --config electron-builder.config.cjs --dir', {
    NUNCIO_CHANNEL: channel,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });

  const binary = findPackagedBinary();
  record(`\nlaunching ${binary} --remote-debugging-port=0\n`);

  child = spawn(binary, ['--remote-debugging-port=0'], {
    cwd: desktopDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so shutdown can take the spawned daemon child down too.
    detached: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  let earlyExit = null;
  child.on('exit', (code) => {
    earlyExit = code;
  });

  // Chromium prints its chosen DevTools port to stderr; parse it to find the endpoint.
  let devtoolsPort = null;
  child.stdout.on('data', (b) => record(`[main] ${b}`));
  child.stderr.on('data', (b) => {
    const text = String(b);
    record(`[main:err] ${text}`);
    const match = text.match(DEVTOOLS_RE);
    if (match && devtoolsPort === null) devtoolsPort = Number(match[1]);
  });

  const portDeadline = Date.now() + 60_000;
  while (devtoolsPort === null && Date.now() < portDeadline) {
    if (earlyExit !== null) throw new Error(`electron exited early with code ${earlyExit}`);
    await sleep(300);
  }
  if (devtoolsPort === null) throw new Error('electron never opened a DevTools endpoint');

  const page = await waitForAppPageTarget(devtoolsPort, Date.now() + 40_000);
  record(`\nattached to app page ${page.url}\n`);

  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  let rendered = null;
  const renderDeadline = Date.now() + 30_000;
  while (Date.now() < renderDeadline) {
    if (earlyExit !== null) throw new Error(`electron exited early with code ${earlyExit}`);
    const state = await probeShell(cdp);
    if (state.hasShell && state.rootLen > 0) {
      rendered = state;
      break;
    }
    await sleep(700);
  }
  if (!rendered) {
    failureShot = await captureShot(cdp);
    throw new Error('app shell never rendered — blank window (#root empty or rail missing)');
  }
  if (rendered.visible !== 'visible') throw new Error(`main window is not visible (${rendered.visible})`);

  const fatal = FATAL_MAIN_MARKERS.find((marker) => logBuffer.includes(marker));
  if (fatal) throw new Error(`uncaught main-process error in log: "${fatal}"`);
  if (earlyExit !== null) throw new Error(`electron exited early with code ${earlyExit}`);

  cdp.close();
  await shutdown(child);
  record(`\n✓ desktop boot smoke passed (shell rendered, #root ${rendered.rootLen} chars)\n`);
  process.exit(0);
} catch (error) {
  record(`\n✗ desktop boot smoke failed: ${error?.stack || error}\n`);
  if (!failureShot) failureShot = await captureShot(cdp);
  dumpArtifacts(failureShot);
  try {
    cdp?.close();
    await shutdown(child);
  } catch {
    // The app may already be gone; artifacts are already written.
  }
  process.exit(1);
}
