import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CliproxyManagedHost,
  type CliproxyChildHandle,
} from '../../../src/subscription-bridge/subscription-bridge.managed-host';

/**
 * Mimics Bun/Node: `killed` flips true as soon as a signal is sent, not on exit.
 * A hung child keeps `exited` unresolved until the test resolves it.
 */
function createSignalAwareChild(opts?: {
  pid?: number;
  onKill?: (signal: NodeJS.Signals | number | undefined) => void;
  exitOnSignal?: NodeJS.Signals | number;
}): {
  handle: CliproxyChildHandle;
  resolveExit: (code: number | null) => void;
  signals: Array<NodeJS.Signals | number | undefined>;
} {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let settled = false;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = (code) => {
      settled = true;
      resolve(code);
    };
  });
  let signalSent = false;
  const handle: CliproxyChildHandle = {
    pid: opts?.pid ?? 9_001,
    get killed() {
      return signalSent || settled;
    },
    get hasExited() {
      return settled;
    },
    kill(signal?: NodeJS.Signals | number) {
      signalSent = true;
      signals.push(signal);
      opts?.onKill?.(signal);
      if (opts?.exitOnSignal !== undefined && signal === opts.exitOnSignal) {
        resolveExit(signal === 'SIGKILL' ? 137 : 0);
      }
    },
    exited,
  };
  return { handle, resolveExit, signals };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CliproxyManagedHost lifecycle', () => {
  let host: CliproxyManagedHost;
  let tmp: string;
  let bin: string;
  let configPath: string;

  beforeEach(() => {
    host = new CliproxyManagedHost();
    host.stopGraceMs = 30;
    tmp = mkdtempSync(join(tmpdir(), 'nuncio-managed-host-'));
    bin = join(tmp, 'cli-proxy-api');
    configPath = join(tmp, 'config.yaml');
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(configPath, 'port: 18317\n', 'utf8');
  });

  afterEach(async () => {
    await host.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('single-flights concurrent starts so only one child is spawned', async () => {
    const pending = deferred<CliproxyChildHandle>();
    const child = createSignalAwareChild({ exitOnSignal: 'SIGTERM' });
    let spawns = 0;
    host.spawnImpl = async () => {
      spawns += 1;
      return pending.promise;
    };

    const first = host.start(bin, configPath);
    const second = host.start(bin, configPath);
    await Promise.resolve();
    expect(spawns).toBe(1);
    pending.resolve(child.handle);
    await Promise.all([first, second]);
    expect(host.pid()).toBe(child.handle.pid);
  });

  it('shares a start failure across concurrent callers and permits a later retry', async () => {
    const failedSpawn = deferred<CliproxyChildHandle>();
    const retryChild = createSignalAwareChild({ exitOnSignal: 'SIGTERM' });
    let spawns = 0;
    host.spawnImpl = async () => {
      spawns += 1;
      if (spawns === 1) return failedSpawn.promise;
      return retryChild.handle;
    };

    const first = host.start(bin, configPath);
    const second = host.start(bin, configPath);
    await Promise.resolve();
    expect(spawns).toBe(1);
    failedSpawn.reject(new Error('spawn failed'));
    await expect(first).rejects.toThrow('spawn failed');
    await expect(second).rejects.toThrow('spawn failed');
    expect(host.isRunning()).toBe(false);

    await host.start(bin, configPath);
    expect(spawns).toBe(2);
    expect(host.pid()).toBe(retryChild.handle.pid);
  });

  it('serializes stop behind a pending start so the late child cannot be orphaned', async () => {
    const pending = deferred<CliproxyChildHandle>();
    const child = createSignalAwareChild({ exitOnSignal: 'SIGTERM' });
    host.spawnImpl = async () => pending.promise;

    const starting = host.start(bin, configPath);
    const stopping = host.stop();
    pending.resolve(child.handle);
    await starting;
    await stopping;

    expect(child.signals).toEqual(['SIGTERM']);
    expect(host.isRunning()).toBe(false);
  });

  it('runs a new start requested after stop behind both earlier transitions', async () => {
    const firstSpawn = deferred<CliproxyChildHandle>();
    const firstChild = createSignalAwareChild({ pid: 9_001, exitOnSignal: 'SIGTERM' });
    const secondChild = createSignalAwareChild({ pid: 9_002, exitOnSignal: 'SIGTERM' });
    let spawns = 0;
    host.spawnImpl = async () => {
      spawns += 1;
      return spawns === 1 ? firstSpawn.promise : secondChild.handle;
    };

    const starting = host.start(bin, configPath);
    const stopping = host.stop();
    const restarting = host.start(bin, configPath);
    firstSpawn.resolve(firstChild.handle);
    await Promise.all([starting, stopping, restarting]);

    expect(spawns).toBe(2);
    expect(firstChild.signals).toEqual(['SIGTERM']);
    expect(host.pid()).toBe(secondChild.handle.pid);
  });

  it('clears ownership when the child exit promise rejects', async () => {
    const exit = deferred<number | null>();
    const handle: CliproxyChildHandle = {
      pid: 9_003,
      killed: false,
      hasExited: false,
      kill() {},
      exited: exit.promise,
    };
    host.spawnImpl = async () => handle;
    await host.start(bin, configPath);

    exit.reject(new Error('exit observation failed'));
    await exit.promise.catch(() => undefined);
    await Promise.resolve();

    expect(host.isRunning()).toBe(false);
  });

  it('sends SIGKILL when SIGTERM marks killed but the process has not exited', async () => {
    const { handle, signals } = createSignalAwareChild({ exitOnSignal: 'SIGKILL' });
    host.spawnImpl = async () => handle;

    await host.start(bin, configPath);
    expect(host.isRunning()).toBe(true);

    await host.stop();

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not send SIGKILL when the child exits during the grace period', async () => {
    const { handle, signals } = createSignalAwareChild({ exitOnSignal: 'SIGTERM' });
    host.spawnImpl = async () => handle;

    await host.start(bin, configPath);
    await host.stop();

    expect(signals).toEqual(['SIGTERM']);
  });

  it('isRunning is false only after the process has exited, not merely after SIGTERM', async () => {
    const { handle, resolveExit } = createSignalAwareChild();
    host.spawnImpl = async () => handle;
    await host.start(bin, configPath);

    // Simulate an in-flight SIGTERM without waiting for exit (e.g. external kill).
    handle.kill('SIGTERM');
    expect(handle.killed).toBe(true);
    expect(handle.hasExited).toBe(false);
    // Host still owns the child until stop/exit clears it — isRunning must not use killed.
    expect(host.isRunning()).toBe(true);

    resolveExit(0);
    await handle.exited;
    // Exit handler clears the child asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    expect(host.isRunning()).toBe(false);
  });
});
