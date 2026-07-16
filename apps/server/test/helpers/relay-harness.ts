import { Test, type TestingModule } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../src/agents/agents.module';
import { CursorLocalModule } from '../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../src/db/database.module';
import { GitModule } from '../../src/git/git.module';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../src/sessions/sessions.service';
import {
  attachSessionsWebSocketServer,
  SESSIONS_WS_PATH,
  type SessionsWsOptions,
} from '../../src/sessions/api/sessions.ws';
import type { SessionEvent } from '../../src/sessions/domain/sessions.types';
import type { TokenValidator } from '../../src/auth/auth-request';
import type { RemoteTrust } from '../../src/auth/upgrade-auth';
import { configureSimulatedCursorEnv, withSimulatedCursorProvider } from './simulated-cursor-app';

/**
 * Boots the REAL session module graph (SQLite + SessionsService + agents) with a
 * simulated streaming provider, and attaches the REAL WS relay to a real HTTP
 * server over loopback — the production wiring from `main.ts`, minus the network
 * boundary. The fake-service unit specs (`sessions.ws.spec.ts`) pin the relay's
 * own logic; this harness is the integration/e2e layer on top of them, exercising
 * the same module graph an actual phone/web client drives. Shared by the adversity
 * e2e suite and the perf harness.
 */
export interface RelayHarnessOptions {
  /** Reuse a data dir to simulate a daemon restart on the same SQLite store. */
  dataDir?: string;
  wsOptions?: SessionsWsOptions;
  authTokens?: TokenValidator;
  trust?: RemoteTrust;
}

export interface RelayHarness {
  service: SessionsService;
  server: Server;
  port: number;
  wsUrl: string;
  dataDir: string;
  module: TestingModule;
  close(opts?: { keepDataDir?: boolean }): Promise<void>;
}

export async function bootRelayHarness(options: RelayHarnessOptions = {}): Promise<RelayHarness> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nuncio-relay-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  configureSimulatedCursorEnv();

  const module = await withSimulatedCursorProvider(
    Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
      providers: [SessionsService],
    }),
  ).compile();

  const service = module.get(SessionsService);
  const server = createServer();
  // Dev signature: (httpServer, sessions, authTokens?, trust?, devices?, options?, tickets?).
  // Device tokens and connection tickets are out of scope for these correctness/
  // perf paths — loopback upgrades pass without them.
  const wss = attachSessionsWebSocketServer(
    server,
    service,
    options.authTokens,
    options.trust,
    undefined,
    options.wsOptions,
    undefined,
  );

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  return {
    service,
    server,
    port,
    wsUrl: `ws://127.0.0.1:${port}${SESSIONS_WS_PATH}`,
    dataDir,
    module,
    async close(opts) {
      for (const client of wss.clients) client.terminate();
      // Upgraded WS sockets are detached from the HTTP server's keep-alive
      // tracking; without an explicit reap, server.close() waits forever.
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await module.close();
      if (!opts?.keepDataDir) {
        rmSync(dataDir, { recursive: true, force: true });
        delete process.env.NUNCIO_DATA_DIR;
        delete process.env.CURSOR_API_KEY;
      }
    },
  };
}

export interface RelayTestClient {
  ws: WebSocket;
  responses: Array<{ id?: unknown; result?: unknown; error?: { code: number; message: string } }>;
  events: SessionEvent[];
  behind: number;
  send(msg: unknown): void;
  subscribe(sessionId: string, since?: number): void;
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

/** A minimal live client over the bun global WebSocket (browser/phone shape). */
export function connectRelayClient(wsUrl: string): Promise<RelayTestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let rpcId = 1;
    const client: RelayTestClient = {
      ws,
      responses: [],
      events: [],
      behind: 0,
      send: (msg) => ws.send(JSON.stringify(msg)),
      subscribe: (sessionId, since = 0) =>
        ws.send(JSON.stringify({ id: rpcId++, method: 'subscribe', params: { sessionId, since } })),
      waitFor: (pred, ms = 4000) =>
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
      const msg = JSON.parse(String((e as MessageEvent).data));
      if ('channel' in msg) {
        if (msg.behind) client.behind += 1;
        else if (msg.event) client.events.push(msg.event as SessionEvent);
      } else {
        client.responses.push(msg);
      }
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error('relay connect failed')));
  });
}

/** Sorted seqs + any duplicates — the gap-free / dup-free audit primitive. */
export function seqAudit(events: SessionEvent[]): { seqs: number[]; duplicates: number[] } {
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
  const duplicates: number[] = [];
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] === seqs[i - 1]) duplicates.push(seqs[i]);
  }
  return { seqs, duplicates };
}
