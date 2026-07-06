import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SteerQueueRepository } from '../../../src/sessions/persistence/steer-queue.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';
import type { TaskDto, TaskStatus } from '../../../src/tasks/tasks.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('TasksService', () => {
  let module: TestingModule;
  let service: TasksService;
  let sessions: SessionsService;
  let repo: TasksRepository;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;

  async function buildModule(): Promise<TestingModule> {
    return withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService, TasksRepository, TasksService],
      }),
    ).compile();
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-tasks-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await buildModule();
    service = module.get(TasksService);
    sessions = module.get(SessionsService);
    repo = module.get(TasksRepository);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-tasks-ws-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function writeVerifyScript(body: string): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), body);
  }

  async function waitForStatus(
    id: string,
    statuses: TaskStatus[],
    timeoutMs = 8000,
  ): Promise<TaskDto> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = repo.findById(id);
      if (task && statuses.includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`task ${id} did not reach ${statuses.join('/')} in time`);
  }

  it('runs an enqueued task to DONE with the verify outcome recorded', async () => {
    writeVerifyScript('echo task-ok\nexit 0\n');
    const task = service.enqueue({ prompt: 'do the thing', provider: 'cursor', workspace });
    expect(task.status).toBe('QUEUED');

    const done = await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(done.status).toBe('DONE');
    expect(done.sessionId).toBeTruthy();
    expect(done.outcome).toMatchObject({ sessionStatus: 'IDLE', verify: { ok: true } });
    expect(events.list(done.sessionId!).some((e) => e.type === 'user_message')).toBe(true);
  });

  it('runs tasks one at a time: the second stays QUEUED while the first runs', async () => {
    writeVerifyScript('sleep 0.5\nexit 0\n');
    const first = service.enqueue({ prompt: 'slow first', provider: 'cursor', workspace });
    const second = service.enqueue({ prompt: 'second waits', provider: 'cursor', workspace });

    await waitForStatus(first.id, ['RUNNING']);
    expect(repo.findById(second.id)?.status).toBe('QUEUED');

    const firstDone = await waitForStatus(first.id, ['DONE', 'FAILED']);
    const secondDone = await waitForStatus(second.id, ['DONE', 'FAILED']);
    expect(firstDone.status).toBe('DONE');
    expect(secondDone.status).toBe('DONE');
  });

  it('marks the task FAILED when the session cannot be created', async () => {
    const task = service.enqueue({ prompt: 'bad provider', provider: 'no-such-provider' });
    const failed = await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(failed.status).toBe('FAILED');
    expect(typeof failed.outcome?.error).toBe('string');
  });

  it('cancel removes a queued task from the runway', async () => {
    writeVerifyScript('sleep 0.5\nexit 0\n');
    const blocker = service.enqueue({ prompt: 'blocker', provider: 'cursor', workspace });
    const victim = service.enqueue({ prompt: 'cancel me', provider: 'cursor', workspace });

    await waitForStatus(blocker.id, ['RUNNING']);
    const cancelled = service.cancel(victim.id);
    expect(cancelled.status).toBe('CANCELLED');

    await waitForStatus(blocker.id, ['DONE', 'FAILED']);
    // Give the pump a beat: the cancelled task must never start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(repo.findById(victim.id)?.status).toBe('CANCELLED');
    expect(repo.findById(victim.id)?.sessionId).toBeNull();
  });

  it('cancel rejects tasks that already run', async () => {
    const task = service.enqueue({ prompt: 'too late', provider: 'cursor', workspace });
    await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(() => service.cancel(task.id)).toThrow(BadRequestException);
  });

  it('retry clones a terminal task into a fresh queued run', async () => {
    const task = service.enqueue({ prompt: 'retry me', provider: 'no-such-provider' });
    await waitForStatus(task.id, ['FAILED']);

    const clone = service.retry(task.id);
    expect(clone.id).not.toBe(task.id);
    expect(clone.prompt).toBe('retry me');
    const cloneDone = await waitForStatus(clone.id, ['DONE', 'FAILED']);
    expect(cloneDone.status).toBe('FAILED');
  });

  it('starts multitasking by creating provider-neutral child subagent tasks for a parent session', async () => {
    writeVerifyScript('exit 0\n');
    const parent = await sessions.create({
      prompt: 'parent task',
      provider: 'cursor',
      model: 'cursor:test-model',
      workspace,
    });

    const result = await service.startMultitask({
      parentSessionId: parent.id,
      prompts: ['write tests', 'update docs'],
    });

    expect(result.parentSessionId).toBe(parent.id);
    expect(result.tasks).toHaveLength(2);
    for (const task of result.tasks) {
      expect(task.role).toBe('subagent');
      expect(task.parentSessionId).toBe(parent.id);
      expect(task.provider).toBe('cursor');
      expect(task.model).toBe('cursor:test-model');
      expect(task.workspace).toBe(workspace);
      expect(task.cleanupPolicy).toBe('after-review');
    }

    expect(service.list(parent.id).map((task) => task.prompt)).toEqual([
      'update docs',
      'write tests',
    ]);

    const done = await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
    expect(done.every((task) => task.role === 'subagent')).toBe(true);
    expect(done.every((task) => task.reviewState === 'awaiting_review')).toBe(true);
  });

  it('attaches an assembled brief to each subagent with the parent objective and touched files', async () => {
    writeVerifyScript('exit 0\n');
    const parent = await sessions.create({
      prompt: 'Refactor the payment flow',
      provider: 'cursor',
      workspace,
    });
    // Simulate the parent touching a file so the assembler can harvest it.
    // A repo-relative path is kept regardless of the (unset) project root.
    events.append(parent.id, 'tool_start', {
      tool: 'Edit',
      input: { file_path: 'src/pay.ts' },
    });

    const result = await service.startMultitask({
      parentSessionId: parent.id,
      prompts: ['write payment tests'],
    });

    const brief = repo.findById(result.tasks[0]!.id)?.contextBrief;
    expect(brief?.goal).toBe('write payment tests');
    expect(brief?.decisions).toContain('Parent objective: Refactor the payment flow');
    expect(brief?.files).toContain('src/pay.ts');
    expect(brief?.sourceSessionId).toBe(parent.id);

    await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
  });

  it('honors an explicit contextBrief override on multitask', async () => {
    writeVerifyScript('exit 0\n');
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const result = await service.startMultitask({
      parentSessionId: parent.id,
      prompts: ['child work'],
      contextBrief: { goal: 'explicit goal wins' },
    });
    const brief = repo.findById(result.tasks[0]!.id)?.contextBrief;
    expect(brief?.goal).toBe('explicit goal wins');
    expect(brief?.decisions).toBeUndefined();
    await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
  });

  it('fans the parent steer queue out to subagents and drains it', async () => {
    writeVerifyScript('exit 0\n');
    const parent = await sessions.create({
      prompt: 'parent task',
      provider: 'cursor',
      model: 'cursor:test-model',
      workspace,
    });
    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'audit the docs');
    steerQueue.enqueue(parent.id, 'add token tabs');

    const result = await service.startMultitaskFromQueue(parent.id);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((task) => task.prompt)).toEqual(['audit the docs', 'add token tabs']);
    expect(result.tasks.every((task) => task.role === 'subagent')).toBe(true);
    // Draining the queue is what stops each prompt from also delivering
    // sequentially when the parent settles — otherwise it would run twice.
    expect(steerQueue.count(parent.id)).toBe(0);
    // Live clients are told to drop the queued placeholders.
    expect(events.list(parent.id).some((event) => event.type === 'steer_queue_cleared')).toBe(true);

    await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
  });

  it('rejects multitask-from-queue when the parent queue is empty', async () => {
    const parent = await sessions.create({ prompt: 'lonely parent', provider: 'cursor', workspace });
    await expect(service.startMultitaskFromQueue(parent.id)).rejects.toThrow(BadRequestException);
    // Nothing was emitted for an empty drain.
    expect(events.list(parent.id).some((event) => event.type === 'steer_queue_cleared')).toBe(false);
  });

  it('rolls back all child inserts and keeps queue rows when one insert fails mid-batch', async () => {
    const parent = await sessions.create({ prompt: 'durable parent', provider: 'cursor', workspace });
    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'steer 1');
    steerQueue.enqueue(parent.id, 'steer 2');
    steerQueue.enqueue(parent.id, 'steer 3');
    expect(steerQueue.count(parent.id)).toBe(3);

    // Fail the 2nd of 3 inserts — the transaction must roll back child 1 too.
    let calls = 0;
    const realCreate = repo.create.bind(repo);
    const spy = jest.spyOn(repo, 'create').mockImplementation((input) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated insert failure');
      return realCreate(input);
    });
    try {
      await expect(service.startMultitaskFromQueue(parent.id)).rejects.toThrow('simulated insert failure');
    } finally {
      spy.mockRestore();
    }

    // Zero child tasks survived the rollback.
    expect(service.list(parent.id)).toHaveLength(0);
    // All queue rows present and released (drainable again).
    expect(steerQueue.count(parent.id)).toBe(3);
    expect(events.list(parent.id).some((e) => e.type === 'steer_queue_cleared')).toBe(false);

    // Recovery: a real fan-out now drains the still-present queue.
    const result = await service.startMultitaskFromQueue(parent.id);
    expect(result.tasks).toHaveLength(3);
    expect(steerQueue.count(parent.id)).toBe(0);
    await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
  });

  it('does not double-deliver when the parent settle-drain fires during assembly', async () => {
    const parent = await sessions.create({ prompt: 'racing parent', provider: 'cursor', workspace });
    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'only message');

    // Hold assembly open so a concurrent settle-drain can race the claimed row.
    let releaseAssembly: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAssembly = resolve;
    });
    const assembleSpy = jest
      .spyOn(service as unknown as { assembleParentBrief: (p: unknown) => Promise<unknown> }, 'assembleParentBrief')
      .mockImplementation(async () => {
        await gate;
        return { goal: 'placeholder' };
      });

    try {
      const fanOut = service.startMultitaskFromQueue(parent.id);
      // Simulate the parent run settling mid-assembly: the normal drain must
      // find nothing, because the row is claimed.
      const drainedNow = steerQueue.dequeue(parent.id);
      expect(drainedNow).toBeNull();

      releaseAssembly();
      const result = await fanOut;
      // Exactly one task per message — no double delivery.
      expect(result.tasks).toHaveLength(1);
      expect(steerQueue.count(parent.id)).toBe(0);
      await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
    } finally {
      assembleSpy.mockRestore();
    }
  });

  it('releases the claim when brief assembly fails, so a normal drain delivers the messages', async () => {
    const parent = await sessions.create({ prompt: 'assembly-fail parent', provider: 'cursor', workspace });
    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'msg a');
    steerQueue.enqueue(parent.id, 'msg b');

    const assembleSpy = jest
      .spyOn(service as unknown as { assembleParentBrief: (p: unknown) => Promise<unknown> }, 'assembleParentBrief')
      .mockRejectedValue(new Error('assembly boom'));
    try {
      await expect(service.startMultitaskFromQueue(parent.id)).rejects.toThrow('assembly boom');
    } finally {
      assembleSpy.mockRestore();
    }

    // Rows survive and are unclaimed — the normal settle-drain can deliver them.
    expect(steerQueue.count(parent.id)).toBe(2);
    expect(steerQueue.dequeue(parent.id)?.message).toBe('msg a');
    expect(steerQueue.dequeue(parent.id)?.message).toBe('msg b');
  });

  it('auto-delivers freed messages when assembly fails after the parent already drained empty', async () => {
    writeVerifyScript('exit 0\n');
    const parent = await sessions.create({ prompt: 'stall parent', provider: 'cursor', workspace });
    // Wait for the parent's own run to settle to IDLE so a drain is meaningful.
    const start = Date.now();
    while (sessions.get(parent.id)?.status !== 'IDLE' && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sessions.get(parent.id)?.status).toBe('IDLE');

    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'stranded message');

    // Assembly fails; while it was in flight the row was claimed, so a parent
    // settle-drain firing now would find nothing. Nothing external re-triggers.
    const assembleSpy = jest
      .spyOn(service as unknown as { assembleParentBrief: (p: unknown) => Promise<unknown> }, 'assembleParentBrief')
      .mockImplementation(async () => {
        // Emulate the parent's own settle-drain racing the claimed row: it sees
        // nothing (claimed) and returns, so only the release path can recover.
        expect(steerQueue.dequeue(parent.id)).toBeNull();
        throw new Error('assembly boom');
      });

    try {
      await expect(service.startMultitaskFromQueue(parent.id)).rejects.toThrow('assembly boom');
    } finally {
      assembleSpy.mockRestore();
    }

    // WITHOUT any manual drain, the freed message must be delivered: the
    // scheduled settle-drain empties the queue on its own.
    const deadline = Date.now() + 4000;
    while (steerQueue.count(parent.id) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(steerQueue.count(parent.id)).toBe(0);
  });

  it('boot: stale steer-queue claims are released so the rows drain again', async () => {
    const parent = await sessions.create({ prompt: 'boot parent', provider: 'cursor', workspace });
    const steerQueue = module.get(SteerQueueRepository);
    steerQueue.enqueue(parent.id, 'orphaned by crash');
    // Lease the row and never release it — simulating a crash mid-fan-out.
    const claimed = steerQueue.claimAll(parent.id);
    expect(claimed).toHaveLength(1);
    expect(steerQueue.dequeue(parent.id)).toBeNull(); // claimed → invisible

    // A fresh service boot must release the stale claim.
    const rebooted = await buildModule();
    try {
      const rebootedQueue = rebooted.get(SteerQueueRepository);
      expect(rebootedQueue.dequeue(parent.id)?.message).toBe('orphaned by crash');
    } finally {
      await rebooted.close();
    }
  });

  it('marks a terminal subagent task reviewed', async () => {
    const task = repo.create({ prompt: 'review me', role: 'subagent', parentSessionId: 'parent123' });
    repo.claimNextQueued();
    repo.finish(task.id, 'DONE', { sessionStatus: 'IDLE' });

    const reviewed = service.markReviewed(task.id);
    expect(reviewed.reviewState).toBe('reviewed');
  });

  it('flags a running task whose session waits on user input', async () => {
    writeVerifyScript('sleep 0.6\nexit 0\n');
    const task = service.enqueue({ prompt: 'needs input', provider: 'cursor', workspace });
    const running = await waitForStatus(task.id, ['RUNNING']);

    const start = Date.now();
    while (!repo.findById(task.id)?.sessionId && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const sessionId = repo.findById(task.id)!.sessionId!;
    events.append(sessionId, 'user_input_requested', { requestId: 'q1', questions: [] });

    const listed = service.list().find((t) => t.id === running.id);
    expect(listed?.pendingInput).toBe(true);

    events.append(sessionId, 'user_input_resolved', { requestId: 'q1', resolvedBy: 'user' });
    const after = service.list().find((t) => t.id === running.id);
    expect(after?.pendingInput).toBe(false);
    await waitForStatus(task.id, ['DONE', 'FAILED']);
  });

  it('prepends a rendered handoff brief to the child session prompt', async () => {
    writeVerifyScript('exit 0\n');
    const task = service.enqueue({
      prompt: 'implement the feature',
      provider: 'cursor',
      workspace,
      contextBrief: { goal: 'Ship the feature safely', constraints: ['No new deps'] },
    });

    const done = await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(done.status).toBe('DONE');
    // The DB prompt stays pure — the brief lives only in the session.
    expect(repo.findById(task.id)?.prompt).toBe('implement the feature');

    const userMessages = events
      .list(done.sessionId!)
      .filter((e) => e.type === 'user_message');
    const first = userMessages[0]?.payload as { text?: string; content?: string };
    const text = first.text ?? first.content ?? JSON.stringify(first);
    expect(text.startsWith('## Handoff brief')).toBe(true);
    expect(text).toContain('Ship the feature safely');
    expect(text.trimEnd().endsWith('implement the feature')).toBe(true);
  });

  it('leaves the session prompt untouched when no brief is attached', async () => {
    writeVerifyScript('exit 0\n');
    const task = service.enqueue({ prompt: 'plain prompt', provider: 'cursor', workspace });
    const done = await waitForStatus(task.id, ['DONE', 'FAILED']);
    const userMessages = events.list(done.sessionId!).filter((e) => e.type === 'user_message');
    const first = userMessages[0]?.payload as { text?: string; content?: string };
    const text = first.text ?? first.content ?? '';
    expect(text).not.toContain('## Handoff brief');
    expect(text).toContain('plain prompt');
  });

  it('round-trips a brief and lists contextBrief null for a corrupt context_json row', () => {
    const withBrief = repo.create({
      prompt: 'has a brief',
      contextBrief: { goal: 'do it', decisions: ['keep it simple'] },
    });
    expect(repo.findById(withBrief.id)?.contextBrief).toMatchObject({ goal: 'do it' });

    const corrupt = repo.create({ prompt: 'corrupt brief' });
    module
      .get(DatabaseService)
      .db.prepare('UPDATE tasks SET context_json = ? WHERE id = ?')
      .run('{not json', corrupt.id);
    const listed = service.list().find((t) => t.id === corrupt.id);
    expect(listed).toBeTruthy();
    expect(listed?.contextBrief).toBeNull();
  });

  it('retry carries the handoff brief forward', async () => {
    const task = service.enqueue({
      prompt: 'retry with brief',
      provider: 'no-such-provider',
      contextBrief: { goal: 'preserve me across retry' },
    });
    await waitForStatus(task.id, ['FAILED']);

    const clone = service.retry(task.id);
    expect(clone.contextBrief).toMatchObject({ goal: 'preserve me across retry' });
    await waitForStatus(clone.id, ['DONE', 'FAILED']);
  });

  it('boot: interrupted RUNNING tasks fail with daemon_restart and QUEUED tasks resume', async () => {
    const stuck = repo.create({ prompt: 'was running' });
    repo.claimNextQueued();
    expect(repo.findById(stuck.id)?.status).toBe('RUNNING');
    const queued = repo.create({ prompt: 'still queued', provider: 'cursor', workspace });

    const restarted = await buildModule();
    try {
      restarted.get(TasksService);
      expect(repo.findById(stuck.id)?.status).toBe('FAILED');
      expect(repo.findById(stuck.id)?.outcome).toMatchObject({ reason: 'daemon_restart' });

      const restartedRepo = restarted.get(TasksRepository);
      const start = Date.now();
      let resumed = restartedRepo.findById(queued.id);
      while (resumed && !['DONE', 'FAILED'].includes(resumed.status) && Date.now() - start < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        resumed = restartedRepo.findById(queued.id);
      }
      expect(resumed?.status).toBe('DONE');
    } finally {
      await restarted.close();
    }
  });

  async function waitForEventType(
    sessionId: string,
    type: string,
    timeoutMs = 8000,
  ): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = events.list(sessionId).find((e) => e.type === type);
      if (hit) return hit.payload as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`event ${type} not appended to ${sessionId} in time`);
  }

  describe('task_completed digest', () => {
    it('appends exactly one task_completed to the parent when a subagent finishes', async () => {
      writeVerifyScript('echo verify-ok\nexit 0\n');
      const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
      const child = service.enqueue({
        prompt: 'do subagent work',
        provider: 'cursor',
        workspace,
        role: 'subagent',
        parentSessionId: parent.id,
      });
      const done = await waitForStatus(child.id, ['DONE', 'FAILED']);
      expect(done.status).toBe('DONE');

      const payload = await waitForEventType(parent.id, 'task_completed');
      const digests = events.list(parent.id).filter((e) => e.type === 'task_completed');
      expect(digests).toHaveLength(1);
      expect(payload.taskId).toBe(child.id);
      expect(payload.status).toBe('DONE');
      expect(payload.childSessionId).toBe(done.sessionId);
      // seq ordering: the digest is the last event and monotonically after prior ones.
      const all = events.list(parent.id);
      expect(all[all.length - 1]!.type).toBe('task_completed');
    });

    it('stamps the child session with its parent and originating task', async () => {
      writeVerifyScript('exit 0\n');
      const parent = await sessions.create({ prompt: 'lineage parent', provider: 'cursor', workspace });
      const child = service.enqueue({
        prompt: 'lineage child',
        provider: 'cursor',
        workspace,
        role: 'subagent',
        parentSessionId: parent.id,
      });
      const done = await waitForStatus(child.id, ['DONE', 'FAILED']);
      const childSession = sessions.get(done.sessionId!);
      expect(childSession?.parentSessionId).toBe(parent.id);
      expect(childSession?.originTaskId).toBe(child.id);
    });

    it('does not append a digest for a standalone task with no parent', async () => {
      writeVerifyScript('exit 0\n');
      const task = service.enqueue({ prompt: 'standalone', provider: 'cursor', workspace });
      const done = await waitForStatus(task.id, ['DONE', 'FAILED']);
      // Its own child session has no task_completed (it has no parent to notify).
      expect(events.list(done.sessionId!).some((e) => e.type === 'task_completed')).toBe(false);
    });

    it('does not throw when the parent session was deleted before the child finished', async () => {
      writeVerifyScript('sleep 0.3\nexit 0\n');
      const parent = await sessions.create({ prompt: 'doomed parent', provider: 'cursor', workspace });
      const child = service.enqueue({
        prompt: 'orphan me',
        provider: 'cursor',
        workspace,
        role: 'subagent',
        parentSessionId: parent.id,
      });
      await waitForStatus(child.id, ['RUNNING']);
      // Hard-delete the parent row (bypassing the archive-first API guard) so
      // the digest append hits a vanished parent.
      module.get(SessionsRepository).delete(parent.id);
      // Must still finish cleanly — the digest append silently no-ops.
      const done = await waitForStatus(child.id, ['DONE', 'FAILED']);
      expect(['DONE', 'FAILED']).toContain(done.status);
    });

    it('a digest BUILD failure finishes the task DONE with no digest and no throw', async () => {
      writeVerifyScript('exit 0\n');
      const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
      // Fail only the digest build step; the task must still finish DONE.
      const buildSpy = jest
        .spyOn(service as unknown as { buildTaskDigest: () => Promise<null> }, 'buildTaskDigest')
        .mockResolvedValue(null);
      try {
        const child = service.enqueue({
          prompt: 'work',
          provider: 'cursor',
          workspace,
          role: 'subagent',
          parentSessionId: parent.id,
        });
        const done = await waitForStatus(child.id, ['DONE', 'FAILED']);
        expect(done.status).toBe('DONE');
      } finally {
        buildSpy.mockRestore();
      }
      // No digest reached the parent, but the loop stayed healthy.
      expect(events.list(parent.id).some((e) => e.type === 'task_completed')).toBe(false);
    });

    it('a finish+digest transaction failure leaves the task unfinished (both-or-neither)', async () => {
      writeVerifyScript('exit 0\n');
      const parent = await sessions.create({ prompt: 'txn parent', provider: 'cursor', workspace });
      // Force the digest persist (inside the finish transaction) to throw, so the
      // transaction rolls back and the task's finish is undone.
      const persistSpy = jest
        .spyOn(sessions, 'persistOrchestrationEvent')
        .mockImplementation(() => {
          throw new Error('persist boom');
        });
      try {
        const child = service.enqueue({
          prompt: 'atomic work',
          provider: 'cursor',
          workspace,
          role: 'subagent',
          parentSessionId: parent.id,
        });
        await waitForStatus(child.id, ['RUNNING']);
        // Give execute time to reach (and roll back) the finalize transaction.
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Both-or-neither: finish rolled back → task NOT terminal, and no digest.
        expect(repo.findById(child.id)?.status).toBe('RUNNING');
        expect(events.list(parent.id).some((e) => e.type === 'task_completed')).toBe(false);
        // Clean up the deliberately-stuck RUNNING task so it does not occupy the
        // single concurrency slot for later tests (mirrors boot reconciliation).
        repo.finish(child.id, 'FAILED', { reason: 'test_cleanup' });
      } finally {
        persistSpy.mockRestore();
      }
      // The stuck task is exactly the RUNNING-at-boot case that failInterrupted
      // reconciles into a FAILED task + FAILED digest (covered by the boot test).
    });

    it('does not disturb a RUNNING parent FSM when appending a digest', async () => {
      writeVerifyScript('exit 0\n');
      const parent = await sessions.create({ prompt: 'busy parent', provider: 'cursor', workspace });
      // Let the parent's own run settle, then drive it back to RUNNING so the
      // annotate-don't-block contract is under test: a digest append must not
      // move it out of RUNNING.
      const startWait = Date.now();
      while (sessions.get(parent.id)?.status !== 'IDLE' && Date.now() - startWait < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const parentRow = module.get(SessionsRepository);
      parentRow.updateStatus(parent.id, 'RUNNING');

      const finished = repo.create({
        prompt: 'finished child',
        role: 'subagent',
        parentSessionId: parent.id,
      });
      repo.claimNextQueued();
      repo.finish(finished.id, 'DONE', { sessionStatus: 'IDLE' });
      // Append directly through the same path execute uses.
      sessions.appendOrchestrationEvent(parent.id, 'task_completed', {
        taskId: finished.id,
        childSessionId: null,
        status: 'DONE',
        outcomeSummary: null,
        verify: null,
        workspace: null,
        childBranch: null,
      });

      expect(sessions.get(parent.id)?.status).toBe('RUNNING');
      expect(events.list(parent.id).some((e) => e.type === 'task_completed')).toBe(true);
    });

    it('emits a CANCELLED digest with a null summary for a cancelled subagent', async () => {
      writeVerifyScript('sleep 0.5\nexit 0\n');
      const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
      const blocker = service.enqueue({ prompt: 'blocker', provider: 'cursor', workspace });
      const victim = service.enqueue({
        prompt: 'cancel me',
        provider: 'cursor',
        workspace,
        role: 'subagent',
        parentSessionId: parent.id,
      });
      await waitForStatus(blocker.id, ['RUNNING']);
      service.cancel(victim.id);

      const payload = await waitForEventType(parent.id, 'task_completed');
      expect(payload.taskId).toBe(victim.id);
      expect(payload.status).toBe('CANCELLED');
      expect(payload.outcomeSummary).toBeNull();
      await waitForStatus(blocker.id, ['DONE', 'FAILED']);
    });

    it('boot: interrupted RUNNING subagents append a FAILED digest to their parent', async () => {
      const parent = await sessions.create({ prompt: 'restart parent', provider: 'cursor', workspace });
      const stuck = repo.create({
        prompt: 'was running',
        role: 'subagent',
        parentSessionId: parent.id,
      });
      repo.claimNextQueued();
      expect(repo.findById(stuck.id)?.status).toBe('RUNNING');

      const restarted = await buildModule();
      try {
        restarted.get(TasksService);
        const payload = await waitForEventType(parent.id, 'task_completed');
        expect(payload.taskId).toBe(stuck.id);
        expect(payload.status).toBe('FAILED');
      } finally {
        await restarted.close();
      }
    });
  });
});
