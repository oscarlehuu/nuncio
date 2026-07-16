const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
