import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SteerQueueRepository } from '../../../src/sessions/persistence/steer-queue.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SteerQueueRepository', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let queue: SteerQueueRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-steer-queue-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    queue = module.get(SteerQueueRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('dequeues in FIFO order and empties the queue', () => {
    const s = sessions.create({ prompt: 'fifo' });
    queue.enqueue(s.id, 'first');
    queue.enqueue(s.id, 'second');

    expect(queue.count(s.id)).toBe(2);
    expect(queue.dequeue(s.id)).toEqual({ message: 'first' });
    expect(queue.dequeue(s.id)).toEqual({ message: 'second' });
    expect(queue.dequeue(s.id)).toBeNull();
    expect(queue.count(s.id)).toBe(0);
  });

  it('round-trips attachments', () => {
    const s = sessions.create({ prompt: 'attachments' });
    const attachments = [{ kind: 'image' as const, mimeType: 'image/png', data: 'aGk=' }];
    queue.enqueue(s.id, 'with image', attachments);
    queue.enqueue(s.id, 'plain', []);

    expect(queue.dequeue(s.id)).toEqual({ message: 'with image', attachments });
    // An empty attachments array is stored and returned as "no attachments".
    expect(queue.dequeue(s.id)).toEqual({ message: 'plain' });
  });

  it('drainAll returns every queued steer in FIFO order and empties the queue', () => {
    const s = sessions.create({ prompt: 'drain' });
    const attachments = [{ kind: 'image' as const, mimeType: 'image/png', data: 'aGk=' }];
    queue.enqueue(s.id, 'first', attachments);
    queue.enqueue(s.id, 'second');

    expect(queue.drainAll(s.id)).toEqual([
      { message: 'first', attachments },
      { message: 'second' },
    ]);
    expect(queue.count(s.id)).toBe(0);
    // A second drain on the now-empty queue is a no-op.
    expect(queue.drainAll(s.id)).toEqual([]);
  });

  it('isolates queues per session', () => {
    const a = sessions.create({ prompt: 'session a' });
    const b = sessions.create({ prompt: 'session b' });
    queue.enqueue(a.id, 'for a');
    queue.enqueue(b.id, 'for b');

    expect(queue.dequeue(a.id)).toEqual({ message: 'for a' });
    expect(queue.count(a.id)).toBe(0);
    expect(queue.count(b.id)).toBe(1);
    queue.dequeue(b.id);
  });

  it('lists sessions with pending steers and clears them per session', () => {
    const a = sessions.create({ prompt: 'pending a' });
    const b = sessions.create({ prompt: 'pending b' });
    queue.enqueue(a.id, 'one');
    queue.enqueue(a.id, 'two');
    queue.enqueue(b.id, 'three');

    expect(queue.sessionIdsWithPending().sort()).toEqual([a.id, b.id].sort());

    queue.deleteForSession(a.id);
    expect(queue.count(a.id)).toBe(0);
    expect(queue.sessionIdsWithPending()).toEqual([b.id]);
    queue.deleteForSession(b.id);
    expect(queue.sessionIdsWithPending()).toEqual([]);
  });
});
