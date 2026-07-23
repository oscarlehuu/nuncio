import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  SubscriptionHostManagedHost,
  type SubscriptionHostChildHandle,
  type SubscriptionHostSpawnOptions,
} from '../../../src/subscription-host/subscription-host.managed-host';

/**
 * Mirrors the CliproxyManagedHost spec shape: `killed` flips true when a signal
 * is sent (not on exit), and a hung child leaves `exited` unresolved until the
 * test resolves it. The sub-host supervises TWO children (broker + router).
 */
function createChild(opts?: { exitOnSignal?: NodeJS.Signals | number }): {
  handle: SubscriptionHostChildHandle;
  resolveExit: (code: number | null) => void;
  signals: Array<NodeJS.Signals | number | undefined>;
} {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let settled = false;
  let signalSent = false;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = (code) => {
      settled = true;
      resolve(code);
    };
  });
  const handle: SubscriptionHostChildHandle = {
    pid: 4_100 + signals.length,
    get killed() {
      return signalSent || settled;
    },
    get hasExited() {
      return settled;
    },
    kill(signal?: NodeJS.Signals | number) {
      signalSent = true;
      signals.push(signal);
      // A real process cannot ignore SIGKILL — always terminate on it so a
      // supervisor's stop() never hangs; SIGTERM only exits when asked.
      if (signal === 'SIGKILL' || (opts?.exitOnSignal !== undefined && signal === opts.exitOnSignal)) {
        resolveExit(signal === 'SIGKILL' ? 137 : 0);
      }
    },
    exited,
  };
  return { handle, resolveExit, signals };
}

function startSpec() {
  return {
    bin: '/data/subhost/node_modules/.bin/omp',
    cwd: '/data/subhost',
    env: { PI_HOME: '/data/subhost/home' },
    processes: [
      { name: 'broker' as const, args: ['auth-broker', 'serve', '--bind', '127.0.0.1:18700'] },
      { name: 'router' as const, args: ['auth-gateway', 'serve', '--bind', '127.0.0.1:18701'] },
    ],
  };
}

describe('SubscriptionHostManagedHost', () => {
  let host: SubscriptionHostManagedHost;

  beforeEach(() => {
    host = new SubscriptionHostManagedHost();
    host.stopGraceMs = 20;
    host.restartDelayMs = 5;
  });

  afterEach(async () => {
    host.restartDelayMs = 60_000; // disarm auto-restart before teardown
    await host.stop();
  });

  it('spawns both the broker and router subcommands on start', async () => {
    const calls: SubscriptionHostSpawnOptions[] = [];
    host.spawnImpl = async (opts) => {
      calls.push(opts);
      return createChild().handle;
    };

    await host.start(startSpec());

    expect(host.isRunning()).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(['auth-broker', 'auth-gateway']);
    expect(calls.every((c) => c.bin === startSpec().bin && c.cwd === startSpec().cwd)).toBe(true);
    expect(host.pid('broker')).not.toBeNull();
    expect(host.pid('router')).not.toBeNull();
  });

  it('is not running until BOTH children are alive', async () => {
    const broker = createChild();
    const router = createChild();
    const queue = [broker.handle, router.handle];
    host.spawnImpl = async () => queue.shift()!;
    await host.start(startSpec());
    expect(host.isRunning()).toBe(true);

    router.resolveExit(0);
    await router.handle.exited;
    await new Promise((r) => setTimeout(r, 0));
    expect(host.isRunning()).toBe(false);
  });

  it('SIGKILLs children that ignore SIGTERM, and only SIGTERMs those that exit in grace', async () => {
    const stubborn = createChild({ exitOnSignal: 'SIGKILL' });
    const graceful = createChild({ exitOnSignal: 'SIGTERM' });
    const queue = [stubborn.handle, graceful.handle];
    host.spawnImpl = async () => queue.shift()!;
    host.restartDelayMs = 60_000;

    await host.start(startSpec());
    await host.stop();

    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(graceful.signals).toEqual(['SIGTERM']);
    expect(host.isRunning()).toBe(false);
  });

  it('restarts both children when one exits unexpectedly', async () => {
    let spawned = 0;
    const children: ReturnType<typeof createChild>[] = [];
    host.spawnImpl = async () => {
      spawned += 1;
      const child = createChild();
      children.push(child);
      return child.handle;
    };

    await host.start(startSpec());
    expect(spawned).toBe(2);

    // Broker crashes → supervisor tears down and respawns both.
    children[0].resolveExit(1);
    await new Promise((r) => setTimeout(r, 40));

    expect(spawned).toBe(4);
    expect(host.isRunning()).toBe(true);
  });

  it('does not restart after an intentional stop', async () => {
    let spawned = 0;
    host.spawnImpl = async () => {
      spawned += 1;
      return createChild({ exitOnSignal: 'SIGTERM' }).handle;
    };
    await host.start(startSpec());
    expect(spawned).toBe(2);

    await host.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(spawned).toBe(2);
    expect(host.isRunning()).toBe(false);
  });
});
