// Helpers for driving Mock-provider sessions in the level-5 journey suite. The
// session is CREATED over loopback REST (always trusted by the AuthGuard, no
// token) so the browser can then drive/observe everything else through the UI.
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

/** The Mock provider's deterministic completed reply to an initial task. */
export const MOCK_TASK_REPLY =
  'I received your task. In mock mode (agent auth not configured), I simulate agent output. ' +
  'Configure a real provider to use an agent SDK harness.';

/** POST a Mock session and assert the create response shape. Extra fields (e.g.
 * `{ mode: 'debug' }`) are merged into the create body. */
export async function createMockSession(baseUrl, prompt, extra = {}) {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, provider: 'mock', ...extra }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const session = await res.json();
  if (session.provider !== 'mock' || !session.id) {
    throw new Error(`unexpected create response: ${JSON.stringify(session)}`);
  }
  return session;
}

/** Resolve once the server reports the session IDLE. */
export async function waitSessionIdle(baseUrl, id, waitFor, label = 'mock session to settle IDLE') {
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${id}`);
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === 'IDLE';
    },
    { label },
  );
}

/** The active (non-archived) session list. */
export async function listActiveSessions(baseUrl) {
  const res = await fetch(`${baseUrl}/api/sessions`);
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Seed a large transcript directly into the durable event log — the seam the
 * scroll-performance measurement needs. Driving the mock provider for hundreds
 * of turns would take minutes (each reply streams at 30 ms/chunk); instead we
 * open a SECOND SQLite connection to the daemon's `nuncio.db` (WAL, so a reader
 * + our one writer coexist) and bulk-insert `turns` user/assistant message pairs
 * in a single transaction. Safe only against a QUIESCENT session (no active run)
 * so our seq numbers never race the daemon's own appends; the harness seeds an
 * already-IDLE session. Seq continues from the session's current MAX(seq).
 *
 * Keep `turns` well under DETAIL_EVENT_TAIL (1000) so the web's bounded initial
 * load renders the WHOLE seeded transcript instead of silently capping the DOM.
 *
 * @param {string} dataDir   the daemon's NUNCIO_DATA_DIR (holds nuncio.db)
 * @param {string} sessionId the IDLE session to append to
 * @param {number} turns     number of user+assistant message pairs to insert
 * @returns {{ inserted: number, lastSeq: number }}
 */
export function seedTranscript(dataDir, sessionId, turns) {
  if (!Number.isInteger(turns) || turns <= 0) {
    throw new Error(`seedTranscript needs a positive turn count, got ${turns}`);
  }
  const db = new Database(join(dataDir, 'nuncio.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db
      .query('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
      .get(sessionId);
    let seq = (row?.seq ?? 0);
    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO events (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const seed = db.transaction((count) => {
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        insert.run(
          sessionId,
          seq,
          'user_message',
          JSON.stringify({ text: `Seeded turn ${i + 1}: scroll-perf transcript fixture.` }),
          now + seq,
        );
        seq += 1;
        insert.run(
          sessionId,
          seq,
          'assistant_message',
          JSON.stringify({
            text:
              `Reply ${i + 1}. This is deterministic seeded transcript content used to measure ` +
              'scroll smoothness on a long session. It spans a couple of lines so each block has ' +
              'real height and the rendered list is genuinely large.',
          }),
          now + seq,
        );
      }
    });
    seed(turns);
    return { inserted: turns * 2, lastSeq: seq };
  } finally {
    db.close();
  }
}
