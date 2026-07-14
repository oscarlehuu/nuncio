import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachSessionsWebSocketServer,
  SESSIONS_WS_PATH,
  type SessionRelayService,
  type SessionsWsOptions,
} from '../../../src/sessions/api/sessions.ws';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

interface FakeSessions extends SessionRelayService {
  emit(event: SessionEvent): void;
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
    get: (id) => (id === 'sess-1' ? { id } : undefined),
    getEvents: (_id, since = 0, options?: { tail?: number }) => {
      const replay = events.filter((event) => event.seq > since);
      return options?.tail === undefined ? replay : replay.slice(-options.tail);
    },
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steer: async (id) => ({ id, status: 'RUNNING' }),
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
      if ('channel' in msg && msg.event) {
        client.events.push(msg.event as SessionEvent);
      } else if (!('channel' in msg)) {
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
  attachSessionsWebSocketServer(server, fake, undefined, undefined, undefined, options);
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

describe('sessions WS relay — two clients', () => {
  it('fans live events to both subscribers; dropped client resumes gap-free', async () => {
    const fake = makeFakeSessions([1, 2, 3]);
    const port = await startServer(fake);

    const clientA = await connect(port);
    const clientB = await connect(port);

    clientA.send({ id: 1, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    clientB.send({ id: 2, method: 'subscribe', params: { sessionId: 'sess-1', since: 0 } });
    await clientA.waitFor(() => clientA.events.length === 3);
    await clientB.waitFor(() => clientB.events.length === 3);

    fake.emit({ seq: 4, type: 'assistant_delta', payload: { delta: 'live-1' }, createdAt: 4 });
    await clientA.waitFor(() => clientA.events.some((e) => e.seq === 4));
    await clientB.waitFor(() => clientB.events.some((e) => e.seq === 4));

    const lastSeenA = Math.max(...clientA.events.map((e) => e.seq));
    await clientA.close();

    fake.emit({ seq: 5, type: 'assistant_delta', payload: { delta: 'while-a-down' }, createdAt: 5 });
    fake.emit({ seq: 6, type: 'assistant_message', payload: { text: 'done' }, createdAt: 6 });
    await clientB.waitFor(() => clientB.events.some((e) => e.seq === 6));

    const clientA2 = await connect(port);
    clientA2.send({
      id: 3,
      method: 'subscribe',
      params: { sessionId: 'sess-1', since: lastSeenA },
    });
    await clientA2.waitFor(() => clientA2.events.length === 2);
    expect(clientA2.events.map((e) => e.seq)).toEqual([5, 6]);

    expect(clientA.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(clientB.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const client of [clientA, clientA2, clientB]) {
      const seqs = client.events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    }

    const covered = new Set([
      ...clientA.events,
      ...clientA2.events,
      ...clientB.events,
    ].map((e) => e.seq));
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);

    await clientA2.close();
    await clientB.close();
  });
});
