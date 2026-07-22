import type { McpBridgeClient } from './mcp-client.types';

interface CallOwner {
  cancellation: Promise<never>;
  reject: (error: Error) => void;
}

/** Owns one connected client plus every call currently leasing it. */
export class McpClientPoolEntry {
  readonly clientPromise: Promise<McpBridgeClient>;
  lastUsedAt: number;
  retired = false;
  private client?: McpBridgeClient;
  private inFlight = 0;
  private forceClosing = false;
  private closeRequested = false;
  private closeInvoked = false;
  private readonly owners = new Set<CallOwner>();
  private readonly drainWaiters: Array<() => void> = [];
  private closeCompletion?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(connect: () => Promise<McpBridgeClient>, private readonly now: () => number) {
    this.lastUsedAt = now();
    this.clientPromise = Promise.resolve()
      .then(connect)
      .then((client) => {
        this.client = client;
        if (this.closeRequested) this.invokeClose(client);
        return client;
      });
  }

  async use<T>(fn: (client: McpBridgeClient) => Promise<T>): Promise<T> {
    const owner = createCallOwner();
    this.owners.add(owner);
    this.inFlight += 1;
    this.lastUsedAt = this.now();
    const operation = this.clientPromise.then((client) => fn(client));
    try {
      return await Promise.race([operation, owner.cancellation]);
    } finally {
      this.owners.delete(owner);
      this.inFlight -= 1;
      this.lastUsedAt = this.now();
      this.notifyDrained();
      if (this.retired) void this.closeWhenIdle();
    }
  }

  isIdleBefore(cutoff: number): boolean {
    return this.inFlight === 0 && this.lastUsedAt < cutoff;
  }

  closeWhenIdle(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.inFlight > 0 && !this.forceClosing) {
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      }
      this.requestClose();
      try {
        await this.clientPromise;
        await this.closeCompletion;
      } catch {
        // A failed connect has no client to release; close errors are observed below.
      }
    })();
    return this.closePromise;
  }

  forceClose(error: Error): void {
    this.forceClosing = true;
    for (const owner of [...this.owners]) owner.reject(error);
    this.notifyDrained();
    this.requestClose();
    void this.closeWhenIdle();
  }

  private notifyDrained(): void {
    if (this.inFlight > 0 && !this.forceClosing) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private requestClose(): void {
    this.closeRequested = true;
    if (this.client) this.invokeClose(this.client);
  }

  private invokeClose(client: McpBridgeClient): void {
    if (this.closeInvoked) return;
    this.closeInvoked = true;
    try {
      this.closeCompletion = Promise.resolve(client.close()).catch(() => undefined);
    } catch {
      this.closeCompletion = Promise.resolve();
    }
  }
}

function createCallOwner(): CallOwner {
  let reject!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { cancellation, reject };
}
