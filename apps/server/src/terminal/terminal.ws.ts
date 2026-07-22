import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TerminalService } from './terminal.service';
import type { AuthRequestLike, TokenValidator } from '../auth/auth-request';
import type { DeviceValidator, RevocableDeviceValidator } from '../auth/device-token';
import { DeviceSocketRegistry } from '../auth/device-socket-registry';
import { authorizeUpgrade, isAuthorizedUpgrade, type RemoteTrust } from '../auth/upgrade-auth';

interface TerminalClientMessage {
  type?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  data?: unknown;
}

function isTerminalClientMessage(value: unknown): value is TerminalClientMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { RemoteTrust } from '../auth/upgrade-auth';

/** Shared WS upgrade rule (see auth/upgrade-auth.ts), kept under its historical name. */
export function isAuthorizedTerminalUpgrade(
  req: AuthRequestLike,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  devices?: DeviceValidator,
): Promise<boolean> {
  return isAuthorizedUpgrade(req, authTokens, trust, devices);
}

export function attachTerminalWebSocketServer(
  httpServer: Server,
  terminalService: TerminalService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  devices?: RevocableDeviceValidator,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Revocation must sever the live sockets a device opened, not just block future
  // upgrades; the registry maps each device to its open sockets for that purpose.
  const deviceSockets = new DeviceSocketRegistry();
  const unsubscribeRevoke = devices?.onRevoke((deviceId) => deviceSockets.closeForDevice(deviceId));
  if (unsubscribeRevoke) {
    wss.on('close', unsubscribeRevoke);
  }
  const pendingDeviceId = new WeakMap<WebSocket, string>();

  httpServer.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/terminal') {
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

  wss.on('connection', (ws) => {
    let terminalId: string | null = null;

    const deviceId = pendingDeviceId.get(ws);
    if (deviceId) {
      pendingDeviceId.delete(ws);
      deviceSockets.add(deviceId, ws);
    }

    const killTerminal = () => {
      if (!terminalId) return;
      terminalService.kill(terminalId);
      terminalId = null;
    };

    // Socket-level teardown: kill the pty AND untag the socket so a later revoke
    // of this device never touches an already-gone connection. Distinct from
    // killTerminal(), which also fires mid-session on a `start` restart.
    const onSocketClosed = () => {
      if (deviceId) deviceSockets.remove(deviceId, ws);
      killTerminal();
    };

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        parsed = JSON.parse(text) as unknown;
      } catch {
        return;
      }
      if (!isTerminalClientMessage(parsed)) return;
      const message = parsed;

      if (message.type === 'start') {
        killTerminal();
        terminalId = randomUUID();
        terminalService.setOutputSink(terminalId, (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data }));
          }
        });
        terminalService.setExitSink(terminalId, (code) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code }));
          }
        });
        terminalService.create({
          id: terminalId,
          cwd: typeof message.cwd === 'string' ? message.cwd : undefined,
          cols: typeof message.cols === 'number' ? message.cols : Number(message.cols),
          rows: typeof message.rows === 'number' ? message.rows : Number(message.rows),
        });
        return;
      }

      if (!terminalId) return;

      if (message.type === 'input') {
        if (typeof message.data === 'string') {
          terminalService.write(terminalId, message.data);
        }
      } else if (message.type === 'resize') {
        terminalService.resize(
          terminalId,
          typeof message.cols === 'number' ? message.cols : Number(message.cols),
          typeof message.rows === 'number' ? message.rows : Number(message.rows),
        );
      }
    });

    ws.on('close', onSocketClosed);
    ws.on('error', onSocketClosed);
  });

  return wss;
}
