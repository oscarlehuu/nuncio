// Isolated Nuncio stack for the level-5 UI smoke: builds the web bundle if
// needed, then boots the server on an EPHEMERAL free port with a FRESH temp
// NUNCIO_DATA_DIR so it never touches the canonical dev ports (3000/5173) or the
// user's real data dir (~/.nuncio/data). The server serves apps/web/dist
// same-origin, so no Vite dev server is involved. Exposes helpers the smoke
// script composes; all process/dir lifecycle is owned here so cleanup is central.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '..');
export const webDist = join(repoRoot, 'apps/web/dist');
const serverDir = join(repoRoot, 'apps/server');
const serverEntry = join(serverDir, 'src/main.ts');

const CANONICAL_PORTS = new Set([3000, 5173]);

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

async function run(cmd, args, opts) {
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
 * Boot the server on `port` against a fresh temp data dir with the Mock provider
 * opted in (NUNCIO_FORCE_MOCK=1). Resolves once /api/health is green. The caller
 * must invoke the returned `stop()` to kill the child + remove the temp dir.
 */
export async function startServer({ port, healthTimeoutMs = 45000 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nuncio-smoke-ui-'));
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: serverDir, // tsconfig with decorator metadata resolves from apps/server
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      NUNCIO_DATA_DIR: dataDir,
      NUNCIO_WEB_DIST: webDist,
      NUNCIO_FORCE_MOCK: '1',
      // Keep the smoke off any real project roots / workspaces.
      NUNCIO_PROJECT_ROOTS: dataDir,
      NUNCIO_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    },
  });

  const logs = [];
  const capture = (buf) => logs.push(buf.toString());
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
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
    await rm(dataDir, { recursive: true, force: true });
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
