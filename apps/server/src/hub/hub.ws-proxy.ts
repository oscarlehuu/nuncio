import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parseHubPath, resolveMachineTarget } from './hub-routing';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';
import { SESSIONS_WS_PATH } from '../sessions/api/sessions.ws';
import type { TokenValidator } from '../auth/auth-request';
import { isAuthorizedUpgrade, type RemoteTrust } from '../auth/upgrade-auth';

/** WS paths the hub is willing to relay to a target machine. */
const RELAYED_WS_PATHS = new Set(['/api/terminal', SESSIONS_WS_PATH]);

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
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!hub.enabled()) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = parseHubPath(url.pathname);
    if (!parsed || !RELAYED_WS_PATHS.has(parsed.targetPath)) return;

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
      const pending: (string | Buffer | ArrayBuffer | Buffer[])[] = [];

      upstream.on('open', () => {
        for (const msg of pending) upstream.send(msg);
        pending.length = 0;
      });
      // Buffer client frames sent before the upstream socket is open.
      client.on('message', (data: Buffer, isBinary: boolean) => {
        const payload = isBinary ? data : data.toString('utf8');
        if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
        else pending.push(payload);
      });
      upstream.on('message', (data: Buffer, isBinary: boolean) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(isBinary ? data : data.toString('utf8'));
        }
      });

      const closeBoth = () => {
        if (client.readyState === WebSocket.OPEN) client.close();
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
      };
      client.on('close', closeBoth);
      client.on('error', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
    });
  }
}
