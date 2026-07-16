import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootRelayHarness,
  connectRelayClient,
  seqAudit,
  type RelayHarness,
} from '../../helpers/relay-harness';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

/**
 * Real-service e2e for the session WS relay: the REAL module graph (SQLite +
 * SessionsService + a simulated streaming provider) with the real relay over
 * loopback. The fake-service unit specs in `sessions.ws.spec.ts` /
 * `sessions.ws-two-clients.spec.ts` pin the relay's own logic (heartbeat, ack,
 * backpressure, single-drop replay). This suite adds the integration layer they
 * cannot reach: recovery under a reconnect STORM against a live turn, the
 * replay↔live handoff race with a real streaming provider, and convergence
 * across a daemon restart on the same SQLite store.
 */
interface StormingSubscriber {
  drop(): void;
  close(): void;
}

/** Mirrors the @nuncio/core client's gap-free contract (resubscribe from lastSeq
 * on every reconnect) so this test proves the SERVER stays gap-free under a storm. */
function stormingSubscriber(
  wsUrl: string,
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): StormingSubscriber {
  let lastSeq = 0;
  let closed = false;
  let ws: WebSocket;
  const connect = () => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ id: 1, method: 'subscribe', params: { sessionId, since: lastSeq } })),
    );
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String((e as MessageEvent).data));
      if (msg.channel && msg.event) {
        lastSeq = Math.max(lastSeq, msg.event.seq);
        onEvent(msg.event as SessionEvent);
      }
    });
    ws.addEventListener('close', () => {
      if (!closed) setTimeout(connect, 10);
    });
  };
  connect();
  return {
    drop: () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    close: () => {
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

describe('sessions WS relay — real-service e2e', () => {
  let harness: RelayHarness;

  beforeAll(async () => {
    harness = await bootRelayHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('reconnect storm mid-stream stays gap-free and complete from lastSeq', async () => {
    const session = await harness.service.create({ prompt: 'storm me', provider: 'cursor' });

    const received: SessionEvent[] = [];
    const sub = stormingSubscriber(harness.wsUrl, session.id, (event) => received.push(event));

    // Hammer the socket: repeated network drops while the turn streams. Each
    // reconnect resubscribes from lastSeq, so replay must recover every event.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 12));
      sub.drop();
    }

    await harness.service.awaitRun(session.id);
    await new Promise((r) => setTimeout(r, 150)); // let the final reconnect replay the tail
    sub.close();

    const truth = harness.service.getEvents(session.id, 0);
    const { seqs, duplicates } = seqAudit(received);
    const deduped = [...new Set(seqs)];

    // Gap-free + complete after the consumer-side seq dedup (owned by the web
    // hook / mergeEvents, not the relay): every persisted seq arrived at least once.
    expect(deduped).toEqual(truth.map((e) => e.seq));
    for (let i = 1; i < deduped.length; i += 1) {
      expect(deduped[i]).toBe(deduped[i - 1] + 1);
    }
    // Any duplicate is only ever an in-flight replay, never a lost event.
    expect(duplicates.every((d) => deduped.includes(d))).toBe(true);
  });

  it('subscribe at a turn boundary never drops an event between replay and live', async () => {
    // create() returns while the run streams asynchronously — subscribe into the
    // race window against a real streaming provider.
    const session = await harness.service.create({ prompt: 'race me', provider: 'cursor' });
    const client = await connectRelayClient(harness.wsUrl);
    client.subscribe(session.id, 0);

    await harness.service.awaitRun(session.id);
    await new Promise((r) => setTimeout(r, 150));

    const truth = harness.service.getEvents(session.id, 0);
    const { duplicates } = seqAudit(client.events);
    const seen = [...new Set(client.events.map((e) => e.seq))];
    expect(seen).toEqual(truth.map((e) => e.seq));
    expect(duplicates).toEqual([]);
    await client.close();
  });

  it('daemon restart mid-session: client resubscribes and converges to the persisted transcript', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-relay-restart-'));
    try {
      // --- daemon instance 1: run a turn, persist the transcript to SQLite ---
      const first = await bootRelayHarness({ dataDir });
      const session = await first.service.create({ prompt: 'before restart', provider: 'cursor' });
      await first.service.awaitRun(session.id);
      await first.service.steer(session.id, 'more before restart');
      const truthBefore = first.service.getEvents(session.id, 0).map((e) => e.seq);
      await first.close({ keepDataDir: true });

      // --- daemon instance 2: same SQLite store, the client comes back ---
      const second = await bootRelayHarness({ dataDir });
      const bootstrap = second.service.getEvents(session.id, 0); // REST bootstrap = source of truth
      expect(bootstrap.map((e) => e.seq)).toEqual(truthBefore);

      const client = await connectRelayClient(second.wsUrl);
      const lastSeq = bootstrap[bootstrap.length - 1]?.seq ?? 0;
      client.subscribe(session.id, lastSeq);

      // The resumed session still streams: steer produces new events live.
      await second.service.steer(session.id, 'after restart');
      const truthAfter = second.service.getEvents(session.id, 0);
      await client.waitFor(() => client.events.length === truthAfter.length - bootstrap.length);

      // Bootstrap + live converges exactly to the persisted transcript, gap-free.
      const merged = [...bootstrap, ...client.events].map((e) => e.seq);
      expect(merged).toEqual(truthAfter.map((e) => e.seq));
      for (let i = 1; i < merged.length; i += 1) {
        expect(merged[i]).toBe(merged[i - 1] + 1);
      }
      await client.close();
      await second.close({ keepDataDir: true });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.NUNCIO_DATA_DIR;
      delete process.env.CURSOR_API_KEY;
    }
  });
});
