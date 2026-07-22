import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { parseHubPath, resolveMachineTarget } from './hub-routing';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';
import { SESSIONS_WS_PATH } from '../sessions/api/sessions.ws';
import type { TokenValidator } from '../auth/auth-request';
import { isAuthorizedUpgrade, type RemoteTrust } from '../auth/upgrade-auth';
/** WS paths the hub is willing to relay to a target machine. */
const RELAYED_WS_PATHS = new Set(['/api/terminal', SESSIONS_WS_PATH]);
const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export interface HubWsProxyOptions {
  maxBufferedBytes?: number;
  upstreamConnectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Test seam for deterministic half-open simulation on either relay leg. */
  getHeartbeatAlive?: (leg: 'client' | 'upstream', observedAlive: boolean) => boolean;
}
function wireBytes(data: RawData | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}
/**
 * Relays /m/<machine>/api/terminal and /m/<machine>/api/sessions/ws upgrades
 * to the target machine's own WS endpoint. The hub dials the target over the
 * tailnet, so the target trusts the hub by whois identity — which is exactly
 * why the CLIENT must be authorized here at the hub edge (loopback, token, or
 * tailnet trust) before any frame is relayed. Frames are piped verbatim in
 * both directions. Non-hub upgrades and disabled hub mode are left untouched
 * so the local WS handlers still own their paths.
 */
export function attachHubWebSocketProxy(
  httpServer: Server,
  hub: HubService,
  registry: HubRegistryService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  options?: HubWsProxyOptions,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const upstreamConnectTimeoutMs =
    options?.upstreamConnectTimeoutMs ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS;
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!hub.enabled()) return;
    const rawUrl = req.url ?? '/';
    const parsed = parseHubPath(rawUrl);
    if (!parsed) {
      if (rawUrl.startsWith('/m/')) socket.destroy();
      return;
    }
    const targetPathname = parsed.targetPath.split('?')[0];
    if (!RELAYED_WS_PATHS.has(targetPathname)) return;

    void relay(req, socket, head, parsed.machine, parsed.targetPath);
  });

  async function relay(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    machine: string,
    targetPath: string,
  ) {
    const remoteAddress = (socket as unknown as { remoteAddress?: string }).remoteAddress;
    let authorized = false;
    try {
      authorized = await isAuthorizedUpgrade(
        { headers: req.headers, socket: { remoteAddress } },
        authTokens,
        trust,
      );
    } catch {
      authorized = false;
    }
    if (!authorized) {
      socket.destroy();
      return;
    }

    let target: string | null;
    try {
      target = resolveMachineTarget(machine, await registry.registryMap());
    } catch {
      target = null;
    }
    if (!target) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const targetUrl = `${target.replace(/^http/, 'ws')}${targetPath}`;
      const upstream = new WebSocket(targetUrl);
      const pending: Array<RawData | string> = [];
      let pendingBytes = 0;
      let clientAlive = true;
      let upstreamAlive = true;
      let closed = false;

      const terminate = (ws: WebSocket) => {
        if (ws.readyState === WebSocket.CLOSED) return;
        try {
          ws.terminate();
        } catch {
          // Already closing/closed.
        }
      };
      const closeBoth = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearInterval(heartbeat);
        pending.length = 0;
        pendingBytes = 0;
        terminate(client);
        terminate(upstream);
      };
      const sendBounded = (destination: WebSocket, payload: RawData | string): boolean => {
        if (destination.readyState !== WebSocket.OPEN) return false;
        if (destination.bufferedAmount + wireBytes(payload) > maxBufferedBytes) {
          closeBoth();
          return false;
        }
        try {
          destination.send(payload);
          return true;
        } catch {
          closeBoth();
          return false;
        }
      };

      const connectTimer = setTimeout(closeBoth, upstreamConnectTimeoutMs);
      const heartbeat = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) {
          const alive = options?.getHeartbeatAlive?.('client', clientAlive) ?? clientAlive;
          if (!alive) return closeBoth();
          clientAlive = false;
          try {
            client.ping();
          } catch {
            return closeBoth();
          }
        }
        if (upstream.readyState === WebSocket.OPEN) {
          const alive = options?.getHeartbeatAlive?.('upstream', upstreamAlive) ?? upstreamAlive;
          if (!alive) return closeBoth();
          upstreamAlive = false;
          try {
            upstream.ping();
          } catch {
            return closeBoth();
          }
        }
      }, heartbeatIntervalMs);

      client.on('pong', () => {
        clientAlive = true;
      });
      upstream.on('pong', () => {
        upstreamAlive = true;
      });

      upstream.on('open', () => {
        clearTimeout(connectTimer);
        if (closed) return;
        for (const msg of pending) {
          if (!sendBounded(upstream, msg)) return;
        }
        pending.length = 0;
        pendingBytes = 0;
      });
      // Buffer client frames sent before the upstream socket is open.
      client.on('message', (data: RawData, isBinary: boolean) => {
        const payload: RawData | string = isBinary ? data : data.toString();
        if (upstream.readyState === WebSocket.OPEN) {
          sendBounded(upstream, payload);
          return;
        }
        const bytes = wireBytes(payload);
        if (pendingBytes + bytes > maxBufferedBytes) {
          closeBoth();
          return;
        }
        pending.push(payload);
        pendingBytes += bytes;
      });
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        sendBounded(client, isBinary ? data : data.toString());
      });
      client.on('close', closeBoth);
      client.on('error', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
    });
  }
}
