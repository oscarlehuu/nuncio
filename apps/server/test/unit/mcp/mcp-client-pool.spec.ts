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

describe('McpClientPool', () => {
  it('connects lazily on first acquire and reuses the client afterwards', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    expect(created).toHaveLength(0);
    const first = await pool.acquire(stdio('one'));
    const second = await pool.acquire(stdio('one'));
    expect(created).toHaveLength(1);
    expect(first).toBe(second);
    await pool.disposeAll();
  });

  it('keys clients on the full transport — different env means a different client', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await pool.acquire(stdio('one', { MODE: 'a' }));
    await pool.acquire(stdio('one', { MODE: 'b' }));
    expect(created).toHaveLength(2);
    await pool.disposeAll();
  });

  it('shares one in-flight connect across concurrent acquires', async () => {
    let connects = 0;
    const factory: McpClientFactory = {
      async connect() {
        connects += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new FakeClient();
      },
    };
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    const [a, b] = await Promise.all([pool.acquire(stdio('one')), pool.acquire(stdio('one'))]);
    expect(connects).toBe(1);
    expect(a).toBe(b);
    await pool.disposeAll();
  });

  it('retries after a failed connect instead of caching the rejection', async () => {
    const { factory, created, failNext } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    failNext();
    await expect(pool.acquire(stdio('one'))).rejects.toThrow('connect refused');
    const client = await pool.acquire(stdio('one'));
    expect(client).toBeInstanceOf(FakeClient);
    expect(created).toHaveLength(1);
    await pool.disposeAll();
  });

  it('invalidate closes and removes the client so the next acquire reconnects', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await pool.acquire(stdio('one'));
    await pool.invalidate(stdio('one'));
    expect(created[0].closed).toBe(true);
    await pool.acquire(stdio('one'));
    expect(created).toHaveLength(2);
    await pool.disposeAll();
  });

  it('sweepIdle closes clients unused past the idle window and keeps fresh ones', async () => {
    const { factory, created } = fakeFactory();
    let clock = 1_000;
    const pool = new McpClientPool(factory, { idleMs: 1_000, now: () => clock });
    await pool.acquire(stdio('stale'));
    clock = 1_500;
    await pool.acquire(stdio('fresh'));
    clock = 1_900;
    await pool.sweepIdle();
    expect(created.map((client) => client.closed)).toEqual([false, false]);
    clock = 2_100;
    await pool.sweepIdle();
    expect(created.map((client) => client.closed)).toEqual([true, false]);
    await pool.disposeAll();
  });

  it('disposeAll closes every client', async () => {
    const { factory, created } = fakeFactory();
    const pool = new McpClientPool(factory, { idleMs: 60_000 });
    await pool.acquire(stdio('one'));
    await pool.acquire(stdio('two'));
    await pool.disposeAll();
    expect(created.every((client) => client.closed)).toBe(true);
  });
});
