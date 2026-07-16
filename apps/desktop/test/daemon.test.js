const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { DaemonSupervisor, findFreePort, resolveBunPath, waitForHealth } = require('../src/daemon.js');
const {
  resolveDataDir,
  readPersistedPort,
  resolveStablePort,
  portFilePath,
} = require('../src/daemon-port.js');

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

  test('waitForHealth treats a non-200 /api/health as unhealthy', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(request.url === '/api/health' ? 503 : 404);
      response.end();
    });
    const address = await listen(server);

    try {
      const healthy = await waitForHealth(address.port, { timeoutMs: 200, intervalMs: 20 });
      expect(healthy).toBe(false);
    } finally {
      await close(server);
    }
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

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-daemon-port-'));
}

async function occupyPort() {
  const server = net.createServer();
  const address = await listen(server);
  return { port: address.port, release: () => close(server) };
}

describe('stable daemon port', () => {
  test('resolveDataDir honors NUNCIO_DATA_DIR and expands a ~ prefix', () => {
    expect(resolveDataDir({ NUNCIO_DATA_DIR: '/abs/data' })).toBe('/abs/data');
    expect(resolveDataDir({ NUNCIO_DATA_DIR: '~/.nuncio/data' })).toBe(
      path.join(os.homedir(), '.nuncio', 'data'),
    );
    expect(resolveDataDir({})).toBe(path.join(os.homedir(), '.nuncio', 'data'));
  });

  test('reuses a persisted port when it is free', async () => {
    const dataDir = tempDataDir();
    const free = await findFreePort();
    fs.writeFileSync(portFilePath(dataDir), `${free}\n`);

    const chosen = await resolveStablePort({
      dataDir,
      findFreePort: () => Promise.reject(new Error('should not be called')),
    });

    expect(chosen).toBe(free);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('picks a new port and re-persists when the persisted one is occupied', async () => {
    const dataDir = tempDataDir();
    const held = await occupyPort();
    fs.writeFileSync(portFilePath(dataDir), `${held.port}\n`);
    const fresh = await findFreePort();

    try {
      const chosen = await resolveStablePort({ dataDir, findFreePort: () => Promise.resolve(fresh) });
      expect(chosen).toBe(fresh);
      // The new value must be written back for the next launch.
      expect(readPersistedPort(dataDir)).toBe(fresh);
    } finally {
      await held.release();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('leases a fresh port when the port file is missing', async () => {
    const dataDir = tempDataDir();
    const fresh = await findFreePort();

    const chosen = await resolveStablePort({ dataDir, findFreePort: () => Promise.resolve(fresh) });

    expect(chosen).toBe(fresh);
    expect(readPersistedPort(dataDir)).toBe(fresh);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('ignores a corrupt port file and leases a fresh port', async () => {
    const dataDir = tempDataDir();
    fs.writeFileSync(portFilePath(dataDir), 'not-a-port\n');
    expect(readPersistedPort(dataDir)).toBeNull();
    const fresh = await findFreePort();

    const chosen = await resolveStablePort({ dataDir, findFreePort: () => Promise.resolve(fresh) });

    expect(chosen).toBe(fresh);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('rejects out-of-range persisted ports', () => {
    const dataDir = tempDataDir();
    for (const bad of ['0', '-5', '70000']) {
      fs.writeFileSync(portFilePath(dataDir), `${bad}\n`);
      expect(readPersistedPort(dataDir)).toBeNull();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('ignores an oversized port file and leases a fresh port', async () => {
    const dataDir = tempDataDir();
    // A leading valid-looking number followed by megabytes of junk must not be slurped.
    fs.writeFileSync(portFilePath(dataDir), `3300${'x'.repeat(1_000_000)}`);
    expect(readPersistedPort(dataDir)).toBeNull();

    const fresh = await findFreePort();
    const chosen = await resolveStablePort({ dataDir, findFreePort: () => Promise.resolve(fresh) });
    expect(chosen).toBe(fresh);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('persist failure is non-fatal: still returns a usable port', async () => {
    // Point dataDir at a path whose parent is a file, so mkdir/write must fail.
    const parentFile = path.join(os.tmpdir(), `nuncio-not-a-dir-${Date.now()}`);
    fs.writeFileSync(parentFile, 'x');
    const dataDir = path.join(parentFile, 'data');
    const fresh = await findFreePort();
    const logs = [];

    const chosen = await resolveStablePort({
      dataDir,
      findFreePort: () => Promise.resolve(fresh),
      log: (m) => logs.push(m),
    });

    expect(chosen).toBe(fresh);
    expect(logs.some((m) => m.includes('could not persist port'))).toBe(true);
    fs.rmSync(parentFile, { force: true });
  });
});
