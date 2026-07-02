import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parseHubPath, resolveMachineTarget } from './hub-routing';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';

/**
 * Relays a /m/<machine>/api/terminal WebSocket upgrade to the target machine's
 * own terminal WS. The hub dials the target over the tailnet, so the target
 * trusts the hub by whois identity. Frames are piped verbatim in both
 * directions. Non-hub upgrades and disabled hub mode are left untouched so the
 * local terminal WS handler still owns /api/terminal.
 */
export function attachHubWebSocketProxy(
  httpServer: Server,
  hub: HubService,
  registry: HubRegistryService,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!hub.enabled()) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = parseHubPath(url.pathname);
    if (!parsed || parsed.targetPath !== '/api/terminal') return;

    void relay(req, socket, head, parsed.machine);
  });

  async function relay(req: IncomingMessage, socket: Duplex, head: Buffer, machine: string) {
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
      const targetUrl = `${target.replace(/^http/, 'ws')}/api/terminal`;
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
