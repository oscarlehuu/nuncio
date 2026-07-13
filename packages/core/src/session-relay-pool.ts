import type { SessionSubscription, SessionSubscriptionOptions, WebSocketFactory } from './session-relay-client';
import { SharedSessionRelayConnection } from './session-relay-shared-connection';

type PoolEntry = {
  connection: SharedSessionRelayConnection;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const connections = new Map<string, PoolEntry>();

const browserFactory: WebSocketFactory = (url) =>
  new (globalThis as { WebSocket: new (value: string) => ReturnType<WebSocketFactory> }).WebSocket(url);

export function subscribeBrowserSessionEvents(options: SessionSubscriptionOptions): SessionSubscription {
  let entry = connections.get(options.url);
  if (!entry) {
    let created!: PoolEntry;
    const connection = new SharedSessionRelayConnection(
      options.url,
      browserFactory,
      () => {
        if (created.idleTimer !== null) return;
        created.idleTimer = setTimeout(() => {
          created.idleTimer = null;
          if (!created.connection.isIdle()) return;
          if (connections.get(options.url) === created) connections.delete(options.url);
          created.connection.close();
        }, 0);
      },
    );
    created = { connection, idleTimer: null };
    entry = created;
    connections.set(options.url, entry);
  }
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  return entry.connection.subscribe(options);
}

export function resetBrowserSessionRelayPoolForTests(): void {
  for (const entry of connections.values()) {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.connection.close();
  }
  connections.clear();
}
