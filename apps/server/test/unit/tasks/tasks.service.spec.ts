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
});
