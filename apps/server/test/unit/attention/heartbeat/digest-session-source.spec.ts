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
    userFacingCalls: boolean[] = [];
    rows = [
      { id: 'live', status: 'IDLE', verifyOwner: 'session', createdAt: 0, projectPath: null, updatedAt: 0 },
      { id: 'archived', status: 'ARCHIVED', verifyOwner: 'session', createdAt: 0, projectPath: null, updatedAt: 0 },
    ];
    list(includeArchived = false) {
      this.calls.push(includeArchived);
      return includeArchived ? this.rows : this.rows.filter((r) => r.status !== 'ARCHIVED');
    }
    listUserFacing(includeArchived = false) {
      this.userFacingCalls.push(includeArchived);
      return this.rows.filter((row) => includeArchived || row.status !== 'ARCHIVED');
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
    // Both user-facing rows count.
    expect(counts.sessionsCompleted).toBe(2);
    expect(sessions.userFacingCalls.some((c) => c === true)).toBe(true);
    expect(sessions.calls).toEqual([]);
  });

  it('loads digest observability facts through the durable window projection', () => {
    const sessions = new SpySessions();
    const calls: Array<[string, number, number]> = [];
    const events = {
      list: () => { throw new Error('legacy full-history read'); },
      listObservabilityWindow: (id: string, from: number, to: number) => {
        calls.push([id, from, to]);
        return [];
      },
    };
    const svc = new HeartbeatService(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, sessions as never, events as never, undefined, undefined,
    );

    (svc as unknown as { digestInput: (from: number, to: number) => unknown }).digestInput(100, 200);
    expect(calls).toEqual([
      ['live', 100, 200],
      ['archived', 100, 200],
    ]);
  });
});
