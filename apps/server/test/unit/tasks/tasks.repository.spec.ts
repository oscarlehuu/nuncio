import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';

describe('TasksRepository', () => {
  let module: TestingModule;
  let tasks: TasksRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-tasks-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [TasksRepository],
    }).compile();

    tasks = module.get(TasksRepository);
  });

  beforeEach(() => {
    module.get(DatabaseService).db.exec('DELETE FROM tasks');
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates a queued task with defaults and round-trips fields', () => {
    const task = tasks.create({
      prompt: 'Fix the flaky spec',
      provider: 'pi',
      model: 'pi:some-model',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });

    expect(task.status).toBe('QUEUED');
    expect(task.useWorktree).toBe(true);
    expect(task.sessionId).toBeNull();
    expect(task.outcome).toBeNull();

    const found = tasks.findById(task.id);
    expect(found).toMatchObject({
      prompt: 'Fix the flaky spec',
      provider: 'pi',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });
  });

  it('creates subagent tasks linked to a parent session', () => {
    const task = tasks.create({
      prompt: 'write tests',
      provider: 'codex',
      parentSessionId: 'parent123',
      role: 'subagent',
      cleanupPolicy: 'after-review',
    });

    expect(task.role).toBe('subagent');
    expect(task.parentSessionId).toBe('parent123');
    expect(task.cleanupPolicy).toBe('after-review');
    expect(task.reviewState).toBeNull();

    expect(tasks.listByParentSession('parent123').map((child) => child.id)).toEqual([task.id]);
  });

  it('claims queued tasks in FIFO order and marks them RUNNING', () => {
    const first = tasks.create({ prompt: 'first' });
    const second = tasks.create({ prompt: 'second' });

    const claimedA = tasks.claimNextQueued();
    expect(claimedA?.id).toBe(first.id);
    expect(claimedA?.status).toBe('RUNNING');
    expect(claimedA?.startedAt).not.toBeNull();

    const claimedB = tasks.claimNextQueued();
    expect(claimedB?.id).toBe(second.id);

    expect(tasks.claimNextQueued()).toBeNull();
  });

  it('records the linked session and the outcome on finish', () => {
    const task = tasks.create({ prompt: 'outcome test' });
    tasks.claimNextQueued();
    tasks.attachSession(task.id, 'sess1234');
    const finished = tasks.finish(task.id, 'DONE', {
      sessionStatus: 'IDLE',
      verify: { ok: true, exitCode: 0 },
    });

    expect(finished?.status).toBe('DONE');
    expect(finished?.sessionId).toBe('sess1234');
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.outcome).toMatchObject({ sessionStatus: 'IDLE', verify: { ok: true } });
  });

  it('marks finished subagent tasks as awaiting review', () => {
    const task = tasks.create({ prompt: 'subtask', role: 'subagent', parentSessionId: 'parent123' });
    tasks.claimNextQueued();
    const finished = tasks.finish(task.id, 'DONE', { sessionStatus: 'IDLE' });

    expect(finished?.status).toBe('DONE');
    expect(finished?.reviewState).toBe('awaiting_review');

    const reviewed = tasks.markReviewed(task.id);
    expect(reviewed?.reviewState).toBe('reviewed');
  });

  it('cancel only applies to queued tasks', () => {
    const queued = tasks.create({ prompt: 'cancel me' });
    expect(tasks.cancel(queued.id)?.status).toBe('CANCELLED');

    const running = tasks.create({ prompt: 'already running' });
    tasks.claimNextQueued();
    expect(tasks.cancel(running.id)).toBeNull();
  });

  it('countRunning reflects claims and finishes', () => {
    const before = tasks.countRunning();
    const task = tasks.create({ prompt: 'count me' });
    tasks.claimNextQueued();
    expect(tasks.countRunning()).toBe(before + 1);
    tasks.finish(task.id, 'FAILED', { reason: 'boom' });
    expect(tasks.countRunning()).toBe(before);
  });

  it('failInterrupted marks every RUNNING task failed with a reason', () => {
    const task = tasks.create({ prompt: 'interrupted' });
    tasks.claimNextQueued();
    const subagent = tasks.create({
      prompt: 'interrupted subagent',
      role: 'subagent',
      parentSessionId: 'parent123',
    });
    tasks.claimNextQueued();

    const failed = tasks.failInterrupted('daemon_restart');
    const ids = failed.map((t) => t.id);
    expect(ids).toContain(task.id);
    expect(ids).toContain(subagent.id);
    expect(tasks.findById(task.id)?.status).toBe('FAILED');
    expect(tasks.findById(task.id)?.outcome).toMatchObject({ reason: 'daemon_restart' });
    expect(tasks.findById(subagent.id)?.status).toBe('FAILED');
    expect(tasks.findById(subagent.id)?.reviewState).toBe('awaiting_review');
    expect(tasks.countRunning()).toBe(0);
  });

  it('delete removes only terminal tasks', () => {
    const queued = tasks.create({ prompt: 'not deletable' });
    expect(tasks.delete(queued.id)).toBe(false);
    tasks.cancel(queued.id);
    expect(tasks.delete(queued.id)).toBe(true);
    expect(tasks.findById(queued.id)).toBeNull();
  });

  it('list returns newest first', () => {
    const a = tasks.create({ prompt: 'older' });
    const b = tasks.create({ prompt: 'newer' });
    const listed = tasks.list();
    expect(listed.findIndex((t) => t.id === b.id)).toBeLessThan(
      listed.findIndex((t) => t.id === a.id),
    );
  });
});
