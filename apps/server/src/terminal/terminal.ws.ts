import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TerminalService } from './terminal.service';
import { isLoopbackAddress } from './loopback';
import { isAuthorizedRequest, type AuthRequestLike, type TokenValidator } from '../auth/auth-request';

interface TerminalClientMessage {
  type?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  data?: unknown;
}

export interface RemoteTrust {
  isTrustedRemote(remoteAddress: unknown): Promise<boolean>;
}

/**
 * Terminal upgrade authorization — the same rule the HTTP AuthGuard enforces
 * on /api routes: loopback always passes; remote clients need the access token
 * (auth cookie or Bearer header) or a trusted tailnet identity. Without a
 * token validator/trust checker (tests, callers that opt out) remote is refused.
 */
export async function isAuthorizedTerminalUpgrade(
  req: AuthRequestLike,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
): Promise<boolean> {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    return true;
  }
  if (authTokens && isAuthorizedRequest(req, authTokens)) {
    return true;
  }
  if (trust) {
    try {
      return await trust.isTrustedRemote(req.socket?.remoteAddress);
    } catch {
      return false;
    }
  }
  return false;
}

export function attachTerminalWebSocketServer(
  httpServer: Server,
  terminalService: TerminalService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/terminal') {
      return;
    }

    const remoteAddress = (socket as unknown as { remoteAddress?: string }).remoteAddress;
    void isAuthorizedTerminalUpgrade({ headers: req.headers, socket: { remoteAddress } }, authTokens, trust)
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

  wss.on('connection', (ws) => {
    let terminalId: string | null = null;

    const killTerminal = () => {
      if (!terminalId) return;
      terminalService.kill(terminalId);
      terminalId = null;
    };

    ws.on('message', (raw) => {
      let message: TerminalClientMessage;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        message = JSON.parse(text) as TerminalClientMessage;
      } catch {
        return;
      }

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

    ws.on('close', killTerminal);
    ws.on('error', killTerminal);
  });

  return wss;
}
