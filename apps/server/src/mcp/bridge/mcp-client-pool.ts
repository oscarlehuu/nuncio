import type { McpTransport } from '../domain/mcp.types';
import { McpClientPoolEntry } from './mcp-client-pool-entry';
import { mcpClientPoolKey, mcpTransportFingerprint } from './mcp-client-pool-key';
import type { McpBridgeClient, McpClientConnectOptions, McpClientFactory } from './mcp-client.types';

export interface McpClientPoolClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface McpClientPoolOptions {
  /** Close clients not used for this long (sweep-driven). */
  idleMs: number;
  /** Injectable clock for deterministic idle tests. */
  now?: () => number;
  /** Maximum graceful shutdown drain before active owners are rejected. */
  disposeDrainMs?: number;
  /** Injectable relative timer for deterministic shutdown tests. */
  clock?: McpClientPoolClock;
}

const DEFAULT_DISPOSE_DRAIN_MS = 5_000;
const SYSTEM_CLOCK: McpClientPoolClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Shared MCP client pool keyed by fingerprinted transport and credential
 * principal. Normal invalidation waits for active owners; global disposal
 * rejects new work, drains for a bounded interval, then force-closes and
 * rejects owners so process shutdown cannot be pinned by a hung MCP call.
 */
export class McpClientPool {
  private readonly entries = new Map<string, McpClientPoolEntry>();
  private readonly allEntries = new Set<McpClientPoolEntry>();
  private readonly now: () => number;
  private readonly clock: McpClientPoolClock;
  private readonly disposeDrainMs: number;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';
  private disposePromise?: Promise<void>;

  constructor(
    private readonly factory: McpClientFactory,
    private readonly options: McpClientPoolOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    const requestedDrain = options.disposeDrainMs ?? DEFAULT_DISPOSE_DRAIN_MS;
    this.disposeDrainMs = Number.isFinite(requestedDrain)
      ? Math.max(0, requestedDrain)
      : DEFAULT_DISPOSE_DRAIN_MS;
  }

  async call<T>(
    transport: McpTransport,
    fn: (client: McpBridgeClient) => Promise<T>,
    options?: McpClientConnectOptions,
  ): Promise<T> {
    if (this.lifecycle !== 'active') {
      throw new Error('MCP client pool is disposing or disposed');
    }

    const key = mcpClientPoolKey(transport, options);
    let entry = this.entries.get(key);
    if (!entry || entry.retired) {
      entry = new McpClientPoolEntry(
        () => this.factory.connect(transport, options),
        this.now,
      );
      this.entries.set(key, entry);
      this.allEntries.add(entry);
    }

    try {
      return await entry.use(fn);
    } catch (error) {
      this.retire(key, entry);
      void this.closeEntry(entry);
      throw error;
    }
  }

  /** Drop cached clients for a transport (e.g. after OAuth token refresh). */
  invalidate(transport: McpTransport): void {
    const prefix = `${mcpTransportFingerprint(transport)}:`;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (!key.startsWith(prefix)) continue;
      this.retire(key, entry);
      void this.closeEntry(entry);
    }
  }

  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.options.idleMs;
    const stale = [...this.entries.entries()].filter(([, entry]) =>
      entry.isIdleBefore(cutoff),
    );
    for (const [key, entry] of stale) {
      this.retire(key, entry);
      await this.closeEntry(entry);
    }
  }

  disposeAll(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.lifecycle = 'disposing';
    const all = [...this.allEntries];
    this.entries.clear();
    for (const entry of all) entry.retired = true;
    this.disposePromise = this.finishDisposal(all);
    return this.disposePromise;
  }

  private async finishDisposal(all: McpClientPoolEntry[]): Promise<void> {
    if (all.length === 0) {
      this.lifecycle = 'disposed';
      return;
    }

    const closing = Promise.all(all.map((entry) => this.closeEntry(entry)));
    let timer: unknown;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = this.clock.setTimeout(() => resolve('deadline'), this.disposeDrainMs);
    });
    const outcome = await Promise.race([closing.then(() => 'closed' as const), deadline]);

    if (outcome === 'closed') {
      this.clock.clearTimeout(timer);
    } else {
      const error = new Error(
        `MCP client pool disposal drain exceeded ${this.disposeDrainMs}ms`,
      );
      for (const entry of all) {
        entry.forceClose(error);
        void this.closeEntry(entry);
      }
    }

    this.lifecycle = 'disposed';
    this.allEntries.clear();
  }

  private retire(key: string, entry: McpClientPoolEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private closeEntry(entry: McpClientPoolEntry): Promise<void> {
    const closing = entry.closeWhenIdle();
    void closing.then(() => this.allEntries.delete(entry));
    return closing;
  }
}
