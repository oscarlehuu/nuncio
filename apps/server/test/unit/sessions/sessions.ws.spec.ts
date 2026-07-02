import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  attachSessionsWebSocketServer,
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

function startServer(fake: SessionRelayService, options?: SessionsWsOptions): Promise<number> {
  server = createServer();
  attachSessionsWebSocketServer(server, fake, undefined, undefined, options);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('sessions WS relay', () => {
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
      maxBufferedBytes: 100,
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
