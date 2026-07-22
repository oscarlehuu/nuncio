#!/usr/bin/env bun
/**
 * Packaged-desktop boot smoke.
 *
 * Builds an UNSIGNED packaged app (`electron-builder --dir`, no notarization),
 * launches the real packaged binary, attaches to its renderer over the Chrome
 * DevTools Protocol (see cdp-client.mjs for why raw CDP instead of Playwright),
 * and asserts the app actually boots against an isolated loopback daemon: the
 * app shell is present and sized (a blank window — renderer that couldn't reach
 * the daemon — leaves #root empty), that exact backend remains alive and healthy,
 * no fatal runtime evidence appears, then the smoke process group shuts down cleanly.
 *
 * The mock provider never registers in packaged builds, so this asserts the shell
 * renders and the local server booted — it does NOT create sessions.
 *
 * On failure, a screenshot (when a renderer is reachable) + the captured
 * main-process log land in smoke-artifacts/.
 */
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitForAppPageTarget, connectCdp } from './cdp-client.mjs';
import { assertRuntimeOwnership } from './smoke-runtime-ownership.mjs';
import { resolveSmokeAppDataRoot } from '../src/pre-lock-app-paths.js';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.env.NUNCIO_CHANNEL || 'stable';
const artifactsDir = join(desktopDir, 'smoke-artifacts');

// Present on every route of the app shell (the hover rail lives outside <Routes>).
// If a redesign renames it, the same PR runs this smoke (web paths are in the CI
// filter) and the author updates it here.
const SHELL_SELECTOR = '[data-testid="desktop-sidebar-rail"]';
const DEVTOOLS_RE = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//;
const OWNERSHIP_STABILITY_MS = 2_000;
const HEALTH_TIMEOUT_MS = 2_000;
const MAX_PORT_FILE_BYTES = 64;

let logBuffer = '';
function record(chunk) {
  logBuffer += chunk;
  process.stdout.write(chunk);
}

function run(cmd, env = {}) {
  record(`\n$ ${cmd}\n`);
  execSync(cmd, { cwd: desktopDir, stdio: 'inherit', env: { ...process.env, ...env } });
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('failed to lease an isolated smoke port'));
        else resolvePort(port);
      });
    });
  });
}

async function probeDaemonHealth(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The ownership assertion rejects non-JSON or malformed health payloads.
    }
    return { port, statusCode: response.status, body };
  } catch (error) {
    return {
      port,
      statusCode: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readSmokeDaemonPort(filePath) {
  const size = statSync(filePath).size;
  if (size <= 0 || size > MAX_PORT_FILE_BYTES) {
    throw new Error(`isolated daemon-port file has invalid size ${size}`);
  }
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!/^\d{1,5}$/.test(raw)) {
    throw new Error(`isolated daemon-port file is malformed: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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
          rendererUrl: window.location.href,
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
let electronExit = null;
let spawnError = null;
let smokeRoot = null;
try {
  run('bun run build:resources');
  run('bunx electron-builder --config electron-builder.config.cjs --dir', {
    NUNCIO_CHANNEL: channel,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });

  smokeRoot = mkdtempSync(join(tmpdir(), 'nuncio-desktop-smoke-'));
  const smokeHome = join(smokeRoot, 'home');
  const smokeDataDir = join(smokeHome, '.nuncio', 'data');
  const smokeAppDataRoot = join(smokeDataDir, 'electron-app-data');
  const smokeUserData = join(smokeAppDataRoot, 'Nuncio');
  const smokePortFile = join(smokeDataDir, 'daemon-port');
  const smokeNonce = randomBytes(32).toString('hex');
  const smokeEnvironment = {
    HOME: smokeHome,
    NUNCIO_DATA_DIR: smokeDataDir,
    NUNCIO_DESKTOP_SMOKE_TEMP_ROOT: smokeRoot,
    NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT: smokeAppDataRoot,
    NUNCIO_DESKTOP_SMOKE_NONCE: smokeNonce,
  };
  // Validate the same boundary main.js enforces before touching Electron's
  // single-instance namespace. HOME alone does not re-home appData on macOS.
  if (resolveSmokeAppDataRoot(smokeEnvironment) !== smokeAppDataRoot) {
    throw new Error('smoke appData root did not resolve to the requested temporary path');
  }
  mkdirSync(smokeAppDataRoot, { recursive: true });
  const smokePort = await findFreePort();
  writeFileSync(smokePortFile, `${smokePort}\n`);
  record(
    `\nsmoke isolation\n  HOME=${smokeHome}\n  NUNCIO_DATA_DIR=${smokeDataDir}\n  pre-lock appData=${smokeAppDataRoot}\n  pre-lock userData=${smokeUserData}\n  daemon port=${smokePort}\n`,
  );

  const binary = findPackagedBinary();
  record(`\nlaunching ${binary} --remote-debugging-port=0\n`);

  child = spawn(binary, ['--remote-debugging-port=0'], {
    cwd: desktopDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so shutdown can take the spawned daemon child down too.
    detached: true,
    env: {
      ...process.env,
      ...smokeEnvironment,
      NUNCIO_DESKTOP_DEV: '0',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });

  child.once('error', (error) => {
    spawnError = error;
    record(`[main:spawn-error] ${error.stack || error}\n`);
  });
  child.on('exit', (code, signal) => {
    electronExit = { code, signal };
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
    if (spawnError) throw spawnError;
    if (electronExit) {
      throw new Error(
        `electron exited before DevTools opened (code=${electronExit.code ?? 'null'} signal=${electronExit.signal ?? 'null'})`,
      );
    }
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
    if (spawnError) throw spawnError;
    if (electronExit) {
      throw new Error(
        `electron exited before the shell rendered (code=${electronExit.code ?? 'null'} signal=${electronExit.signal ?? 'null'})`,
      );
    }
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

  // A foreign daemon can answer health quickly enough to make the shell render.
  // Keep the packaged app up beyond initial render, then require exact-port Nuncio
  // health and no evidence that the daemon exited, restarted, or lost its bind.
  await sleep(OWNERSHIP_STABILITY_MS);
  const health = await probeDaemonHealth(smokePort);
  const persistedPort = readSmokeDaemonPort(smokePortFile);
  record(
    `\nownership health ${JSON.stringify(health)}\nrenderer URL ${rendered.rendererUrl}\ndaemon-port file ${persistedPort}\n`,
  );
  assertRuntimeOwnership({
    log: logBuffer,
    expectedPort: smokePort,
    expectedNonce: smokeNonce,
    expectedAppDataRoot: smokeAppDataRoot,
    expectedUserData: smokeUserData,
    rendererUrl: rendered.rendererUrl,
    persistedPort,
    electronExit,
    spawnError,
    health,
  });

  cdp.close();
  cdp = null;
  await shutdown(child);
  child = null;
  rmSync(smokeRoot, { recursive: true, force: true });
  smokeRoot = null;
  record(
    `\n✓ desktop boot smoke passed (owned daemon healthy on ${smokePort}, shell rendered, #root ${rendered.rootLen} chars)\n`,
  );
  process.exit(0);
} catch (error) {
  record(`\n✗ desktop boot smoke failed: ${error?.stack || error}\n`);
  if (!failureShot) failureShot = await captureShot(cdp);
  try {
    dumpArtifacts(failureShot);
  } catch (artifactError) {
    record(`\nfailed to write smoke artifacts: ${artifactError?.stack || artifactError}\n`);
  }
  try {
    cdp?.close();
    await shutdown(child);
  } catch (shutdownError) {
    record(`\nfailed to shut down smoke process group: ${shutdownError?.stack || shutdownError}\n`);
  }
  if (smokeRoot) {
    try {
      rmSync(smokeRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      record(`\nfailed to remove smoke isolation directory: ${cleanupError?.stack || cleanupError}\n`);
    }
  }
  process.exit(1);
}
