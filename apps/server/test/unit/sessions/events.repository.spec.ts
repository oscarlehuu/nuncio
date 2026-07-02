import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('EventsRepository', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-events-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
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

  it('listBefore returns the page preceding a seq in ascending order', () => {
    const s = sessions.create({ prompt: 'before test' });
    for (let i = 1; i <= 5; i += 1) events.append(s.id, 'assistant_delta', { delta: `${i}` });

    expect(events.listBefore(s.id, 4, 2).map((e) => e.seq)).toEqual([2, 3]);
    expect(events.listBefore(s.id, 2, 5).map((e) => e.seq)).toEqual([1]);
    expect(events.listBefore(s.id, 1, 5)).toEqual([]);
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
