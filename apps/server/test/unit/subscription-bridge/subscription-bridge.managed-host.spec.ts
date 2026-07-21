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
    pid: 9_001,
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

describe('CliproxyManagedHost.stop', () => {
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
