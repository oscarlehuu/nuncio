import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('EventsRepository', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-events-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    database = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('append increments seq per session starting at 1', () => {
    const s = sessions.create({ prompt: 'seq test' });
    const e1 = events.append(s.id, 'user_message', { text: 'a' });
    const e2 = events.append(s.id, 'assistant_message', { text: 'b' });
    const e3 = events.append(s.id, 'status', { status: 'IDLE' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('list returns events in seq order and respects the since cursor', () => {
    const s = sessions.create({ prompt: 'cursor test' });
    events.append(s.id, 'user_message', { text: 'a' });
    events.append(s.id, 'assistant_delta', { delta: 'b' });
    events.append(s.id, 'assistant_message', { text: 'c' });

    expect(events.list(s.id).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.list(s.id, 1).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('list only returns events for the requested session', () => {
    const a = sessions.create({ prompt: 'session a' });
    const b = sessions.create({ prompt: 'session b' });
    events.append(a.id, 'user_message', { text: 'a1' });
    events.append(b.id, 'user_message', { text: 'b1' });
    events.append(a.id, 'assistant_message', { text: 'a2' });

    expect(events.list(a.id)).toHaveLength(2);
    expect(events.list(b.id)).toHaveLength(1);
  });

  it('list honors a limit while keeping ascending order', () => {
    const s = sessions.create({ prompt: 'limit test' });
    for (let i = 1; i <= 5; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.list(s.id, 0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(events.list(s.id, 2, 2).map((e) => e.seq)).toEqual([3, 4]);
    expect(events.list(s.id, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('listTail returns the last n events in ascending order', () => {
    const s = sessions.create({ prompt: 'tail test' });
    for (let i = 1; i <= 5; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.listTail(s.id, 2).map((e) => e.seq)).toEqual([4, 5]);
    expect(events.listTail(s.id, 10).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('listSince returns events after a seq, ascending and bounded', () => {
    const s = sessions.create({ prompt: 'since test' });
    for (let i = 1; i <= 5; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.listSince(s.id, 2, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(events.listSince(s.id, 0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(events.listSince(s.id, 5, 10)).toEqual([]);
  });

  it('listBefore returns the page preceding a seq in ascending order', () => {
    const s = sessions.create({ prompt: 'before test' });
    for (let i = 1; i <= 5; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.listBefore(s.id, 4, 2).map((e) => e.seq)).toEqual([2, 3]);
    expect(events.listBefore(s.id, 2, 5).map((e) => e.seq)).toEqual([1]);
    expect(events.listBefore(s.id, 1, 5)).toEqual([]);
  });

  it('projects lifetime status plus only windowed observability facts', () => {
    const s = sessions.create({ prompt: 'observability window' });
    const rows = [
      events.append(s.id, 'status', { status: 'RUNNING' }),
      events.append(s.id, 'assistant_delta', { delta: 'old noise' }),
      events.append(s.id, 'user_message', { text: 'inside' }),
      events.append(s.id, 'steer_queued', { text: 'inside' }),
      events.append(s.id, 'verify_result', { ok: true }),
      events.append(s.id, 'verify_needs_attention', { reason: 'inside' }),
      events.append(s.id, 'tool_end', { output: 'inside noise' }),
      events.append(s.id, 'status', { status: 'IDLE' }),
      events.append(s.id, 'steer_message', { text: 'at upper bound' }),
    ];
    const timestamps = [10, 11, 20, 21, 22, 23, 24, 30, 40];
    rows.forEach((row, index) => {
      database.db.prepare('UPDATE events SET created_at = ? WHERE session_id = ? AND seq = ?')
        .run(timestamps[index]!, s.id, row.seq);
    });
    for (let index = 0; index < 300; index += 1) {
      const noise = events.append(s.id, 'assistant_delta', { delta: `noise-${index}` });
      database.db.prepare('UPDATE events SET created_at = ? WHERE session_id = ? AND seq = ?')
        .run(25, s.id, noise.seq);
    }

    const projected = events.listObservabilityWindow(s.id, 20, 40);
    expect(projected.map((event) => [event.seq, event.type, event.createdAt])).toEqual([
      [1, 'status', 10],
      [3, 'user_message', 20],
      [4, 'steer_queued', 21],
      [5, 'verify_result', 22],
      [6, 'verify_needs_attention', 23],
      [8, 'status', 30],
    ]);
  });

  it('projects only bounded timeline facts with inclusive-from exclusive-to boundaries', () => {
    const s = sessions.create({ prompt: 'timeline window' });
    const rows = [
      events.append(s.id, 'status', { status: 'RUNNING' }),
      events.append(s.id, 'verify_needs_attention', { reason: 'inside' }),
      events.append(s.id, 'user_message', { text: 'not a timeline fact' }),
      events.append(s.id, 'status', { status: 'IDLE' }),
    ];
    [19, 20, 21, 30].forEach((at, index) => {
      database.db.prepare('UPDATE events SET created_at = ? WHERE session_id = ? AND seq = ?')
        .run(at, s.id, rows[index]!.seq);
    });

    expect(events.listTimelineWindow(s.id, 20, 30).map((event) => [event.seq, event.type])).toEqual([
      [2, 'verify_needs_attention'],
    ]);
  });

  it('countRecentByTypeWithOriginTag counts tagged events since the cutoff, ignoring the flood', () => {
    const s = sessions.create({ prompt: 'origin count' });
    for (let i = 0; i < 3; i += 1) {
      events.append(s.id, 'steer_message', { text: `wake ${i}`, origin: 'task-digest' });
    }
    // A different origin and untagged noise must NOT be counted.
    events.append(s.id, 'steer_message', { text: 'user steer' });
    events.append(s.id, 'steer_message', { text: 'other', origin: 'mobile' });
    // A large flood of other-typed events (the tail-window evasion case).
    for (let i = 0; i < 300; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.countRecentByTypeWithOriginTag(s.id, 'steer_message', 'task-digest', 0)).toBe(3);
    // A cutoff in the future counts nothing.
    expect(
      events.countRecentByTypeWithOriginTag(s.id, 'steer_message', 'task-digest', Date.now() + 60_000),
    ).toBe(0);
  });

  it('append truncates oversized payloads with an explicit marker', () => {
    const s = sessions.create({ prompt: 'oversize test' });
    const oversized = 'x'.repeat(200 * 1024);
    const appended = events.append(s.id, 'tool_end', { tool: 'bash', output: oversized });

    const stored = events.list(s.id)[0]!;
    expect(stored.payload).toMatchObject({ truncated: true });
    expect((stored.payload as { preview: string }).preview.length).toBeLessThan(oversized.length);
    // The returned event mirrors what was stored, not the oversized original.
    expect(appended.payload).toEqual(stored.payload);
  });

  it('append round-trips the payload as an object', () => {
    const s = sessions.create({ prompt: 'payload test' });
    events.append(s.id, 'status', { status: 'RUNNING', extra: 42 });
    const [ev] = events.list(s.id);
    expect(ev.type).toBe('status');
    expect((ev.payload as { status: string; extra: number }).status).toBe('RUNNING');
    expect((ev.payload as { extra: number }).extra).toBe(42);
  });
});
