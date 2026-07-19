import type { McpTransport } from '../domain/mcp.types';
import type { McpBridgeClient, McpClientFactory } from './mcp-client.types';

interface PoolEntry {
  clientPromise: Promise<McpBridgeClient>;
  lastUsedAt: number;
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
 * Connect is lazy (nothing spawns until a session actually touches a server)
 * and idle clients are swept, so an enabled-but-unused server costs nothing.
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

  async acquire(transport: McpTransport): Promise<McpBridgeClient> {
    const key = poolKey(transport);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.clientPromise;
    }
    const entry: PoolEntry = {
      lastUsedAt: this.now(),
      clientPromise: this.factory.connect(transport).catch((error) => {
        // Never cache a rejection — the next acquire retries the connect.
        this.entries.delete(key);
        throw error;
      }),
    };
    this.entries.set(key, entry);
    return entry.clientPromise;
  }

  /** Drop (and close) a client after a fatal transport error so the next call reconnects. */
  async invalidate(transport: McpTransport): Promise<void> {
    const key = poolKey(transport);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await closeQuietly(entry.clientPromise);
  }

  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.options.idleMs;
    const stale = [...this.entries.entries()].filter(([, entry]) => entry.lastUsedAt < cutoff);
    for (const [key, entry] of stale) {
      this.entries.delete(key);
      await closeQuietly(entry.clientPromise);
    }
  }

  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((entry) => closeQuietly(entry.clientPromise)));
  }
}

function poolKey(transport: McpTransport): string {
  if (transport.type === 'stdio') {
    return JSON.stringify(['stdio', transport.command, transport.args, transport.env ?? {}, transport.cwd ?? null]);
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
