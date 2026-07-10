import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import {
  attachSessionsWebSocketServer,
  broadcastNotice,
  SESSIONS_WS_PATH,
  type SessionRelayService,
  type SessionsWsOptions,
} from '../../../src/sessions/api/sessions.ws';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

interface FakeSessions extends SessionRelayService {
  emit(event: SessionEvent): void;
  steerCalls: Array<{ id: string; message: string; forceResume?: boolean }>;
  steerImpl: (id: string, message: string) => Promise<unknown>;
}

function makeFakeSessions(seed: number[] = []): FakeSessions {
  const events: SessionEvent[] = seed.map((seq) => ({
    seq,
    type: 'assistant_message',
    payload: { text: `event-${seq}` },
    createdAt: seq,
  }));
  const listeners = new Set<(event: SessionEvent) => void>();
  const fake: FakeSessions = {
    steerCalls: [],
    steerImpl: async (id) => ({ id, status: 'RUNNING' }),
    get: (id) => (id === 'sess-1' ? { id } : undefined),
    getEvents: (_id, since = 0) => events.filter((e) => e.seq > since),
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steer: (id, message, forceResume) => {
      fake.steerCalls.push({ id, message, forceResume });
      return fake.steerImpl(id, message);
    },
    emit: (event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  };
  return fake;
}

interface TestClient {
  ws: WebSocket;
  responses: Array<{ id: unknown; result?: unknown; error?: { code: number; message: string } }>;
  events: SessionEvent[];
  send(msg: unknown): void;
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

function connect(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SESSIONS_WS_PATH}`);
    const client: TestClient = {
      ws,
      responses: [],
      events: [],
      send: (msg) => ws.send(JSON.stringify(msg)),
      waitFor: (pred, ms = 2000) =>
        new Promise<void>((res, rej) => {
          const started = Date.now();
          const tick = () => {
            if (pred()) return res();
            if (Date.now() - started > ms) return rej(new Error('waitFor timeout'));
            setTimeout(tick, 10);
          };
          tick();
        }),
      close: () =>
        new Promise<void>((res) => {
          ws.addEventListener('close', () => res());
          ws.close();
        }),
    };
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if ('channel' in msg) {
        if (msg.event) client.events.push(msg.event as SessionEvent);
      } else {
        client.responses.push(msg);
      }
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error('connect failed')));
  });
}

let server: Server | null = null;
// Captured from attachSessionsWebSocketServer so the broadcastNotice end-to-end
// test can fire over the live server's real client set.
let sessionsWssForTest: WebSocketServer | null = null;

function startServer(fake: SessionRelayService, options?: SessionsWsOptions): Promise<number> {
  server = createServer();
  sessionsWssForTest = attachSessionsWebSocketServer(
    server,
    fake,
    undefined,
    undefined,
    undefined,
    options,
  );
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
  sessionsWssForTest = null;
});

describe('sessions WS relay', () => {
  it('terminates a half-open client that misses the pong deadline', async () => {
    const fake = makeFakeSessions();
    const port = await startServer(fake, {
      heartbeatIntervalMs: 20,
      getHeartbeatAlive: () => false,
    });
    const ws = new WsClient(`ws://127.0.0.1:${port}${SESSIONS_WS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const closed = await Promise.race([
      new Promise<boolean>((resolve) => ws.once('close', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    if (!closed) ws.terminate();
    expect(closed).toBe(true);
  });

  it('keeps a responsive client open across repeated heartbeat intervals', async () => {
    const fake = makeFakeSessions();
    const port = await startServer(fake, { heartbeatIntervalMs: 20 });
    const client = await connect(port);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it('resumes gap-free across a dropped socket (replay + live, no dupes)', async () => {
    const fake = makeFakeSessions([1, 2, 3]);
    const port = await startServer(fake);

    const first = await connect(port);
    first.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await first.waitFor(() => first.events.length === 3);

    fake.emit({ seq: 4, type: 'assistant_delta', payload: {}, createdAt: 4 });
    await first.waitFor(() => first.events.length === 4);
    await first.close();

    // Events emitted while disconnected must be recovered by cursor replay.
    fake.emit({ seq: 5, type: 'assistant_delta', payload: {}, createdAt: 5 });
    fake.emit({ seq: 6, type: 'assistant_message', payload: {}, createdAt: 6 });

    const second = await connect(port);
    const lastSeen = Math.max(...first.events.map((e) => e.seq));
    second.send({ id: 2, method: 'subscribe', params: { sessionId: 'sess-1', since: lastSeen } });
    await second.waitFor(() => second.events.length === 2);

    const seqs = [...first.events, ...second.events].map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    await second.close();
  });

  it('replays only events past the since cursor', async () => {
    const fake = makeFakeSessions([1, 2, 3, 4]);
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 2 } });
    await client.waitFor(() => client.events.length === 2);
    expect(client.events.map((e) => e.seq)).toEqual([3, 4]);
    await client.close();
  });

  it('rejects subscribing to an unknown session with a 404 error', async () => {
    const fake = makeFakeSessions();
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({ id: 7, method: 'subscribe', params: { sessionId: 'nope' } });
    await client.waitFor(() => client.responses.length === 1);
    expect(client.responses[0]).toEqual({ id: 7, error: { code: 404, message: 'Session not found' } });
    await client.close();
  });

  it('routes steer RPC to the service and returns its result', async () => {
    const fake = makeFakeSessions([1]);
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({
      id: 9,
      method: 'steer',
      params: { sessionId: 'sess-1', message: 'do it', forceResume: true },
    });
    await client.waitFor(() => client.responses.length === 1);
    expect(fake.steerCalls).toEqual([{ id: 'sess-1', message: 'do it', forceResume: true }]);
    expect(client.responses[0]).toEqual({ id: 9, result: { id: 'sess-1', status: 'RUNNING' } });
    await client.close();
  });

  it('maps thrown HttpExceptions onto the RPC error envelope', async () => {
    const fake = makeFakeSessions([1]);
    fake.steerImpl = async () => {
      throw Object.assign(new Error('Cursor is still running this chat'), {
        getStatus: () => 409,
      });
    };
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({ id: 3, method: 'steer', params: { sessionId: 'sess-1', message: 'hi' } });
    await client.waitFor(() => client.responses.length === 1);
    expect(client.responses[0]).toEqual({
      id: 3,
      error: { code: 409, message: 'Cursor is still running this chat' },
    });
    await client.close();
  });

  it('stops pushing after unsubscribe', async () => {
    const fake = makeFakeSessions([1]);
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => client.events.length === 1);
    client.send({ id: 2, method: 'unsubscribe', params: { sessionId: 'sess-1' } });
    await client.waitFor(() => client.responses.length === 2);
    fake.emit({ seq: 2, type: 'assistant_delta', payload: {}, createdAt: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.events.map((e) => e.seq)).toEqual([1]);
    await client.close();
  });

  it('drops an overflowing subscription with one behind marker instead of buffering', async () => {
    const fake = makeFakeSessions([1]);
    let buffered = 0;
    const port = await startServer(fake, {
      maxBufferedBytes: 1000,
      getBufferedAmount: () => buffered,
    });
    const client = await connect(port);
    const behind: unknown[] = [];
    client.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.behind) behind.push(msg);
    });

    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => client.events.length === 1);

    buffered = 10_000; // consumer stalls: socket queue over the bound
    fake.emit({ seq: 2, type: 'assistant_delta', payload: {}, createdAt: 2 });
    fake.emit({ seq: 3, type: 'assistant_delta', payload: {}, createdAt: 3 });
    await client.waitFor(() => behind.length === 1);

    // Subscription is gone — nothing more is pushed even after more emits.
    fake.emit({ seq: 4, type: 'assistant_delta', payload: {}, createdAt: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.events.map((e) => e.seq)).toEqual([1]);
    expect(behind.length).toBe(1);

    // Recovery: consumer catches up and resubscribes from its last seen seq.
    buffered = 0;
    client.send({ id: 2, method: 'subscribe', params: { sessionId: 'sess-1', since: 1 } });
    await client.waitFor(() => client.events.length === 4);
    expect(client.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    await client.close();
  });

  it('counts the next serialized event toward the outbound byte cap', async () => {
    const fake = makeFakeSessions([1]);
    const port = await startServer(fake, {
      maxBufferedBytes: 100,
      getBufferedAmount: () => 99,
    });
    const client = await connect(port);
    const behind: unknown[] = [];
    client.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.behind) behind.push(message);
    });

    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => behind.length === 1);

    expect(client.events).toEqual([]);
    expect(behind).toHaveLength(1);
    await client.close();
  });

  it('sends the behind marker mid-replay and loses no event across the resubscribe cycle', async () => {
    // The overflow can trip during the initial cursor replay, not only on live
    // pushes. When it does the client gets one behind marker; a resubscribe from
    // its last seen seq must then deliver every remaining backlog event exactly
    // once — the replay-phase drop must never swallow an event.
    const fake = makeFakeSessions([1, 2, 3, 4, 5]);
    let buffered = 0;
    const port = await startServer(fake, {
      maxBufferedBytes: 1000,
      getBufferedAmount: () => buffered,
    });
    const client = await connect(port);
    const behind: unknown[] = [];
    client.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.behind) behind.push(msg);
    });

    // Socket is already over the bound before the first replayed event is sent:
    // the replay loop must bail with a behind marker and send nothing.
    buffered = 10_000;
    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => behind.length === 1);
    expect(client.events.length).toBe(0);

    // Consumer drains and resubscribes from its last seen seq (0, since nothing
    // was delivered). Every backlog event arrives, in order, no gaps, no dupes.
    buffered = 0;
    client.send({ id: 2, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => client.events.length === 5);
    expect(client.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(behind.length).toBe(1);
    await client.close();
  });

  it('recovers events emitted after the drop and before the resubscribe (no gap in the window)', async () => {
    // The dangerous window: a subscription is dropped for overflow, then new
    // events land while the client is unsubscribed, then the client resubscribes.
    // Those in-between events have seq > lastSeen, so cursor replay must surface
    // them — otherwise streamed text emitted during recovery is lost silently.
    const fake = makeFakeSessions([1]);
    let buffered = 0;
    const port = await startServer(fake, {
      maxBufferedBytes: 1000,
      getBufferedAmount: () => buffered,
    });
    const client = await connect(port);
    const behind: unknown[] = [];
    client.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.behind) behind.push(msg);
    });

    client.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await client.waitFor(() => client.events.length === 1);
    const lastSeen = Math.max(...client.events.map((e) => e.seq));

    // Overflow drops the live subscription on the next emit.
    buffered = 10_000;
    fake.emit({ seq: 2, type: 'assistant_delta', payload: { delta: 'lost?' }, createdAt: 2 });
    await client.waitFor(() => behind.length === 1);

    // Events arriving strictly while the client holds no subscription.
    fake.emit({ seq: 3, type: 'assistant_delta', payload: { delta: 'window-1' }, createdAt: 3 });
    fake.emit({ seq: 4, type: 'assistant_delta', payload: { delta: 'window-2' }, createdAt: 4 });

    // Resubscribe from the last seq the client actually saw (1). Everything after
    // it — including the delta that triggered the drop and the two window events —
    // must replay, in order, with none skipped.
    buffered = 0;
    client.send({ id: 2, method: 'subscribe', params: { sessionId: 'sess-1', since: lastSeen } });
    await client.waitFor(() => client.events.length === 4);
    expect(client.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    await client.close();
  });

  it('answers unknown methods with a 400 error', async () => {
    const fake = makeFakeSessions();
    const port = await startServer(fake);
    const client = await connect(port);
    client.send({ id: 5, method: 'bogus', params: {} });
    await client.waitFor(() => client.responses.length === 1);
    expect(client.responses[0].error?.code).toBe(400);
    await client.close();
  });
});

/** Minimal WebSocket-shaped stub for exercising broadcastNotice in isolation. */
function fakeSocket(readyState: number) {
  const sent: string[] = [];
  return {
    sent,
    socket: {
      readyState,
      send: (data: string) => {
        sent.push(data);
      },
    } as unknown as WsClient,
  };
}

describe('broadcastNotice', () => {
  it('is a no-op on an empty client set', () => {
    const wss = { clients: new Set<WsClient>() } as unknown as WebSocketServer;
    expect(() => broadcastNotice(wss, 'server_shutdown')).not.toThrow();
  });

  it('sends the exact { notice } frame only to OPEN sockets', () => {
    const open = fakeSocket(WsClient.OPEN);
    const connecting = fakeSocket(WsClient.CONNECTING);
    const closing = fakeSocket(WsClient.CLOSING);
    const closed = fakeSocket(WsClient.CLOSED);
    const wss = {
      clients: new Set([open.socket, connecting.socket, closing.socket, closed.socket]),
    } as unknown as WebSocketServer;

    broadcastNotice(wss, 'server_shutdown');

    // Only the OPEN socket received anything, and the frame is exactly the
    // frozen farewell shape — no id, no channel, no extra keys.
    expect(open.sent).toHaveLength(1);
    expect(JSON.parse(open.sent[0])).toEqual({ notice: 'server_shutdown' });
    expect(connecting.sent).toHaveLength(0);
    expect(closing.sent).toHaveLength(0);
    expect(closed.sent).toHaveLength(0);
  });

  it('passes the notice value through verbatim', () => {
    const open = fakeSocket(WsClient.OPEN);
    const wss = { clients: new Set([open.socket]) } as unknown as WebSocketServer;
    broadcastNotice(wss, 'something_else');
    expect(JSON.parse(open.sent[0])).toEqual({ notice: 'something_else' });
  });

  it('keeps notifying the rest when one OPEN socket throws on send', () => {
    const throwing = {
      readyState: WsClient.OPEN,
      send: () => {
        throw new Error('socket is half-dead');
      },
    } as unknown as WsClient;
    const healthy = fakeSocket(WsClient.OPEN);
    const wss = {
      clients: new Set([throwing, healthy.socket]),
    } as unknown as WebSocketServer;

    expect(() => broadcastNotice(wss, 'server_shutdown')).not.toThrow();
    // The throwing socket must not abort delivery to the healthy one.
    expect(JSON.parse(healthy.sent[0])).toEqual({ notice: 'server_shutdown' });
  });

  it('delivers over a real OPEN socket end to end', async () => {
    const fake = makeFakeSessions();
    const port = await startServer(fake);
    const received: unknown[] = [];
    const ws = new WsClient(`ws://127.0.0.1:${port}${SESSIONS_WS_PATH}`);
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString('utf8'))));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // The server under test is the same wss the relay attached; reach it via the
    // module helper against the live server's client set.
    const address = server!.address() as AddressInfo;
    expect(address.port).toBe(port);
    // Give the server a tick to register the connection in wss.clients.
    await new Promise((r) => setTimeout(r, 20));
    broadcastNotice(sessionsWssForTest!, 'server_shutdown');

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (received.some((m) => (m as { notice?: string }).notice === 'server_shutdown')) {
          return resolve();
        }
        if (Date.now() - started > 2000) return reject(new Error('no farewell received'));
        setTimeout(tick, 10);
      };
      tick();
    });

    ws.close();
  });
});
