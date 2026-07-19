import { McpClientPool } from '../../../src/mcp/bridge/mcp-client-pool';
import type {
  McpBridgeClient,
  McpClientFactory,
} from '../../../src/mcp/bridge/mcp-client.types';
import type { McpTransport } from '../../../src/mcp/domain/mcp.types';

class FakeClient implements McpBridgeClient {
  closed = false;
  async listTools() {
    return [];
  }
  async callTool() {
    return { content: [] };
  }
  async close() {
    this.closed = true;
  }
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

  it('disposeAll closes every client', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await touch(pool, stdio('one'));
    await touch(pool, stdio('two'));
    await pool.disposeAll();
    expect(created.every((client) => client.closed)).toBe(true);
  });
});
