import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliproxyManagedHost } from '../../../src/subscription-bridge/subscription-bridge.managed-host';
import {
  spawnWithParentControl,
  type ParentControlledChildHandle,
} from '../../../src/subscription-bridge/subscription-bridge.process-launcher';

const sourcePath = resolve(
  __dirname,
  '../../../src/subscription-bridge/subscription-bridge.managed-host.ts',
);

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`managed child pid=${pid} survived its owner`);
    }
    await Bun.sleep(10);
  }
}

async function waitForHttpText(url: string, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(url).then((response) => response.text());
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`managed child did not become reachable at ${url}`);
}

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 3_000,
): Promise<number> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === 'number') throw new Error('daemon stdout was not piped');
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const timeout = setTimeout(() => void reader.cancel('ready timeout'), timeoutMs);
  try {
    while (buffered.length <= 64 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (const line of buffered.split('\n')) {
        const marker = 'NUNCIO_MANAGED_READY ';
        const markerIndex = line.indexOf(marker);
        if (markerIndex < 0) continue;
        const payload = JSON.parse(line.slice(markerIndex + marker.length)) as { pid: number };
        return payload.pid;
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  throw new Error(`managed daemon exited before readiness: ${buffered}`);
}

function compileManagedFixture(fixtureDir: string, bin: string): void {
  const entryPath = join(fixtureDir, 'managed-child.ts');
  writeFileSync(
    entryPath,
    `import { readFileSync } from 'node:fs';\n` +
      `const configIndex = process.argv.indexOf('--config');\n` +
      `if (configIndex < 0) throw new Error('missing --config');\n` +
      `const config = process.argv[configIndex + 1];\n` +
      `const port = Number(readFileSync(config, 'utf8').match(/port:\\s*(\\d+)/)?.[1]);\n` +
      `const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('managed-ok') });\n` +
      `let stopping = false;\n` +
      `const stop = () => { if (stopping) return; stopping = true; server.stop(true); process.exit(0); };\n` +
      `process.on('SIGINT', stop);\n` +
      `process.on('SIGTERM', stop);\n`,
    'utf8',
  );
  const result = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entryPath, '--outfile', bin],
    { cwd: fixtureDir, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`fixture compile failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function fixtureBin(fixtureDir: string): string {
  return join(fixtureDir, process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api');
}

function stopProcess(proc: ReturnType<typeof Bun.spawn> | null, signal: NodeJS.Signals): void {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {
    // already gone
  }
}

describe('Cliproxy managed process ownership', () => {
  let tmp = '';
  let daemon: ReturnType<typeof Bun.spawn> | null = null;
  let directHost: CliproxyManagedHost | null = null;
  const controlledHandles: ParentControlledChildHandle[] = [];
  const childPids = new Set<number>();

  afterEach(async () => {
    await directHost?.stop().catch(() => undefined);
    const handles = controlledHandles.splice(0);
    for (const handle of handles) handle.closeParentControl();
    stopProcess(daemon, 'SIGKILL');
    await Promise.all([
      ...handles.map((handle) => handle.exited.catch(() => undefined)),
      daemon?.exited.catch(() => undefined),
    ]);
    for (const pid of childPids) {
      if (!processIsAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    childPids.clear();
    daemon = null;
    directHost = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('reaps the real child after portable parent-control EOF and releases its port', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nuncio-cliproxy-control-'));
    const fixtureDir = join(tmp, 'réstart-工具');
    mkdirSync(fixtureDir, { recursive: true });
    const bin = fixtureBin(fixtureDir);
    const configPath = join(fixtureDir, 'config.yaml');
    compileManagedFixture(fixtureDir, bin);

    const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    reservation.stop(true);
    writeFileSync(configPath, `port: ${port}\n`, 'utf8');

    const first = await spawnWithParentControl({ bin, configPath, cwd: fixtureDir });
    controlledHandles.push(first);
    childPids.add(first.pid);
    expect(await waitForHttpText(`http://127.0.0.1:${port}`)).toBe('managed-ok');

    first.closeParentControl();
    first.closeParentControl();
    await first.exited;
    await waitForProcessExit(first.pid);

    const replacement = await spawnWithParentControl({ bin, configPath, cwd: fixtureDir });
    controlledHandles.push(replacement);
    childPids.add(replacement.pid);
    expect(replacement.pid).not.toBe(first.pid);
    expect(await waitForHttpText(`http://127.0.0.1:${port}`)).toBe('managed-ok');

    replacement.kill('SIGTERM');
    await replacement.exited;
    await waitForProcessExit(replacement.pid);
  });

  it('rejects a portable launcher child-spawn failure, then retries and stops cleanly', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nuncio-cliproxy-retry-'));
    const bin = fixtureBin(tmp);
    const configPath = join(tmp, 'config.yaml');
    mkdirSync(bin);

    const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    reservation.stop(true);
    writeFileSync(configPath, `port: ${port}\n`, 'utf8');
    directHost = new CliproxyManagedHost();

    await expect(directHost.start(bin, configPath)).rejects.toThrow(
      'Failed to start managed CLIProxyAPI',
    );
    expect(directHost.isRunning()).toBe(false);

    rmSync(bin, { recursive: true, force: true });
    compileManagedFixture(tmp, bin);
    await directHost.start(bin, configPath);
    const childPid = directHost.pid();
    expect(childPid).not.toBeNull();
    if (childPid !== null) childPids.add(childPid);
    expect(await waitForHttpText(`http://127.0.0.1:${port}`)).toBe('managed-ok');

    await directHost.stop();
    expect(directHost.isRunning()).toBe(false);
    if (childPid !== null) await waitForProcessExit(childPid);
  });

  if (process.platform !== 'win32') {
    it('also reaps the managed child after an abrupt POSIX daemon SIGKILL', async () => {
      tmp = mkdtempSync(join(tmpdir(), 'nuncio-cliproxy-sigkill-'));
      const fixtureDir = join(tmp, 'réstart-工具');
      mkdirSync(fixtureDir, { recursive: true });
      const bin = fixtureBin(fixtureDir);
      const configPath = join(fixtureDir, 'config.yaml');
      const daemonPath = join(fixtureDir, 'daemon.ts');
      compileManagedFixture(fixtureDir, bin);
      const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
      const port = reservation.port;
      reservation.stop(true);
      writeFileSync(configPath, `port: ${port}\n`, 'utf8');
      writeFileSync(
        daemonPath,
        `import { CliproxyManagedHost } from ${JSON.stringify(sourcePath)};\n` +
          `const host = new CliproxyManagedHost();\n` +
          `await host.start(process.argv[2], process.argv[3]);\n` +
          `console.log('NUNCIO_MANAGED_READY ' + JSON.stringify({ pid: host.pid() }));\n` +
          `setInterval(() => {}, 60_000);\n`,
        'utf8',
      );

      daemon = Bun.spawn([process.execPath, daemonPath, bin, configPath], {
        cwd: fixtureDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const childPid = await waitForReady(daemon);
      childPids.add(childPid);
      expect(await waitForHttpText(`http://127.0.0.1:${port}`)).toBe('managed-ok');

      stopProcess(daemon, 'SIGKILL');
      await daemon.exited;
      await waitForProcessExit(childPid);
    });
  }
});
