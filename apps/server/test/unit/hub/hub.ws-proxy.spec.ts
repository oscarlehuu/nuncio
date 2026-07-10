import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { attachHubWebSocketProxy } from '../../../src/hub/hub.ws-proxy';
import type { HubService } from '../../../src/hub/hub.service';
import type { HubRegistryService } from '../../../src/hub/hub-registry.service';

interface ProxyOptions {
  maxBufferedBytes?: number;
  upstreamConnectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  getHeartbeatAlive?: (leg: 'client' | 'upstream', observedAlive: boolean) => boolean;
}

type AttachProxyWithOptions = (
  server: Server,
  hub: HubService,
  registry: HubRegistryService,
  auth?: undefined,
  trust?: undefined,
  options?: ProxyOptions,
) => void;

const attachWithOptions = attachHubWebSocketProxy as unknown as AttachProxyWithOptions;
const servers: Server[] = [];
const sockets = new Set<Socket>();

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function startHangingTarget(): Promise<string> {
  const target = createServer();
  target.on('upgrade', () => {
    // Intentionally never answer the upstream WebSocket handshake.
  });
  const port = await listen(target);
  return `http://127.0.0.1:${port}`;
}

async function startEchoTarget(onOpen?: (socket: WebSocket) => void): Promise<string> {
  const target = createServer();
  const wss = new WebSocketServer({ server: target });
  wss.on('connection', (socket) => {
    onOpen?.(socket);
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const port = await listen(target);
  return `http://127.0.0.1:${port}`;
}

async function startProxy(target: string, options: ProxyOptions): Promise<number> {
  const server = createServer();
  attachWithOptions(
    server,
    { enabled: () => true } as HubService,
    { registryMap: async () => new Map([['machine', target]]) } as unknown as HubRegistryService,
    undefined,
    undefined,
    options,
  );
  return listen(server);
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/m/machine/api/sessions/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

async function waitForClose(ws: WebSocket, timeoutMs = 300): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) server.close();
});

describe('hub WebSocket proxy reliability', () => {
  it('relays normal frames byte-for-byte in both directions', async () => {
    const target = await startEchoTarget();
    const port = await startProxy(target, {});
    const client = await connect(port);
    const received = new Promise<string>((resolve) => {
      client.once('message', (data) => resolve(data.toString()));
    });
    client.send('cursor-replay-frame');

    expect(await received).toBe('cursor-replay-frame');
    client.terminate();
  });

  it('closes both sides when the upstream handshake exceeds its deadline', async () => {
    const target = await startHangingTarget();
    const port = await startProxy(target, { upstreamConnectTimeoutMs: 20 });
    const client = await connect(port);

    const closed = await waitForClose(client);
    if (!closed) client.terminate();
    expect(closed).toBe(true);
  });

  it('caps client frames queued before the upstream socket opens', async () => {
    const target = await startHangingTarget();
    const port = await startProxy(target, {
      maxBufferedBytes: 32,
      upstreamConnectTimeoutMs: 1_000,
    });
    const client = await connect(port);
    client.send('x'.repeat(64));

    const closed = await waitForClose(client);
    if (!closed) client.terminate();
    expect(closed).toBe(true);
  });

  it('closes instead of buffering an oversized upstream frame for a slow client', async () => {
    const target = await startEchoTarget((socket) => socket.send('oversized'));
    const port = await startProxy(target, { maxBufferedBytes: 4 });
    const client = await connect(port);
    const received: string[] = [];
    client.on('message', (data) => received.push(data.toString()));

    expect(await waitForClose(client)).toBe(true);
    expect(received).toEqual([]);
  });

  for (const missedLeg of ['client', 'upstream'] as const) {
    it(`closes both sides when the ${missedLeg} leg misses its pong deadline`, async () => {
      const target = await startEchoTarget();
      const port = await startProxy(target, {
        heartbeatIntervalMs: 20,
        getHeartbeatAlive: (leg, observedAlive) => (
          leg === missedLeg ? false : observedAlive
        ),
      });
      const client = await connect(port);

      expect(await waitForClose(client)).toBe(true);
    });
  }
});
