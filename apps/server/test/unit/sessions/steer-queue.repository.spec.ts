import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SteerQueueRepository } from '../../../src/sessions/persistence/steer-queue.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('SteerQueueRepository', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let queue: SteerQueueRepository;
  let database: DatabaseService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-steer-queue-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    queue = module.get(SteerQueueRepository);
    database = module.get(DatabaseService);
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

  it('round-trips durable background failure context', () => {
    const s = sessions.create({ prompt: 'failure context' });
    const failureContext = {
      kind: 'pr-feedback',
      subjectId: 'octo/nuncio#7',
      projectPath: '/projects/nuncio',
    };
    queue.enqueue(
      s.id,
      'webhook feedback',
      undefined,
      'forge:github:pr-feedback',
      failureContext,
    );

    expect(queue.peekNext(s.id)).toMatchObject({
      message: 'webhook feedback',
      origin: 'forge:github:pr-feedback',
      failureContext,
    });
    queue.deleteForSession(s.id);
  });

  it('marks failure reporting only when the report transaction commits', () => {
    const s = sessions.create({ prompt: 'failure reporting transaction' });
    const rowId = queue.enqueue(s.id, 'webhook feedback');

    expect(() => queue.reportFailureOnce(rowId, () => {
      database.db
        .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
        .run('failure-report-test', 'rolled-back', Date.now());
      throw new Error('attention write failed');
    })).toThrow('attention write failed');
    expect(database.db.prepare('SELECT value FROM preferences WHERE key = ?')
      .get('failure-report-test')).toBeNull();

    expect(queue.reportFailureOnce(rowId, () => {
      database.db
        .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
        .run('failure-report-test', 'committed', Date.now());
    })).toBe(true);
    expect(queue.reportFailureOnce(rowId, () => {
      throw new Error('must not run twice');
    })).toBe(false);
    queue.deleteForSession(s.id);
    database.db.prepare('DELETE FROM preferences WHERE key = ?').run('failure-report-test');
  });

  it('claimAll hides rows from dequeue until released or deleted', () => {
    const s = sessions.create({ prompt: 'claim' });
    queue.enqueue(s.id, 'one');
    queue.enqueue(s.id, 'two');

    const claimed = queue.claimAll(s.id);
    expect(claimed.map((c) => c.message)).toEqual(['one', 'two']);
    // Claimed rows are invisible to the normal drain (no double delivery).
    expect(queue.dequeue(s.id)).toBeNull();
    // But still counted as present (durability), not lost.
    expect(queue.count(s.id)).toBe(2);

    // A second claim finds nothing already-claimed.
    expect(queue.claimAll(s.id)).toEqual([]);

    queue.releaseByIds(claimed.map((c) => c.id));
    expect(queue.dequeue(s.id)).toEqual({ message: 'one' });
    queue.deleteByIds([claimed[1]!.id]);
    expect(queue.count(s.id)).toBe(0);
  });

  it('claimAll excludes task-digest wakes (they are not user work items)', () => {
    const s = sessions.create({ prompt: 'fanout-skip' });
    queue.enqueue(s.id, 'user work');
    queue.enqueue(s.id, 'wake me', undefined, 'task-digest');

    const claimed = queue.claimAll(s.id);
    // Only the user steer is claimed; the wake stays queued for normal drain.
    expect(claimed.map((c) => c.message)).toEqual(['user work']);
    expect(queue.countByOrigin(s.id, 'task-digest')).toBe(1);
    // The wake is still drainable normally.
    queue.deleteByIds(claimed.map((c) => c.id));
    expect(queue.dequeue(s.id)?.message).toBe('wake me');
    queue.deleteForSession(s.id);
  });

  it('claimAll leaves forge background work for the session drain', () => {
    const s = sessions.create({ prompt: 'forge-fanout-skip' });
    queue.enqueue(s.id, 'user work');
    queue.enqueue(s.id, 'CI feedback', undefined, 'forge:github:ci-failure', {
      kind: 'pr-feedback',
    });

    const claimed = queue.claimAll(s.id);
    expect(claimed.map((entry) => entry.message)).toEqual(['user work']);
    queue.deleteByIds(claimed.map((entry) => entry.id));
    expect(queue.peekNext(s.id)).toMatchObject({
      message: 'CI feedback',
      origin: 'forge:github:ci-failure',
      failureContext: { kind: 'pr-feedback' },
    });
    queue.deleteForSession(s.id);
  });

  it('countByOrigin counts pending rows for the given origin', () => {
    const s = sessions.create({ prompt: 'origin-count' });
    queue.enqueue(s.id, 'a', undefined, 'task-digest');
    queue.enqueue(s.id, 'b', undefined, 'task-digest');
    queue.enqueue(s.id, 'c'); // no origin
    expect(queue.countByOrigin(s.id, 'task-digest')).toBe(2);
    queue.deleteForSession(s.id);
  });

  it('peekNext reads the oldest unclaimed row with its id without deleting; deleteById removes it', () => {
    const s = sessions.create({ prompt: 'peek' });
    queue.enqueue(s.id, 'first', undefined, 'task-digest');
    queue.enqueue(s.id, 'second');

    const peeked = queue.peekNext(s.id);
    expect(peeked?.message).toBe('first');
    expect(peeked?.origin).toBe('task-digest');
    expect(typeof peeked?.id).toBe('number');
    expect(queue.count(s.id)).toBe(2); // peek does not remove

    queue.deleteById(peeked!.id);
    expect(queue.peekNext(s.id)?.message).toBe('second');
    queue.deleteForSession(s.id);
  });

  it('claimAll leaves rows enqueued after the claim untouched', () => {
    const s = sessions.create({ prompt: 'claim-race' });
    queue.enqueue(s.id, 'early');
    const claimed = queue.claimAll(s.id);
    // A steer arriving after the claim is unclaimed and drains normally.
    queue.enqueue(s.id, 'late');
    expect(queue.dequeue(s.id)).toEqual({ message: 'late' });
    queue.deleteByIds(claimed.map((c) => c.id));
    expect(queue.count(s.id)).toBe(0);
  });

  it('releaseAllClaims frees every leased row', () => {
    const s = sessions.create({ prompt: 'boot-release' });
    queue.enqueue(s.id, 'stuck');
    queue.claimAll(s.id);
    expect(queue.dequeue(s.id)).toBeNull();

    queue.releaseAllClaims();
    expect(queue.dequeue(s.id)).toEqual({ message: 'stuck' });
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
