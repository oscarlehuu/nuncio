// Shared hermetic Nuncio-daemon boot recipe, consumed by BOTH the level-5 UI
// smoke (scripts/smoke-ui.mjs) and the behavioral eval runner
// (scripts/engine-eval.mjs). Every daemon booted here is isolated by
// construction: an EPHEMERAL free port (never the canonical 3000/5173) and a
// FRESH temp NUNCIO_DATA_DIR (never the user's ~/.nuncio/data). The caller owns
// the returned stop() and MUST invoke it to kill the child and remove the temp
// dir. All process/dir lifecycle is centralized here so cleanup stays in one
// place.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const libDir = dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → repo root is two levels up.
export const repoRoot = resolve(libDir, '..', '..');
export const webDist = join(repoRoot, 'apps/web/dist');
const serverDir = join(repoRoot, 'apps/server');

const CANONICAL_PORTS = new Set([3000, 5173]);

// Every live daemon registers its { child, dataDir } here so a process exit
// (including a signal that lands DURING boot, before the caller has a stop()
// handle) can never orphan a daemon or leak its temp dir. Handlers below are
// installed exactly once. The 'exit' handler is synchronous by necessity —
// Node ignores async work there — so it SIGKILLs and rmSync's.
const liveStacks = new Set();
let exitNetInstalled = false;

function installExitNet() {
  if (exitNetInstalled) return;
  exitNetInstalled = true;
  process.on('exit', () => {
    for (const { child, dataDir } of liveStacks) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        // already gone
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
  // Turn signals into a normal exit so the 'exit' handler runs, then leave with
  // a non-zero code. Callers may add their own handlers too; process.once here
  // fires once and process.exit re-enters synchronously.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => process.exit(1));
  }
}

/** Ask the OS for a free TCP port; never returns a canonical dev port. */
export function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => {
        if (err) return reject(err);
        if (CANONICAL_PORTS.has(port)) return resolvePort(findFreePort());
        resolvePort(port);
      });
    });
  });
}

function run(cmd, args, opts) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', rej);
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });
}

/** Build apps/web/dist when missing, or always when force is true. */
export async function ensureWebBuild({ force = false } = {}) {
  if (!force && existsSync(join(webDist, 'index.html'))) return false;
  console.log(`[smoke] building web bundle${force ? ' (--build forced)' : ''}…`);
  await run(process.execPath, ['run', '--filter', '@nuncio/web', 'build'], { cwd: repoRoot });
  return true;
}

/**
 * Boot the server on `port` against a fresh temp NUNCIO_DATA_DIR with the Mock
 * provider opted in (NUNCIO_FORCE_MOCK=1). Resolves once /api/health is green.
 *
 * @param {object}  opts
 * @param {number}  opts.port              ephemeral port from findFreePort()
 * @param {number}  [opts.healthTimeoutMs] boot deadline (default 45s)
 * @param {string}  [opts.serveWebDist]    when set, serves that dist same-origin
 *                                         (the UI smoke needs it; the eval runner
 *                                         is headless and omits it, so no bundle
 *                                         build is required to run evals)
 * @param {object}  [opts.env]             extra env merged OVER the defaults
 *                                         (e.g. NUNCIO_VERIFY_COMMAND for evals)
 * @param {string}  [opts.dataDir]         reuse an EXISTING data dir instead of a
 *                                         fresh temp one — used to reboot on the
 *                                         same durable DB (WS-reconnect smoke). The
 *                                         caller then owns removing it; pass
 *                                         `stop({ removeDataDir:false })` when the
 *                                         dir must outlive this process for a reboot.
 * @returns {Promise<{baseUrl,dataDir,port,stop,logs}>}
 */
export async function startServer({
  port,
  healthTimeoutMs = 45000,
  serveWebDist,
  env = {},
  dataDir: reuseDataDir,
} = {}) {
  const dataDir = reuseDataDir ?? (await mkdtemp(join(tmpdir(), 'nuncio-hermetic-')));
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: serverDir, // tsconfig with decorator metadata resolves from apps/server
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      NUNCIO_DATA_DIR: dataDir,
      ...(serveWebDist ? { NUNCIO_WEB_DIST: serveWebDist } : {}),
      NUNCIO_FORCE_MOCK: '1',
      // Keep the daemon off any real project roots / workspaces.
      NUNCIO_PROJECT_ROOTS: dataDir,
      NUNCIO_WORKSPACES_DIR: join(dataDir, 'workspaces'),
      // Background fact distillation would fire real Pi completions on authed
      // dev machines after every substantive eval run — hermetic runs stay
      // cost-free by default (a task's env override can still opt in).
      NUNCIO_FACT_DISTILLATION: 'off',
      // Caller overrides win (verify command, routing, etc.).
      ...env,
    },
  });

  // Register for the exit safety net immediately — before health-wait — so a
  // signal mid-boot still tears this daemon + its dir down.
  installExitNet();
  const stackHandle = { child, dataDir };
  liveStacks.add(stackHandle);

  const logs = [];
  const capture = (buf) => logs.push(buf.toString());
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let stopped = false;
  // removeDataDir:false tears down the process but KEEPS the DB on disk, so a
  // caller can reboot on the same durable state (the WS-reconnect smoke).
  const stop = async ({ removeDataDir = true } = {}) => {
    if (stopped) return;
    stopped = true;
    liveStacks.delete(stackHandle);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 3000);
        child.on('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    if (removeDataDir) await rm(dataDir, { recursive: true, force: true });
  };

  // Fail fast if the child dies before it becomes healthy.
  let exitedEarly = null;
  child.on('exit', (code, signal) => {
    if (!stopped) exitedEarly = `server exited early (code=${code} signal=${signal})`;
  });

  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (exitedEarly) {
      await stop();
      throw new Error(`${exitedEarly}\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.status === 'ok') return { baseUrl, dataDir, port, stop, logs };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  throw new Error(`server /api/health not ready within ${healthTimeoutMs}ms\n${logs.join('')}`);
}
