import type { SessionEvent } from './api';

/**
 * Client for the session WS relay (see docs/ws-relay-contract.md). Envelope:
 * requests `{id, method, params}` answered by `{id, result|error}`; the server
 * pushes `{channel: sessionId, event}` and `{channel: sessionId, behind: true}`
 * when the subscription was dropped to cursor recovery. The client owns the
 * gap-free property: it tracks the highest seq it has seen and every
 * (re)subscribe asks for `since = lastSeq`.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SessionSubscriptionOptions {
  /** ws(s):// URL of the relay endpoint (base path already applied). */
  url: string;
  sessionId: string;
  since?: number;
  onEvent: (event: SessionEvent) => void;
  /** Injected for React Native (auth headers) and tests; defaults to the global WebSocket. */
  webSocketFactory?: WebSocketFactory;
  /**
   * Fixed delay between reconnect attempts. Used only when `reconnectDelays` is
   * absent — the two are mutually exclusive and `reconnectDelays` wins.
   */
  reconnectMs?: number;
  /**
   * Per-attempt reconnect delay in ms, overriding the fixed `reconnectMs`. The
   * mobile connection manager supplies exponential backoff + jitter here. When
   * omitted, the client keeps its historical fixed-delay behavior exactly.
   * `attempt` starts at 1 for the first reconnect and increments each time a
   * connect fails; it resets to 0 once a socket opens.
   */
  reconnectDelays?: (attempt: number) => number;
  /**
   * Called with the string from any top-level `{ notice }` frame the server
   * pushes (e.g. `server_shutdown`), which is additive to the event envelope.
   * When omitted, such frames are silently ignored — this is why web callers,
   * which pass neither this nor `reconnectDelays`, see identical behavior.
   */
  onNotice?: (notice: string) => void;
}

export interface SessionSubscription {
  /** Reconnect/resubscribe from the last seen seq (tab became visible, app foregrounded). */
  resync(): void;
  /** RPC over the same socket, e.g. steer. Rejects with the server's {code, message}. */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

const DEFAULT_RECONNECT_MS = 2000;

export function subscribeSessionEvents(options: SessionSubscriptionOptions): SessionSubscription {
  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
  const factory: WebSocketFactory =
    options.webSocketFactory ??
    ((url) => new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));

  let lastSeq = options.since ?? 0;
  let closed = false;
  let socket: WebSocketLike | null = null;
  let socketOpen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Counts consecutive reconnect attempts for the backoff hook; reset to 0 the
  // moment a socket opens so a recovered connection starts the next storm fresh.
  let reconnectAttempt = 0;
  let nextRpcId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const sendSubscribe = () => {
    socket?.send(
      JSON.stringify({
        id: nextRpcId++,
        method: 'subscribe',
        params: { sessionId: options.sessionId, since: lastSeq },
      }),
    );
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    reconnectAttempt += 1;
    const delay = options.reconnectDelays ? options.reconnectDelays(reconnectAttempt) : reconnectMs;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    socketOpen = false;
    const ws = factory(options.url);
    socket = ws;

    ws.addEventListener('open', () => {
      if (closed || socket !== ws) return;
      socketOpen = true;
      reconnectAttempt = 0;
      sendSubscribe();
    });

    ws.addEventListener('message', (msg) => {
      if (closed || socket !== ws) return;
      let parsed: {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
        channel?: string;
        event?: SessionEvent;
        behind?: boolean;
        notice?: string;
      };
      try {
        parsed = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (parsed.channel !== undefined) {
        if (parsed.behind) {
          // Dropped to cursor recovery — pick the stream back up from lastSeq.
          sendSubscribe();
          return;
        }
        if (parsed.event) {
          lastSeq = Math.max(lastSeq, parsed.event.seq);
          options.onEvent(parsed.event);
        }
        return;
      }
      // Additive top-level notice frame (e.g. server_shutdown). Unknown to web
      // callers, which pass no onNotice and so ignore it — that is what keeps
      // their behavior identical.
      if (typeof parsed.notice === 'string') {
        options.onNotice?.(parsed.notice);
        return;
      }
      if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
        const rpc = pending.get(parsed.id)!;
        pending.delete(parsed.id);
        if (parsed.error) rpc.reject(parsed.error);
        else rpc.resolve(parsed.result);
      }
    });

    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socketOpen = false;
      for (const rpc of pending.values()) rpc.reject(new Error('connection closed'));
      pending.clear();
      scheduleReconnect();
    });
  };

  connect();

  return {
    resync() {
      if (closed) return;
      if (socketOpen) {
        sendSubscribe();
        return;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        socket?.close();
      } catch {
        // already dead — reconnect below regardless
      }
      connect();
    },
    call(method, params) {
      return new Promise((resolve, reject) => {
        if (closed || !socketOpen || !socket) {
          reject(new Error('connection closed'));
          return;
        }
        const id = nextRpcId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
