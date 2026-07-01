const { afterEach, describe, expect, test } = require('bun:test');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const { DaemonSupervisor, findFreePort, resolveBunPath, waitForHealth } = require('../src/daemon.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve(true);
      return;
    }
    if (child.signalCode !== null && child.signalCode !== undefined) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };

    child.once('exit', onExit);
  });
}

function waitForReady(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('dummy child did not become ready'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk) => {
      if (String(chunk).includes('ready')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`dummy child exited early code=${code} signal=${signal}`));
    };

    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

function isPidAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('desktop daemon helpers', () => {
  const originalBunPath = process.env.NUNCIO_BUN_PATH;

  afterEach(() => {
    if (originalBunPath === undefined) {
      delete process.env.NUNCIO_BUN_PATH;
    } else {
      process.env.NUNCIO_BUN_PATH = originalBunPath;
    }
  });

  test('findFreePort returns a released TCP port usable by a later server', async () => {
    const port = await findFreePort();

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);

    const server = net.createServer();
    await listen(server, port);
    await close(server);
  });

  test('waitForHealth returns true once /api/health responds 200', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', service: 'nuncio-server' }));
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const address = await listen(server);

    try {
      const healthy = await waitForHealth(address.port, { timeoutMs: 1_000, intervalMs: 20 });
      expect(healthy).toBe(true);
    } finally {
      await close(server);
    }
  });

  test('waitForHealth returns false on timeout when the port is closed', async () => {
    const closedPort = await findFreePort();

    const healthy = await waitForHealth(closedPort, { timeoutMs: 100, intervalMs: 20 });

    expect(healthy).toBe(false);
  });

  test('resolveBunPath prefers NUNCIO_BUN_PATH when set', () => {
    process.env.NUNCIO_BUN_PATH = '/tmp/nuncio-test-bun';

    expect(resolveBunPath()).toBe('/tmp/nuncio-test-bun');
  });

  test('DaemonSupervisor.stop force-kills a child that ignores SIGTERM', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.stdout.write("ready\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const supervisor = new DaemonSupervisor({ killGraceMs: 300, log: () => {} });
    supervisor.child = child;

    try {
      await waitForReady(child);
      expect(isPidAlive(child.pid)).toBe(true);

      const result = await Promise.race([
        supervisor.stop().then(() => 'stopped'),
        sleep(2_000).then(() => 'timeout'),
      ]);

      expect(result).toBe('stopped');
      expect(await waitForExit(child, 2_000)).toBe(true);
      expect(isPidAlive(child.pid)).toBe(false);
    } finally {
      if (isPidAlive(child.pid)) {
        child.kill('SIGKILL');
        await waitForExit(child, 2_000);
      }
    }
  });
});
