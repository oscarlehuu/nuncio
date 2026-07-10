import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TokenValidator } from '../../auth/auth-request';
import type { RevocableDeviceValidator } from '../../auth/device-token';
import { DeviceSocketRegistry } from '../../auth/device-socket-registry';
import { authorizeUpgrade, type RemoteTrust } from '../../auth/upgrade-auth';
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
  getEvents(id: string, since?: number, options?: { tail?: number }): SessionEvent[];
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
  /** Ping cadence and missed-pong deadline; production keeps mobile NATs warm at 15s. */
  heartbeatIntervalMs?: number;
  /** Test seam for deterministic half-open simulation. */
  getHeartbeatAlive?: (ws: WebSocket, observedAlive: boolean) => boolean;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_INITIAL_TAIL = 10_000;

function errorOf(err: unknown): RpcError {
  const maybe = err as { getStatus?: () => number; message?: unknown } | null;
  const code = typeof maybe?.getStatus === 'function' ? maybe.getStatus() : 500;
  const message = typeof maybe?.message === 'string' ? maybe.message : 'Internal error';
  return { code, message };
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      ws.terminate();
    }
  }
}

function serializedBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/**
 * Fire a one-shot `{ notice }` frame to every OPEN socket. Used on shutdown so
 * connected clients (phones on the relay) learn the server is going away and
 * flip to "offline" instantly instead of waiting out the heartbeat timeout.
 * Additive to the v1 relay envelope — clients ignore unknown top-level keys.
 * Best-effort per socket: a send that throws on one half-dead connection must
 * not stop the frame reaching the others, and it must never delay teardown.
 */
export function broadcastNotice(wss: WebSocketServer, notice: string): void {
  const frame = JSON.stringify({ notice });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(frame);
    } catch {
      // A socket can die between the state check and the write; skip it and
      // keep notifying the rest.
    }
  }
}

export function attachSessionsWebSocketServer(
  httpServer: Server,
  sessions: SessionRelayService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  devices?: RevocableDeviceValidator,
  options?: SessionsWsOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const maxBuffered = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const bufferedAmount = options?.getBufferedAmount ?? ((socket: WebSocket) => socket.bufferedAmount);
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  // Revocation must sever the live sockets a device opened, not just block future
  // upgrades; the registry maps each device to its open sockets for that purpose.
  const deviceSockets = new DeviceSocketRegistry();
  const unsubscribeRevoke = devices?.onRevoke((deviceId) => deviceSockets.closeForDevice(deviceId));
  if (unsubscribeRevoke) {
    wss.on('close', unsubscribeRevoke);
  }
  // deviceId of the connection currently being handed to 'connection', keyed by
  // socket so the connection handler can tag it for revocation.
  const pendingDeviceId = new WeakMap<WebSocket, string>();

  httpServer.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== SESSIONS_WS_PATH) {
      return;
    }

    const remoteAddress = (socket as unknown as { remoteAddress?: string }).remoteAddress;
    void authorizeUpgrade({ headers: req.headers, socket: { remoteAddress } }, authTokens, trust, devices)
      .then((authz) => {
        if (!authz.authorized) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (authz.deviceId) {
            pendingDeviceId.set(ws, authz.deviceId);
          }
          wss.emit('connection', ws, req);
        });
      })
      .catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket) => {
    const subscriptions = new Map<string, () => void>();
    let alive = true;
    let tornDown = false;
    ws.on('pong', () => {
      alive = true;
    });
    // Keep NATed mobile connections alive and force half-open peers through the
    // normal close/reconnect/cursor-replay path after one missed pong deadline.
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const heartbeatAlive = options?.getHeartbeatAlive?.(ws, alive) ?? alive;
      if (!heartbeatAlive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, heartbeatIntervalMs);

    const deviceId = pendingDeviceId.get(ws);
    if (deviceId) {
      pendingDeviceId.delete(ws);
      deviceSockets.add(deviceId, ws);
    }

    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      clearInterval(heartbeat);
      if (deviceId) deviceSockets.remove(deviceId, ws);
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
        const rawTail = Number(params.tail);
        if (
          since === 0 &&
          params.tail !== undefined &&
          (!Number.isSafeInteger(rawTail) || rawTail <= 0 || rawTail > MAX_INITIAL_TAIL)
        ) {
          send(ws, { id, error: { code: 400, message: `tail must be an integer from 1 to ${MAX_INITIAL_TAIL}` } });
          return;
        }
        const tail =
          since === 0 && Number.isSafeInteger(rawTail) && rawTail > 0
            ? rawTail
            : undefined;
        // Resubscribe replaces the previous subscription (drop-to-cursor recovery).
        subscriptions.get(sessionId)?.();
        send(ws, { id, result: { ok: true } });

        // A subscription that outruns the socket is dropped, not buffered: the
        // client gets one small "behind" marker and recovers by resubscribing
        // from its last seen seq.
        for (const event of sessions.getEvents(
          sessionId,
          since,
          tail !== undefined ? { tail } : undefined,
        )) {
          const push = { channel: sessionId, event };
          if (bufferedAmount(ws) + serializedBytes(push) > maxBuffered) {
            send(ws, { channel: sessionId, behind: true });
            return;
          }
          send(ws, push);
        }
        let liveUnsub: () => void = () => {};
        let dropped = false;
        liveUnsub = sessions.subscribe(sessionId, (event) => {
          if (dropped) return;
          const push = { channel: sessionId, event };
          if (bufferedAmount(ws) + serializedBytes(push) > maxBuffered) {
            dropped = true;
            liveUnsub();
            subscriptions.delete(sessionId);
            send(ws, { channel: sessionId, behind: true });
            return;
          }
          send(ws, push);
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
      void handle(msg).catch((error) => {
        send(ws, { id: msg.id, error: errorOf(error) });
      });
    });

    ws.on('close', teardown);
    ws.on('error', teardown);
  });

  return wss;
}
