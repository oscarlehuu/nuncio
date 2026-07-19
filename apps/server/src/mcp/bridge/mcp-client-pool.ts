import type { McpTransport } from '../domain/mcp.types';
import type { McpBridgeClient, McpClientFactory } from './mcp-client.types';

interface PoolEntry {
  clientPromise: Promise<McpBridgeClient>;
  lastUsedAt: number;
  inFlight: number;
  retired: boolean;
}

export interface McpClientPoolOptions {
  /** Close clients not used for this long (sweep-driven). */
  idleMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Shared MCP client pool: one live client per fully-resolved transport (env,
 * cwd and headers INCLUDED — unlike the import-dedupe identity, a different
 * env is a different server process), shared across sessions and engines.
 *
 * All use goes through `call()`, which tracks in-flight work per entry so the
 * idle sweep never closes a client mid-call, and a failing call retires only
 * the exact entry it used (closing it once the last concurrent call drains)
 * so the next call reconnects from scratch. Connect is lazy — nothing spawns
 * until a session actually touches a server — and failed connects are never
 * cached.
 */
export class McpClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly now: () => number;

  constructor(
    private readonly factory: McpClientFactory,
    private readonly options: McpClientPoolOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async call<T>(
    transport: McpTransport,
    fn: (client: McpBridgeClient) => Promise<T>,
  ): Promise<T> {
    const key = poolKey(transport);
    let entry = this.entries.get(key);
    if (!entry || entry.retired) {
      entry = {
        clientPromise: this.factory.connect(transport),
        lastUsedAt: this.now(),
        inFlight: 0,
        retired: false,
      };
      this.entries.set(key, entry);
    }
    entry.inFlight += 1;
    entry.lastUsedAt = this.now();
    try {
      const client = await entry.clientPromise;
      return await fn(client);
    } catch (error) {
      this.retire(key, entry);
      throw error;
    } finally {
      entry.inFlight -= 1;
      entry.lastUsedAt = this.now();
      if (entry.retired && entry.inFlight === 0) {
        void closeQuietly(entry.clientPromise);
      }
    }
  }

  /** Remove the entry from the pool; the client closes once its last in-flight call drains. */
  private retire(key: string, entry: PoolEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.options.idleMs;
    const stale = [...this.entries.entries()].filter(
      ([, entry]) => entry.inFlight === 0 && entry.lastUsedAt < cutoff,
    );
    for (const [key, entry] of stale) {
      this.retire(key, entry);
      await closeQuietly(entry.clientPromise);
    }
  }

  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const entry of all) entry.retired = true;
    await Promise.all(all.map((entry) => closeQuietly(entry.clientPromise)));
  }
}

function poolKey(transport: McpTransport): string {
  if (transport.type === 'stdio') {
    return JSON.stringify([
      'stdio',
      transport.command,
      transport.args,
      transport.env ?? {},
      transport.cwd ?? null,
    ]);
  }
  return JSON.stringify([transport.type, transport.url, transport.headers ?? {}]);
}

async function closeQuietly(clientPromise: Promise<McpBridgeClient>): Promise<void> {
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // already failed or closed — nothing to release
  }
}
