const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DaemonSupervisor, findFreePort, waitForHealth } = require('../src/daemon.js');

const healthFixture = path.resolve(__dirname, 'fixtures/health-server.mjs');

// Isolate every supervisor.start() from the shared ~/.nuncio/data: start() now
// resolves a *stable* persisted port, so without an override a test would read and
// re-persist the real daemon's port file. Each test gets its own throwaway data dir.
const tempDataDirs = [];
function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-daemon-sup-'));
  tempDataDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDataDirs.length > 0) {
    fs.rmSync(tempDataDirs.pop(), { recursive: true, force: true });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (child.exitCode !== null || child.signalCode !== null) return false;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

describe('DaemonSupervisor restart policy', () => {
  test('stops restarting once the restart cap is reached', () => {
    const logs = [];
    const supervisor = new DaemonSupervisor({ log: (message) => logs.push(message) });
    let spawns = 0;
    supervisor.spawnDaemon = () => {
      spawns += 1;
    };
    supervisor.restartAttempts = supervisor.maxRestarts;

    supervisor.restartAfterUnexpectedExit();

    expect(spawns).toBe(0);
    expect(logs.some((line) => line.includes('restart cap reached'))).toBe(true);
  });

  test('still restarts on the last attempt below the cap (boundary)', async () => {
    const closedPort = await findFreePort();
    const supervisor = new DaemonSupervisor({
      log: () => {},
      healthTimeoutMs: 30,
      healthIntervalMs: 10,
      maxRestarts: 3,
    });
    supervisor.port = closedPort;
    let spawns = 0;
    supervisor.spawnDaemon = () => {
      spawns += 1;
    };
    supervisor.restartAttempts = supervisor.maxRestarts - 1;

    supervisor.restartAfterUnexpectedExit();
    expect(supervisor.restartAttempts).toBe(supervisor.maxRestarts);
    // Scheduled, not synchronous.
    expect(spawns).toBe(0);

    await sleep(400);
    expect(spawns).toBe(1);
  });

  test('a deliberate stop cancels a queued restart', async () => {
    const supervisor = new DaemonSupervisor({ log: () => {} });
    let spawns = 0;
    supervisor.spawnDaemon = () => {
      spawns += 1;
    };

    supervisor.restartAfterUnexpectedExit();
    supervisor.stopping = true; // stop() flips this before the 250ms timer fires

    await sleep(400);
    expect(spawns).toBe(0);
  });

  test('terminates an unhealthy replacement and schedules the next capped retry', async () => {
    const supervisor = new DaemonSupervisor({
      log: () => {},
      maxRestarts: 2,
      restartDelayMs: 0,
      healthCheck: async () => false,
      healthTimeoutMs: 20,
      healthIntervalMs: 5,
      killGraceMs: 20,
    });
    supervisor.port = await findFreePort();
    const children = [];
    supervisor.spawnDaemon = () => {
      const child = fakeChild();
      children.push(child);
      supervisor.child = child;
      return child;
    };

    supervisor.restartAfterUnexpectedExit();

    expect(await waitFor(() => children.length === 2, 1_500)).toBe(true);
    expect(await waitFor(() => children.every((child) => child.killCalls.length === 1), 500)).toBe(true);
    expect(supervisor.restartAttempts).toBe(2);
    expect(supervisor.child).toBeNull();
  });

  test('coalesces duplicate restart requests while replacement health is pending', async () => {
    let settleHealth;
    const supervisor = new DaemonSupervisor({
      log: () => {},
      maxRestarts: 2,
      restartDelayMs: 0,
      healthCheck: () => new Promise((resolve) => {
        settleHealth = resolve;
      }),
      healthTimeoutMs: 1_000,
    });
    supervisor.port = await findFreePort();
    const children = [];
    supervisor.spawnDaemon = () => {
      const child = fakeChild();
      children.push(child);
      supervisor.child = child;
      return child;
    };

    supervisor.restartAfterUnexpectedExit();
    supervisor.restartAfterUnexpectedExit();

    expect(await waitFor(() => children.length > 0, 800)).toBe(true);
    await sleep(300);
    expect(children).toHaveLength(1);
    settleHealth?.(true);
  });

  test('stop during replacement health reaps the child and suppresses later retry', async () => {
    let settleHealth;
    const supervisor = new DaemonSupervisor({
      log: () => {},
      maxRestarts: 3,
      restartDelayMs: 0,
      healthCheck: () => new Promise((resolve) => {
        settleHealth = resolve;
      }),
      healthTimeoutMs: 1_000,
      killGraceMs: 20,
    });
    supervisor.port = await findFreePort();
    const children = [];
    supervisor.spawnDaemon = () => {
      const child = fakeChild();
      children.push(child);
      supervisor.child = child;
      return child;
    };

    supervisor.restartAfterUnexpectedExit();
    expect(await waitFor(() => children.length === 1, 800)).toBe(true);
    await supervisor.stop();
    settleHealth?.(false);
    await sleep(100);

    expect(children).toHaveLength(1);
    expect(children[0].killCalls).toEqual(['SIGTERM']);
    expect(supervisor.child).toBeNull();
  });
});

describe('DaemonSupervisor real reconnect', () => {
  test('respawns the daemon after an unexpected exit and becomes healthy again', async () => {
    const dataDir = makeTempDataDir();
    const supervisor = new DaemonSupervisor({
      bunPath: process.execPath,
      serverBinaryPath: null,
      entryPath: healthFixture,
      cwd: __dirname,
      // Point the persisted-port resolution at a throwaway dir, never ~/.nuncio/data.
      env: { ...process.env, NUNCIO_DATA_DIR: dataDir },
      healthTimeoutMs: 5_000,
      healthIntervalMs: 50,
      killGraceMs: 1_000,
      maxRestarts: 3,
      log: () => {},
    });

    try {
      const { port } = await supervisor.start();
      expect(supervisor.child).toBeTruthy();
      const firstPid = supervisor.child.pid;

      // Simulate a crash: hard-kill the child out from under the supervisor.
      supervisor.child.kill('SIGKILL');

      const respawned = await waitFor(
        () => supervisor.child && supervisor.child.pid !== firstPid,
        4_500,
      );
      expect(respawned).toBe(true);
      expect(supervisor.restartAttempts).toBe(1);
      expect(isPidAlive(supervisor.child.pid)).toBe(true);
      expect(await waitForHealth(port, { timeoutMs: 2_000, intervalMs: 50 })).toBe(true);
    } finally {
      await supervisor.stop();
    }
  });
});
