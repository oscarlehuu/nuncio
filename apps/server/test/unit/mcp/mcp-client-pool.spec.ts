import { McpClientPool } from '../../../src/mcp/bridge/mcp-client-pool';
import type {
  McpBridgeClient,
  McpClientFactory,
} from '../../../src/mcp/bridge/mcp-client.types';
import type { McpTransport } from '../../../src/mcp/domain/mcp.types';

class FakeClient implements McpBridgeClient {
  closed = false;
  closeCount = 0;
  async listTools(): Promise<Array<{ name: string; inputSchema: Record<string, unknown> }>> {
    return [];
  }
  async callTool() {
    return { content: [] };
  }
  async close() {
    this.closed = true;
    this.closeCount += 1;
  }
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

function fakeFactory() {
  const created: FakeClient[] = [];
  let failNext = false;
  const factory: McpClientFactory = {
    async connect() {
      if (failNext) {
        failNext = false;
        throw new Error('connect refused');
      }
      const client = new FakeClient();
      created.push(client);
      return client;
    },
  };
  return { factory, created, failNext: () => (failNext = true) };
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly api = {
    setTimeout: (callback: () => void, delayMs: number): unknown => {
      const id = this.nextId;
      this.nextId += 1;
      this.timers.set(id, { at: this.now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle === 'number') this.timers.delete(handle);
    },
  };

  advanceBy(ms: number): void {
    this.now += ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const next = due[0];
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

const stdio = (command: string, env?: Record<string, string>): McpTransport => ({
  type: 'stdio',
  command,
  args: [],
  ...(env ? { env } : {}),
});

const touch = (pool: McpClientPool, transport: McpTransport) =>
  pool.call(transport, async (client) => client);

describe('McpClientPool', () => {
  it('connects lazily on first call and reuses the client afterwards', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    expect(created).toHaveLength(0);
    const first = await touch(pool, stdio('one'));
    const second = await touch(pool, stdio('one'));
    expect(created).toHaveLength(1);
    expect(first).toBe(second);
    await pool.disposeAll();
  });

  it('keys clients on the full transport — different env means a different client', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await touch(pool, stdio('one', { MODE: 'a' }));
    await touch(pool, stdio('one', { MODE: 'b' }));
    expect(created).toHaveLength(2);
    await pool.disposeAll();
  });

  it('canonicalizes credential object order, including Unicode keys', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await touch(pool, stdio('one', { Z_MODE: '值', 'Å_TOKEN': '秘密' }));
    await touch(pool, stdio('one', { 'Å_TOKEN': '秘密', Z_MODE: '值' }));
    expect(created).toHaveLength(1);
    await pool.disposeAll();
  });

  it('isolates OAuth principals sharing the same transport and reuses each account client', async () => {
    const connects: string[] = [];
    const factory: McpClientFactory = {
      async connect(_transport, options) {
        const principalId = (options as { principalId?: string } | undefined)?.principalId ?? 'none';
        connects.push(principalId);
        const client = new FakeClient();
        client.listTools = async () => [{ name: principalId, inputSchema: {} }];
        return client;
      },
    };
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const transport = { type: 'http', url: 'https://accounts.example/mcp' } as const;
    const accountA = {
      authProvider: {} as never,
      principalId: 'oauth-account-a',
    } as never;
    const accountB = {
      authProvider: {} as never,
      principalId: 'oauth-account-b',
    } as never;

    const [a, b] = await Promise.all([
      pool.call(transport, (client) => client.listTools(), accountA),
      pool.call(transport, (client) => client.listTools(), accountB),
    ]);
    const aAgain = await pool.call(transport, (client) => client.listTools(), accountA);

    expect(a[0]?.name).toBe('oauth-account-a');
    expect(b[0]?.name).toBe('oauth-account-b');
    expect(aAgain[0]?.name).toBe('oauth-account-a');
    expect(connects).toEqual(['oauth-account-a', 'oauth-account-b']);
    await pool.disposeAll();
  });

  it('isolates credential principals without retaining raw secrets in pool keys', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await touch(pool, {
      type: 'http',
      url: 'https://accounts.example/mcp?tenant=one-secret',
      headers: { Authorization: 'Bearer account-one-secret' },
    });
    await touch(pool, {
      type: 'http',
      url: 'https://accounts.example/mcp?tenant=two-secret',
      headers: { Authorization: 'Bearer account-two-secret' },
    });

    expect(created).toHaveLength(2);
    const keys = [...((pool as unknown as { entries: Map<string, unknown> }).entries.keys())];
    expect(keys.join(' ')).not.toContain('account-one-secret');
    expect(keys.join(' ')).not.toContain('two-secret');
    await pool.disposeAll();
  });

  it('shares one in-flight connect across concurrent calls', async () => {
    let connects = 0;
    const factory: McpClientFactory = {
      async connect() {
        connects += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new FakeClient();
      },
    };
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const [a, b] = await Promise.all([touch(pool, stdio('one')), touch(pool, stdio('one'))]);
    expect(connects).toBe(1);
    expect(a).toBe(b);
    await pool.disposeAll();
  });

  it('retries after a failed connect instead of caching the rejection', async () => {
    const { factory, created, failNext } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    failNext();
    await expect(touch(pool, stdio('one'))).rejects.toThrow('connect refused');
    const client = await touch(pool, stdio('one'));
    expect(client).toBeInstanceOf(FakeClient);
    expect(created).toHaveLength(1);
    await pool.disposeAll();
  });

  it('a failing call retires the client so the next call reconnects', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await expect(
      pool.call(stdio('one'), async () => {
        throw new Error('transport lost');
      }),
    ).rejects.toThrow('transport lost');
    expect(created[0].closed).toBe(true);
    await touch(pool, stdio('one'));
    expect(created).toHaveLength(2);
    await pool.disposeAll();
  });

  it('a failure does not close the client under a concurrent in-flight call', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => (releaseSlow = resolve));
    const slow = pool.call(stdio('one'), async () => {
      await slowDone;
      return 'slow-ok';
    });
    await expect(
      pool.call(stdio('one'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Slow call still holds the client — it must not be closed underneath it.
    expect(created[0].closed).toBe(false);
    releaseSlow();
    await expect(slow).resolves.toBe('slow-ok');
    // Retired entry closes once the last in-flight call drains.
    expect(created[0].closed).toBe(true);
    await pool.disposeAll();
  });

  it('sweepIdle closes idle clients but never one with an in-flight call', async () => {
    const { factory, created } = fakeFactory();
    let clock = 1_000;
    const pool = new McpClientPool(factory, { idleMs: 1_000, now: () => clock });
    await touch(pool, stdio('stale'));

    let releaseBusy!: () => void;
    const busyDone = new Promise<void>((resolve) => (releaseBusy = resolve));
    const busy = pool.call(stdio('busy'), async () => {
      await busyDone;
      return 'ok';
    });
    await Promise.resolve();

    clock = 3_000;
    await pool.sweepIdle();
    expect(created[0].closed).toBe(true); // stale, idle → swept
    expect(created[1].closed).toBe(false); // busy, in-flight → kept even past idleMs
    releaseBusy();
    await expect(busy).resolves.toBe('ok');
    await pool.disposeAll();
  });

  it('invalidation during a pending connect retires late success and closes it once', async () => {
    const pending = deferred<McpBridgeClient>();
    const created: FakeClient[] = [];
    let connects = 0;
    const factory: McpClientFactory = {
      async connect() {
        connects += 1;
        if (connects === 1) return pending.promise;
        const client = new FakeClient();
        created.push(client);
        return client;
      },
    };
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const first = pool.call(stdio('one'), async () => 'first-result');
    pool.invalidate(stdio('one'));
    const late = new FakeClient();
    created.push(late);
    pending.resolve(late);

    await expect(first).resolves.toBe('first-result');
    expect(late.closeCount).toBe(1);
    await touch(pool, stdio('one'));
    expect(connects).toBe(2);
    await pool.disposeAll();
    expect(late.closeCount).toBe(1);
  });

  it('invalidation during a pending connect failure leaves retryable ownership', async () => {
    const pending = deferred<McpBridgeClient>();
    let connects = 0;
    const factory: McpClientFactory = {
      async connect() {
        connects += 1;
        if (connects === 1) return pending.promise;
        return new FakeClient();
      },
    };
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const first = touch(pool, stdio('one'));
    pool.invalidate(stdio('one'));
    pending.reject(new Error('late connect failure'));

    await expect(first).rejects.toThrow('late connect failure');
    await expect(touch(pool, stdio('one'))).resolves.toBeInstanceOf(FakeClient);
    expect(connects).toBe(2);
    await pool.disposeAll();
  });

  it('disposeAll waits for an in-flight call before closing its client exactly once', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const release = deferred<void>();
    const started = deferred<void>();
    const call = pool.call(stdio('one'), async () => {
      started.resolve();
      await release.promise;
      return 'done';
    });
    await started.promise;

    const disposing = pool.disposeAll();
    await Promise.resolve();
    expect(created[0].closed).toBe(false);
    release.resolve();
    await expect(call).resolves.toBe('done');
    await disposing;
    expect(created[0].closeCount).toBe(1);
  });

  it('disposeAll force-closes and rejects a hung owner exactly at the drain deadline', async () => {
    const { factory, created } = fakeFactory();
    const clock = new FakeClock();
    const pool = new McpClientPool(factory, {
      idleMs: 60_000,
      disposeDrainMs: 1_000,
      clock: clock.api,
    });
    const started = deferred<void>();
    const never = deferred<void>();
    let callState: 'pending' | 'resolved' | 'rejected' = 'pending';
    const call = pool.call(stdio('hung'), async () => {
      started.resolve();
      await never.promise;
      return 'unreachable';
    });
    void call.then(
      () => (callState = 'resolved'),
      () => (callState = 'rejected'),
    );
    await started.promise;

    let disposed = false;
    const disposing = pool.disposeAll().then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(created[0].closed).toBe(false);

    clock.advanceBy(999);
    await flushMicrotasks();
    expect(disposed).toBe(false);
    expect(callState).toBe('pending');
    expect(created[0].closed).toBe(false);

    clock.advanceBy(1);
    await flushMicrotasks();
    expect(disposed).toBe(true);
    expect(callState).toBe('rejected');
    await expect(call).rejects.toThrow(/drain|dispos|shutdown/i);
    await disposing;
    expect(created[0].closeCount).toBe(1);
  });

  it('rejects new calls during disposal and repeated disposal closes once', async () => {
    const created: FakeClient[] = [];
    let connects = 0;
    const factory: McpClientFactory = {
      async connect() {
        connects += 1;
        const client = new FakeClient();
        created.push(client);
        return client;
      },
    };
    const clock = new FakeClock();
    const pool = new McpClientPool(factory, {
      idleMs: 60_000,
      disposeDrainMs: 10,
      clock: clock.api,
    });
    const started = deferred<void>();
    const never = deferred<void>();
    const owned = pool.call(stdio('one'), async () => {
      started.resolve();
      await never.promise;
      return 'unreachable';
    });
    void owned.catch(() => undefined);
    await started.promise;

    const firstDispose = pool.disposeAll();
    const secondDispose = pool.disposeAll();
    await expect(touch(pool, stdio('two'))).rejects.toThrow(/dispos|shutdown/i);
    expect(connects).toBe(1);

    clock.advanceBy(10);
    await flushMicrotasks();
    await Promise.all([firstDispose, secondDispose]);
    await expect(owned).rejects.toThrow(/drain|dispos|shutdown/i);
    expect(created[0].closeCount).toBe(1);
  });

  it('lets one real owner drain while rejecting its hung sibling at the boundary', async () => {
    const { factory, created } = fakeFactory();
    const clock = new FakeClock();
    const pool = new McpClientPool(factory, {
      idleMs: 60_000,
      disposeDrainMs: 50,
      clock: clock.api,
    });
    const releaseGraceful = deferred<void>();
    const gracefulStarted = deferred<void>();
    const hungStarted = deferred<void>();
    const never = deferred<void>();
    const graceful = pool.call(stdio('shared'), async () => {
      gracefulStarted.resolve();
      await releaseGraceful.promise;
      return 'graceful-result';
    });
    const hung = pool.call(stdio('shared'), async () => {
      hungStarted.resolve();
      await never.promise;
      return 'unreachable';
    });
    void hung.catch(() => undefined);
    await Promise.all([gracefulStarted.promise, hungStarted.promise]);

    const disposing = pool.disposeAll();
    releaseGraceful.resolve();
    await expect(graceful).resolves.toBe('graceful-result');
    expect(created[0].closed).toBe(false);

    clock.advanceBy(50);
    await flushMicrotasks();
    await disposing;
    await expect(hung).rejects.toThrow(/drain|dispos|shutdown/i);
    expect(created).toHaveLength(1);
    expect(created[0].closeCount).toBe(1);
  });

  it('does not let a pending connect pin disposal and closes a late client once', async () => {
    const pendingConnect = deferred<McpBridgeClient>();
    const factory: McpClientFactory = {
      async connect() {
        return pendingConnect.promise;
      },
    };
    const clock = new FakeClock();
    const pool = new McpClientPool(factory, {
      idleMs: 60_000,
      disposeDrainMs: 25,
      clock: clock.api,
    });
    const call = touch(pool, stdio('pending-connect'));
    void call.catch(() => undefined);
    await flushMicrotasks();

    const disposing = pool.disposeAll();
    clock.advanceBy(25);
    await flushMicrotasks();
    await disposing;
    await expect(call).rejects.toThrow(/drain|dispos|shutdown/i);

    const late = new FakeClient();
    pendingConnect.resolve(late);
    await flushMicrotasks();
    expect(late.closeCount).toBe(1);
    await pool.disposeAll();
    expect(late.closeCount).toBe(1);
  });

  it('treats non-positive disposal drains as immediate bounds', async () => {
    for (const disposeDrainMs of [0, -1]) {
      const { factory, created } = fakeFactory();
      const clock = new FakeClock();
      const pool = new McpClientPool(factory, {
        idleMs: 60_000,
        disposeDrainMs,
        clock: clock.api,
      });
      const started = deferred<void>();
      const never = deferred<void>();
      const call = pool.call(stdio(`immediate-${disposeDrainMs}`), async () => {
        started.resolve();
        await never.promise;
        return 'unreachable';
      });
      void call.catch(() => undefined);
      await started.promise;

      const disposing = pool.disposeAll();
      clock.advanceBy(0);
      await flushMicrotasks();
      await disposing;
      await expect(call).rejects.toThrow(/drain|dispos|shutdown/i);
      expect(created[0].closeCount).toBe(1);
    }
  });

  it('disposeAll closes every client', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await touch(pool, stdio('one'));
    await touch(pool, stdio('two'));
    await pool.disposeAll();
    expect(created.every((client) => client.closed)).toBe(true);
    expect(created.every((client) => client.closeCount === 1)).toBe(true);
  });
});
