const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveDataDir, resolveStablePort } = require('./daemon-port');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_INTERVAL_MS = 200;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_KILL_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBunPath() {
  if (process.env.NUNCIO_BUN_PATH) {
    return path.resolve(process.env.NUNCIO_BUN_PATH);
  }

  const candidates = [
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'bun';
}

function findFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!port) {
          reject(new Error('Unable to lease a free TCP port'));
          return;
        }

        resolve(port);
      });
    });
  });
}

function hasChildExited(child) {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function requestHealth(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: '/api/health',
        timeout: 1_000,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode === 200));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForHealth(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const host = options.host ?? DEFAULT_HOST;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (await requestHealth(port, host)) {
      return true;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return false;
}

class DaemonSupervisor {
  constructor(options = {}) {
    const repoRoot = path.resolve(__dirname, '../../..');

    this.host = options.host ?? DEFAULT_HOST;
    this.bunPath = options.bunPath ?? resolveBunPath();
    this.serverDir = options.serverDir ?? path.join(repoRoot, 'apps', 'server');
    this.entryPath = options.entryPath ?? path.join(this.serverDir, 'src', 'main.ts');
    // Both packaged and dev builds launch `bun <entryPath>` (packaged points
    // bunPath/entryPath into Resources so @cursor/sdk resolves from the staged
    // node_modules). serverBinaryPath remains as an escape hatch for spawning a
    // prebuilt executable directly.
    this.serverBinaryPath = options.serverBinaryPath ?? null;
    this.cwd = options.cwd ?? this.serverDir;
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((message) => console.log(message));
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.restartDelayMs = options.restartDelayMs ?? 250;
    this.healthCheck = options.healthCheck ?? waitForHealth;

    this.child = null;
    this.port = null;
    this.url = null;
    this.stopping = false;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.restartInFlight = null;
    this.stopPromise = null;
    this.expectedExits = new WeakSet();
  }

  async start() {
    this.stopping = false;
    this.restartAttempts = 0;
    // Reuse a persisted port when it is still free so LAN QR URLs (http://<ip>:<port>)
    // saved on a phone survive desktop restarts; only fall back to a random port.
    this.port = await resolveStablePort({
      dataDir: resolveDataDir(this.env),
      findFreePort,
      host: this.host,
      log: this.log,
    });
    this.url = `http://${this.host}:${this.port}/`;

    this.spawnDaemon();

    const healthy = await this.healthCheck(this.port, {
      host: this.host,
      timeoutMs: this.healthTimeoutMs,
      intervalMs: this.healthIntervalMs,
    });

    if (!healthy) {
      await this.stop();
      throw new Error(`Nuncio daemon did not become healthy within ${this.healthTimeoutMs}ms`);
    }

    return { port: this.port, url: this.url };
  }

  spawnDaemon() {
    const [command, args] = this.serverBinaryPath
      ? [this.serverBinaryPath, []]
      : [this.bunPath, [this.entryPath]];
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: {
        ...this.env,
        PORT: String(this.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.pipeLogs(child.stdout, 'stdout');
    this.pipeLogs(child.stderr, 'stderr');

    child.once('error', (error) => {
      this.log(`[daemon error] ${error.message}`);
    });

    child.once('exit', (code, signal) => {
      const expected = this.expectedExits.delete(child);
      if (this.child === child) {
        this.child = null;
      }

      this.log(`[daemon exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`);

      if (this.stopping || expected) {
        return;
      }

      this.restartAfterUnexpectedExit();
    });
    return child;
  }

  pipeLogs(stream, label) {
    if (!stream) {
      return;
    }

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.length > 0) {
          this.log(`[daemon ${label}] ${line}`);
        }
      }
    });
  }

  restartAfterUnexpectedExit() {
    if (this.stopping || this.restartTimer || this.restartInFlight) {
      return;
    }
    if (this.restartAttempts >= this.maxRestarts) {
      this.log(`[daemon] restart cap reached (${this.maxRestarts}); not restarting`);
      return;
    }

    this.restartAttempts += 1;
    const attempt = this.restartAttempts;
    this.log(`[daemon] unexpected exit; restarting (${attempt}/${this.maxRestarts})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;

      const run = this.runRestartAttempt();
      this.restartInFlight = run;
      void run
        .catch((error) => {
          this.log(`[daemon] restart failed: ${error.message}`);
          return false;
        })
        .then((healthy) => {
          if (!healthy && !this.stopping) {
            this.log('[daemon] restarted process did not become healthy');
          }
          return healthy;
        })
        .finally(() => {
          if (this.restartInFlight === run) {
            this.restartInFlight = null;
          }
          if (!this.stopping && !this.child) {
            this.restartAfterUnexpectedExit();
          }
        });
    }, this.restartDelayMs);
  }

  async runRestartAttempt() {
    const spawned = this.spawnDaemon();
    const child = spawned ?? this.child;
    let healthy = false;
    try {
      healthy = await this.healthCheck(this.port, {
        host: this.host,
        timeoutMs: this.healthTimeoutMs,
        intervalMs: this.healthIntervalMs,
      });
    } catch (error) {
      this.log(`[daemon] restart health check failed: ${error.message}`);
    }

    if (this.stopping) return true;
    if (healthy && child && this.child === child && !hasChildExited(child)) {
      return true;
    }

    if (child && !hasChildExited(child)) {
      await this.terminateChild(child);
    } else if (child && this.child === child) {
      this.child = null;
    }
    return false;
  }

  terminateChild(child) {
    if (hasChildExited(child)) {
      if (this.child === child) this.child = null;
      return Promise.resolve();
    }

    this.expectedExits.add(child);
    return new Promise((resolve) => {
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        child.off('exit', finish);
        if (this.child === child) {
          this.child = null;
        }
        resolve();
      };
      const killTimer = setTimeout(() => {
        if (exited) return;
        try {
          if (!child.kill('SIGKILL')) finish();
        } catch {
          finish();
        }
      }, this.killGraceMs);

      child.once('exit', finish);
      try {
        if (!child.kill('SIGTERM')) finish();
      } catch {
        finish();
      }
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stopPromise) return this.stopPromise;

    const child = this.child;
    if (!child) return Promise.resolve();

    const stopPromise = this.terminateChild(child).finally(() => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    });
    this.stopPromise = stopPromise;
    return stopPromise;
  }
}

module.exports = {
  DaemonSupervisor,
  resolveBunPath,
  findFreePort,
  waitForHealth,
};
