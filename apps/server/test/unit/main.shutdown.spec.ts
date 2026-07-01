import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (code ${child.exitCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy before timeout: ${stderr()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not exit within ${timeoutMs}ms after SIGTERM`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('main shutdown signal handling', () => {
  it(
    'closes the HTTP listener and exits cleanly on repeated shutdown signals',
    async () => {
      const port = await getFreePort();
      const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-shutdown-data-'));
      const rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-shutdown-roots-'));
      const workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-shutdown-ws-'));
      mkdirSync(join(rootsDir, 'empty-project'), { recursive: true });

      const child = spawn('bun', ['src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          NUNCIO_DATA_DIR: dataDir,
          NUNCIO_PROJECT_ROOTS: rootsDir,
          NUNCIO_WORKSPACES_DIR: workspacesDir,
          CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? 'nuncio-test-cursor-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      try {
        await waitForHealth(port, child, () => stderr);

        const exitPromise = waitForExit(child, 3_000);
        const startedShutdownAt = Date.now();
        child.kill('SIGTERM');
        child.kill('SIGINT');

        const exit = await exitPromise;
        expect(Date.now() - startedShutdownAt).toBeLessThan(3_000);
        expect(exit).toEqual({ code: 0, signal: null });
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await new Promise((resolve) => child.once('exit', resolve));
        }
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(rootsDir, { recursive: true, force: true });
        rmSync(workspacesDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
