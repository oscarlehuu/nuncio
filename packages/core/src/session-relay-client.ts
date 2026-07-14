import type { SessionEvent } from './api';
import { subscribeBrowserSessionEvents } from './session-relay-pool';

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
  /** Bound only the initial cursor-zero replay; reconnects continue from lastSeq. */
  tail?: number;
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
  /**
   * Called each time a socket successfully opens. Lets an owner mark the
   * connection healthy and reset its backoff. No-op when omitted.
   */
  onOpen?: () => void;
  /**
   * Called once each time the underlying socket closes (before any reconnect is
   * scheduled). Lets an owner — the mobile connection manager — react to a drop
   * by re-probing candidate URLs and switching the live endpoint. Omitting it is
   * a no-op, so web callers are unaffected.
   */
  onClose?: () => void;
  /**
   * Gate consulted before the client self-schedules a reconnect after a close.
   * Returning false suppresses the client's own reconnect entirely, handing that
   * responsibility to the caller (which reconnects via `resync()` when ready) —
   * the manager returns false while a `server_shutdown` freeze is in effect so
   * the phone stops hammering a deliberately-downed desktop. When omitted, the
   * client always self-reconnects exactly as before.
   */
  shouldReconnect?: () => boolean;
}

export interface SessionSubscription {
  /** Reconnect/resubscribe from the last seen seq (tab became visible, app foregrounded). */
  resync(): void;
  /** Confirm a live cursor resubscribe; false means the socket is half-open/dead. */
  confirmResync(timeoutMs?: number): Promise<boolean>;
  /** RPC over the same socket, e.g. steer. Rejects with the server's {code, message}. */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

const DEFAULT_RECONNECT_MS = 2000;
const DEFAULT_RESYNC_ACK_TIMEOUT_MS = 2000;

export function subscribeSessionEvents(options: SessionSubscriptionOptions): SessionSubscription {
  if (
    options.webSocketFactory === undefined &&
    options.reconnectMs === undefined &&
    options.reconnectDelays === undefined &&
    options.onNotice === undefined &&
    options.onOpen === undefined &&
    options.onClose === undefined &&
    options.shouldReconnect === undefined
  ) {
    return subscribeBrowserSessionEvents(options);
  }
  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
  const factory: WebSocketFactory =
    options.webSocketFactory ??
    ((url) => new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));

  let lastSeq = options.since ?? 0;
  let closed = false;
  let socket: WebSocketLike | null = null;
  let socketOpen = false;
  // True while resync() is deliberately tearing down a stale socket to open a
  // fresh one. That close is intentional, not a drop, so the close handler must
  // NOT fire onClose or schedule a reconnect — otherwise a manager that reopens
  // via resync() would see its own teardown as a fresh drop and recurse.
  let reopening = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Counts consecutive reconnect attempts for the backoff hook; reset to 0 the
  // moment a socket opens so a recovered connection starts the next storm fresh.
  let reconnectAttempt = 0;
  let nextRpcId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const rejectPending = () => {
    for (const rpc of pending.values()) rpc.reject(new Error('connection closed'));
    pending.clear();
  };

  const sendSubscribe = () => {
    const tail =
      lastSeq === 0 && Number.isFinite(options.tail) && (options.tail ?? 0) > 0
        ? Math.floor(options.tail!)
        : undefined;
    socket?.send(
      JSON.stringify({
        id: nextRpcId++,
        method: 'subscribe',
        params: {
          sessionId: options.sessionId,
          since: lastSeq,
          ...(tail !== undefined ? { tail } : {}),
        },
      }),
    );
  };

  const confirmSubscribe = (timeoutMs: number): Promise<boolean> => {
    if (closed || !socketOpen || !socket) return Promise.resolve(false);
    const id = nextRpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        resolve(false);
      }, timeoutMs);
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(false);
        },
      });
      try {
        socket!.send(JSON.stringify({
          id,
          method: 'subscribe',
          params: { sessionId: options.sessionId, since: lastSeq },
        }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(false);
      }
    });
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
      options.onOpen?.();
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
      // Additive top-level notice frame (e.g. server_shutdown). Dedicated
      // sockets (mobile / custom options) forward via onNotice; the browser
      // shared pool resubscribes from lastSeq on `server_shutdown` itself.
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
      rejectPending();
      // Intentional teardowns are not drops: close() (the whole subscription is
      // being disposed) and resync()'s stale-socket swap both close deliberately,
      // so neither must fire onClose or schedule a reconnect — otherwise an owner
      // that reopens on close would see its own teardown as a fresh drop and loop.
      if (closed || reopening) return;
      // Let an owner react to the drop first (probe/URL-switch), then self-heal
      // only if it hasn't taken over reconnection. A caller that gates via
      // shouldReconnect()===false owns the reconnect and drives it with resync();
      // with no gate, the client self-reconnects exactly as it always has.
      options.onClose?.();
      if (options.shouldReconnect && !options.shouldReconnect()) return;
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
      reopening = true;
      try {
        socket?.close();
      } catch {
        // already dead — reconnect below regardless
      } finally {
        reopening = false;
      }
      connect();
    },
    confirmResync(timeoutMs = DEFAULT_RESYNC_ACK_TIMEOUT_MS) {
      return confirmSubscribe(timeoutMs);
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
      rejectPending();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
