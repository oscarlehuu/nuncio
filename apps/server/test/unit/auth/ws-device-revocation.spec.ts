import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import type { RevocableDeviceValidator } from '../../../src/auth/device-token';
import { DEVICE_REVOKED_CLOSE_CODE } from '../../../src/auth/device-socket-registry';
import {
  attachSessionsWebSocketServer,
  SESSIONS_WS_PATH,
  type SessionRelayService,
} from '../../../src/sessions/api/sessions.ws';
import { attachTerminalWebSocketServer } from '../../../src/terminal/terminal.ws';
import type { TerminalService } from '../../../src/terminal/terminal.service';

/**
 * A device validator that verifies one known credential and lets the test fire a
 * revocation, mirroring DevicesService.onRevoke. `verifyDevice` keeps returning
 * true after revoke — real revocation is enforced by severing the live socket
 * (this suite's subject), not by the validator, whose result only gates upgrades.
 */
function makeDevices(): RevocableDeviceValidator & { revoke(id: string): void } {
  const listeners = new Set<(id: string) => void>();
  return {
    verifyDevice: (id, secret) => id === 'dev1' && secret === 'good',
    onRevoke: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revoke: (id) => {
      for (const listener of listeners) listener(id);
    },
  };
}

function fakeSessions(): SessionRelayService {
  return {
    get: () => ({ id: 'sess-1' }),
    getEvents: () => [],
    subscribe: () => () => {},
    steer: async () => ({}),
  };
}

const fakeTerminal = {
  create: () => {},
  write: () => {},
  resize: () => {},
  kill: () => {},
  setOutputSink: () => {},
  setExitSink: () => {},
} as unknown as TerminalService;

let server: Server | null = null;

/**
 * Forces the upgrade to be seen as coming from a non-loopback address so the
 * device-bearer branch (not the loopback shortcut) authorizes it. Runs before
 * the attach handler by being registered first.
 */
function forceRemoteAddress(httpServer: Server, address: string): void {
  httpServer.on('upgrade', (_req, socket) => {
    try {
      Object.defineProperty(socket, 'remoteAddress', { value: address, configurable: true });
    } catch {
      // Already redefined — fine.
    }
  });
}

function listen(httpServer: Server): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as AddressInfo).port));
  });
}

const DEVICE_HEADERS = { authorization: 'Bearer nd1.dev1.good' };

function connect(
  port: number,
  path: string,
  headers: Record<string, string> = DEVICE_HEADERS,
): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

/** Resolves 'open' if the upgrade succeeds or 'rejected' if the server refuses it. */
function connectOutcome(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => resolve('rejected'));
  });
}

const tokens = { isValidToken: (c: unknown) => c === 'server-token' };

function waitForClose(ws: WsClient, ms = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), ms);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('WS device revocation', () => {
  it('closes a live sessions WS when its device is revoked', async () => {
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachSessionsWebSocketServer(server, fakeSessions(), undefined, undefined, devices);
    const port = await listen(server);

    const ws = await connect(port, SESSIONS_WS_PATH);
    const closed = waitForClose(ws);
    devices.revoke('dev1');
    expect(await closed).toBe(DEVICE_REVOKED_CLOSE_CODE);
  });

  it('closes a live terminal WS when its device is revoked', async () => {
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachTerminalWebSocketServer(server, fakeTerminal, undefined, undefined, devices);
    const port = await listen(server);

    const ws = await connect(port, '/api/terminal');
    const closed = waitForClose(ws);
    devices.revoke('dev1');
    expect(await closed).toBe(DEVICE_REVOKED_CLOSE_CODE);
  });

  it('tags + revokes a sessions WS authorized by nd1 bearer even when a valid cookie is also sent', async () => {
    // The device credential decides: the socket must be tagged for revocation and
    // not slip through the global-token/cookie branch (which returns no deviceId).
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachSessionsWebSocketServer(server, fakeSessions(), tokens, undefined, devices);
    const port = await listen(server);

    const ws = await connect(port, SESSIONS_WS_PATH, {
      authorization: 'Bearer nd1.dev1.good',
      cookie: 'nuncio_token=server-token',
    });
    const closed = waitForClose(ws);
    devices.revoke('dev1');
    expect(await closed).toBe(DEVICE_REVOKED_CLOSE_CODE);
  });

  it('rejects a terminal WS upgrade with a revoked nd1 bearer even alongside a valid cookie', async () => {
    const devices: ReturnType<typeof makeDevices> = {
      ...makeDevices(),
      verifyDevice: () => false, // device revoked/rotated-out: never verifies
    };
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachTerminalWebSocketServer(server, fakeTerminal, tokens, undefined, devices);
    const port = await listen(server);

    const outcome = await connectOutcome(port, '/api/terminal', {
      authorization: 'Bearer nd1.dev1.good',
      cookie: 'nuncio_token=server-token',
    });
    expect(outcome).toBe('rejected');
  });

  it('rejects a sessions WS upgrade with a malformed nd1 bearer even alongside a valid cookie', async () => {
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachSessionsWebSocketServer(server, fakeSessions(), tokens, undefined, devices);
    const port = await listen(server);

    const outcome = await connectOutcome(port, SESSIONS_WS_PATH, {
      authorization: 'Bearer nd1.a.b.c', // claims the scheme but is malformed
      cookie: 'nuncio_token=server-token',
    });
    expect(outcome).toBe('rejected');
  });

  it('does NOT close an open device socket on rotation — only revoke severs (grace by design)', async () => {
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachSessionsWebSocketServer(server, fakeSessions(), undefined, undefined, devices);
    const port = await listen(server);

    const ws = await connect(port, SESSIONS_WS_PATH);
    // No revoke event fires on rotation, so the socket must stay open.
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(WsClient.OPEN);
    ws.close();
  });

  it('revoking a device whose socket already closed is a clean no-op (no leak)', async () => {
    const devices = makeDevices();
    server = createServer();
    forceRemoteAddress(server, '192.168.1.50');
    attachSessionsWebSocketServer(server, fakeSessions(), undefined, undefined, devices);
    const port = await listen(server);

    const ws = await connect(port, SESSIONS_WS_PATH);
    await new Promise<void>((res) => {
      ws.on('close', () => res());
      ws.close();
    });
    // Give the server's close handler a tick to untag the socket.
    await new Promise((r) => setTimeout(r, 50));
    expect(() => devices.revoke('dev1')).not.toThrow();
  });
});
