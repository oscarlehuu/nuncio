import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket as WsClient } from 'ws';

const SERVER_DIR = resolve(__dirname, '../../..');
const NON_OBJECT_JSON = [null, [], [{ type: 'start' }], 'start', '终端', 0, -1, false];

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      server.close(() => resolvePort(address.port));
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
      if (response.status === 200) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`server did not become healthy before timeout: ${stderr()}`);
}

async function connect(url: string): Promise<WsClient> {
  const ws = new WsClient(url);
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', resolveOpen);
    ws.once('error', reject);
  });
  return ws;
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited after WebSocket input (code ${child.exitCode}): ${stderr()}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for WebSocket response: ${stderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) =>
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolveTimeout();
      }, 3_000),
    ),
  ]);
}

async function closeSocket(ws: WsClient): Promise<void> {
  if (ws.readyState === WsClient.CLOSED) return;
  await new Promise<void>((resolveClose) => {
    ws.once('close', resolveClose);
    ws.close();
  });
}

describe('production fatal handlers reject non-object WebSocket JSON', () => {
  it.each([
    { protocol: 'sessions', path: '/api/sessions/ws' },
    { protocol: 'terminal', path: '/api/terminal' },
  ])('$protocol messages do not terminate the daemon', async ({ protocol, path }) => {
    const port = await getFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-ws-shape-data-'));
    const rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-ws-shape-roots-'));
    const workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-ws-shape-workspaces-'));
    mkdirSync(join(rootsDir, 'empty-project'), { recursive: true });

    const child = spawn('bun', ['src/main.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        NUNCIO_DATA_DIR: dataDir,
        NUNCIO_PROJECT_ROOTS: rootsDir,
        NUNCIO_WORKSPACES_DIR: workspacesDir,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? 'nuncio-test-cursor-key',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    let ws: WsClient | null = null;

    try {
      await waitForHealth(port, child, () => stderr);
      ws = await connect(`ws://127.0.0.1:${port}${path}`);
      const messages: Array<Record<string, unknown>> = [];
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString('utf8'))));

      for (const value of NON_OBJECT_JSON) ws.send(JSON.stringify(value));

      if (protocol === 'sessions') {
        await waitFor(() => messages.length === NON_OBJECT_JSON.length, child, () => stderr);
        expect(messages.every((message) => (message.error as { code?: number })?.code === 400)).toBe(true);
        ws.send(JSON.stringify({ id: 99, method: 'unsubscribe', params: {} }));
        await waitFor(() => messages.some((message) => message.id === 99), child, () => stderr);
      } else {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        expect(child.exitCode).toBeNull();
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        expect(health.status).toBe(200);
      }
    } finally {
      if (ws) await closeSocket(ws).catch(() => {});
      await stopChild(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(rootsDir, { recursive: true, force: true });
      rmSync(workspacesDir, { recursive: true, force: true });
    }
  }, 30_000);
});
