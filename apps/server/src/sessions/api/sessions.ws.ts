import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TokenValidator } from '../../auth/auth-request';
import { isAuthorizedUpgrade, type RemoteTrust } from '../../auth/upgrade-auth';
import type { SessionEvent } from '../domain/sessions.types';

export const SESSIONS_WS_PATH = '/api/sessions/ws';

/**
 * Structural slice of SessionsService the relay needs. Replay semantics match
 * the SSE endpoint exactly: events with seq > since first, then live pushes —
 * the client dedupes/sorts by seq, so a reconnect with the last seen seq is
 * gap-free.
 */
export interface SessionRelayService {
  get(id: string): unknown;
  getEvents(id: string, since?: number): SessionEvent[];
  subscribe(id: string, listener: (event: SessionEvent) => void): () => void;
  steer(id: string, message: string, forceResume?: boolean): Promise<unknown>;
}

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
}

export interface SessionsWsOptions {
  /** Outbound-buffer bound per connection; a subscription that overflows it is
   * dropped to cursor recovery instead of buffering unboundedly. */
  maxBufferedBytes?: number;
  /** Test seam — production reads ws.bufferedAmount. */
  getBufferedAmount?: (ws: WebSocket) => number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;

function errorOf(err: unknown): RpcError {
  const maybe = err as { getStatus?: () => number; message?: unknown } | null;
  const code = typeof maybe?.getStatus === 'function' ? maybe.getStatus() : 500;
  const message = typeof maybe?.message === 'string' ? maybe.message : 'Internal error';
  return { code, message };
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function attachSessionsWebSocketServer(
  httpServer: Server,
  sessions: SessionRelayService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  options?: SessionsWsOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const maxBuffered = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const bufferedAmount = options?.getBufferedAmount ?? ((socket: WebSocket) => socket.bufferedAmount);

  httpServer.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== SESSIONS_WS_PATH) {
      return;
    }

    const remoteAddress = (socket as unknown as { remoteAddress?: string }).remoteAddress;
    void isAuthorizedUpgrade({ headers: req.headers, socket: { remoteAddress } }, authTokens, trust)
      .then((authorized) => {
        if (!authorized) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      })
      .catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket) => {
    const subscriptions = new Map<string, () => void>();
    // Keep NATed mobile connections alive across idle stretches.
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15000);

    const teardown = () => {
      clearInterval(heartbeat);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    };

    const handle = async (msg: RpcMessage): Promise<void> => {
      const id = msg.id;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;

      if (msg.method === 'subscribe') {
        if (!sessionId || !sessions.get(sessionId)) {
          send(ws, { id, error: { code: 404, message: 'Session not found' } });
          return;
        }
        const rawSince = Number(params.since ?? 0);
        const since = Number.isFinite(rawSince) ? rawSince : 0;
        // Resubscribe replaces the previous subscription (drop-to-cursor recovery).
        subscriptions.get(sessionId)?.();
        send(ws, { id, result: { ok: true } });

        // A subscription that outruns the socket is dropped, not buffered: the
        // client gets one small "behind" marker and recovers by resubscribing
        // from its last seen seq.
        for (const event of sessions.getEvents(sessionId, since)) {
          if (bufferedAmount(ws) > maxBuffered) {
            send(ws, { channel: sessionId, behind: true });
            return;
          }
          send(ws, { channel: sessionId, event });
        }
        let liveUnsub: () => void = () => {};
        let dropped = false;
        liveUnsub = sessions.subscribe(sessionId, (event) => {
          if (dropped) return;
          if (bufferedAmount(ws) > maxBuffered) {
            dropped = true;
            liveUnsub();
            subscriptions.delete(sessionId);
            send(ws, { channel: sessionId, behind: true });
            return;
          }
          send(ws, { channel: sessionId, event });
        });
        subscriptions.set(sessionId, liveUnsub);
        return;
      }

      if (msg.method === 'unsubscribe') {
        if (sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
        }
        send(ws, { id, result: { ok: true } });
        return;
      }

      if (msg.method === 'steer') {
        const message = typeof params.message === 'string' ? params.message : '';
        const forceResume = params.forceResume === true;
        if (!sessionId) {
          send(ws, { id, error: { code: 400, message: 'sessionId is required' } });
          return;
        }
        try {
          const result = await sessions.steer(sessionId, message, forceResume || undefined);
          send(ws, { id, result });
        } catch (err) {
          send(ws, { id, error: errorOf(err) });
        }
        return;
      }

      send(ws, { id, error: { code: 400, message: `Unknown method: ${String(msg.method)}` } });
    };

    ws.on('message', (raw) => {
      let msg: RpcMessage;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        msg = JSON.parse(text) as RpcMessage;
      } catch {
        return;
      }
      void handle(msg);
    });

    ws.on('close', teardown);
    ws.on('error', teardown);
  });

  return wss;
}
