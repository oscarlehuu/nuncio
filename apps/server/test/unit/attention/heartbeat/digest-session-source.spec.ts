import { describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';

/**
 * Digest completion count must include ARCHIVED sessions (finding #3): a session
 * completed-and-archived before the digest fires is still a completion. The
 * sessions source must use the archived-INCLUSIVE list.
 */
describe('HeartbeatService digest session source', () => {
  class SpySessions {
    calls: boolean[] = []; // records includeArchived per list() call
    rows = [
      { id: 'live', status: 'IDLE', createdAt: 0, projectPath: null, updatedAt: 0 },
      { id: 'archived', status: 'ARCHIVED', createdAt: 0, projectPath: null, updatedAt: 0 },
    ];
    list(includeArchived = false) {
      this.calls.push(includeArchived);
      return includeArchived ? this.rows : this.rows.filter((r) => r.status !== 'ARCHIVED');
    }
  }

  function build(sessions: SpySessions): HeartbeatService {
    const events = { latestEventAt: () => 250 }; // last activity inside the window
    // positions: scheduler, settings, attention, loops, infra, digests, push,
    // database, forges, sessions(10), events(11), collectors(12), attentionItems(13)
    return new HeartbeatService(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, sessions as never, events as never, undefined, undefined,
    );
  }

  it('counts an archived-in-window session as completed (uses list(true))', () => {
    const sessions = new SpySessions();
    const svc = build(sessions);
    (svc as unknown as { bindDataSeams: () => void }).bindDataSeams();

    const counts = svc.gatherDigestCounts(0, 500);
    // Both IDLE 'live' and ARCHIVED 'archived' completed in the window → 2.
    expect(counts.sessionsCompleted).toBe(2);
    // And the session list was fetched archived-inclusive at least once.
    expect(sessions.calls.some((c) => c === true)).toBe(true);
  });
});
