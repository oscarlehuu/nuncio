import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
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
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule, SettingsModule],
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
    // Purge lingering QUEUED/held tasks so the pump's wake timer cannot
    // resurrect one against a workspace we are about to delete.
    module.get(DatabaseService).db.exec("DELETE FROM tasks WHERE status = 'QUEUED'");
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

    const result = service.startMultitask({
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

    // Multitask subagents launch behind a hold window; start them immediately.
    for (const task of result.tasks) service.startNow(task.id);
    const done = await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
    expect(done.every((task) => task.role === 'subagent')).toBe(true);
    expect(done.every((task) => task.reviewState === 'awaiting_review')).toBe(true);
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

    const result = service.startMultitaskFromQueue(parent.id);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((task) => task.prompt)).toEqual(['audit the docs', 'add token tabs']);
    expect(result.tasks.every((task) => task.role === 'subagent')).toBe(true);
    // Draining the queue is what stops each prompt from also delivering
    // sequentially when the parent settles — otherwise it would run twice.
    expect(steerQueue.count(parent.id)).toBe(0);
    // Live clients are told to drop the queued placeholders.
    expect(events.list(parent.id).some((event) => event.type === 'steer_queue_cleared')).toBe(true);

    for (const task of result.tasks) service.startNow(task.id);
    await Promise.all(result.tasks.map((task) => waitForStatus(task.id, ['DONE', 'FAILED'])));
  });

  it('rejects multitask-from-queue when the parent queue is empty', async () => {
    const parent = await sessions.create({ prompt: 'lonely parent', provider: 'cursor', workspace });
    expect(() => service.startMultitaskFromQueue(parent.id)).toThrow(BadRequestException);
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

  it('claimNextQueued skips a held task and claims it once the hold passes', () => {
    const db = module.get(DatabaseService).db;
    db.exec('DELETE FROM tasks');
    const future = repo.create({ prompt: 'held', provider: 'cursor', holdUntil: Date.now() + 60_000 });
    expect(repo.claimNextQueued()).toBeNull();
    expect(repo.findById(future.id)?.status).toBe('QUEUED');

    const past = repo.create({ prompt: 'ready', provider: 'cursor', holdUntil: Date.now() - 1_000 });
    const claimed = repo.claimNextQueued();
    expect(claimed?.id).toBe(past.id);
    expect(claimed?.status).toBe('RUNNING');
    // This test drives the repo directly (no execute()); clear its orphan rows
    // so the RUNNING row cannot starve the concurrency=1 pump in later tests.
    db.exec('DELETE FROM tasks');
  });

  it('startMultitask holds each subagent for ~15s by default', async () => {
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const before = Date.now();
    const result = service.startMultitask({ parentSessionId: parent.id, prompts: ['a', 'b'] });
    for (const task of result.tasks) {
      expect(task.holdUntil).not.toBeNull();
      // Default 15s window, allowing for scheduling slack.
      expect(task.holdUntil! - before).toBeGreaterThanOrEqual(14_000);
      expect(task.holdUntil! - before).toBeLessThanOrEqual(16_000);
    }
    for (const task of result.tasks) service.startNow(task.id);
    await Promise.all(result.tasks.map((t) => waitForStatus(t.id, ['DONE', 'FAILED'])));
  });

  it('respects and clamps NUNCIO_MULTITASK_COUNTDOWN_SECONDS', async () => {
    const settings = module.get(SettingsService);
    const parent = await sessions.create({ prompt: 'countdown parent', provider: 'cursor', workspace });
    const cases: Array<[string, number]> = [
      ['2', 5],
      ['9999', 600],
      ['garbage', 15],
      ['45', 45],
    ];
    try {
      for (const [raw, expectedSeconds] of cases) {
        settings.set('NUNCIO_MULTITASK_COUNTDOWN_SECONDS', raw);
        const before = Date.now();
        const result = service.startMultitask({ parentSessionId: parent.id, prompts: ['x'] });
        const task = result.tasks[0]!;
        const windowSeconds = Math.round((task.holdUntil! - before) / 1000);
        expect(windowSeconds).toBe(expectedSeconds);
        service.cancel(task.id);
      }
    } finally {
      settings.clear('NUNCIO_MULTITASK_COUNTDOWN_SECONDS');
    }
  });

  it('update changes model/provider while queued and held', async () => {
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const [task] = service.startMultitask({ parentSessionId: parent.id, prompts: ['edit me'] }).tasks;
    const updated = service.update(task!.id, { provider: 'pi', model: 'pi:new-model' });
    expect(updated.provider).toBe('pi');
    expect(updated.model).toBe('pi:new-model');
    service.cancel(task!.id);
  });

  it('update re-arms the hold with holdSeconds', async () => {
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const [task] = service.startMultitask({ parentSessionId: parent.id, prompts: ['rearm'] }).tasks;
    const before = Date.now();
    const updated = service.update(task!.id, { holdSeconds: 120 });
    expect(Math.round((updated.holdUntil! - before) / 1000)).toBe(120);
    service.cancel(task!.id);
  });

  it('update rejects a non-queued task, a non-held re-arm, and an unknown id', async () => {
    const running = service.enqueue({ prompt: 'running', provider: 'cursor', workspace });
    await waitForStatus(running.id, ['DONE', 'FAILED']);
    expect(() => service.update(running.id, { model: 'x' })).toThrow(BadRequestException);

    const notHeld = repo.create({ prompt: 'no hold', provider: 'cursor' });
    expect(() => service.update(notHeld.id, { holdSeconds: 30 })).toThrow(BadRequestException);
    service.cancel(notHeld.id);

    expect(() => service.update('missing', { model: 'x' })).toThrow(NotFoundException);
  });

  it('update rejects a non-finite holdSeconds and leaves the task held', async () => {
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const [task] = service.startMultitask({ parentSessionId: parent.id, prompts: ['guard me'] }).tasks;
    const heldUntil = repo.findById(task!.id)!.holdUntil;
    expect(heldUntil).not.toBeNull();

    // `undefined` is a valid "leave the hold alone" and is not in this list.
    for (const bad of ['abc', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service.update(task!.id, { holdSeconds: bad as never })).toThrow(BadRequestException);
    }
    // The bad requests must not have un-held the task (NaN → SQLite NULL bug).
    expect(repo.findById(task!.id)?.holdUntil).toBe(heldUntil);
    expect(repo.findById(task!.id)?.status).toBe('QUEUED');

    // Non-string provider/model are rejected too.
    expect(() => service.update(task!.id, { provider: 123 as never })).toThrow(BadRequestException);
    expect(() => service.update(task!.id, { model: {} as never })).toThrow(BadRequestException);
    service.cancel(task!.id);
  });

  it('does not arm a wake timer for an already-expired hold at full concurrency', async () => {
    // Fill the single slot with a long-running task.
    writeVerifyScript('sleep 1.5\nexit 0\n');
    const blocker = service.enqueue({ prompt: 'blocker', provider: 'cursor', workspace });
    await waitForStatus(blocker.id, ['RUNNING']);

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    try {
      // An expired hold: claimable now, but no slot is free. Pre-fix this armed
      // setTimeout(0) → pump → setTimeout(0) … a busy-loop until the slot frees.
      const expired = service.enqueue({
        prompt: 'expired hold',
        provider: 'cursor',
        workspace,
        holdUntil: Date.now() - 1_000,
      });
      // Give any timer storm a chance to manifest.
      await new Promise((resolve) => setTimeout(resolve, 200));
      // A zero-delay busy-loop would fire pump→setTimeout(0) hundreds of times
      // in 200ms. Bounded count proves the storm is gone (unrelated one-shot
      // zero-delay timers may still occur, so assert "not a storm", not "zero").
      const zeroDelayTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 0).length;
      expect(zeroDelayTimers).toBeLessThan(10);
      expect(repo.findById(expired.id)?.status).toBe('QUEUED');
    } finally {
      setTimeoutSpy.mockRestore();
    }

    // Once the blocker finishes, the finally→pump claims the expired-held task.
    await waitForStatus(blocker.id, ['DONE', 'FAILED']);
  });

  it('startNow clears the hold so the pump claims the task; 400 when not held', async () => {
    const parent = await sessions.create({ prompt: 'parent', provider: 'cursor', workspace });
    const [task] = service.startMultitask({ parentSessionId: parent.id, prompts: ['start me'] }).tasks;
    expect(repo.findById(task!.id)?.status).toBe('QUEUED');

    const cleared = service.startNow(task!.id);
    expect(cleared.holdUntil).toBeNull();
    await waitForStatus(task!.id, ['RUNNING', 'DONE', 'FAILED']);

    // A queued-but-unheld task cannot be "started now".
    const unheld = repo.create({ prompt: 'unheld', provider: 'cursor' });
    expect(() => service.startNow(unheld.id)).toThrow(BadRequestException);
    service.cancel(unheld.id);
  });

  it('pump wake timer promotes a held task to RUNNING without any extra API call', async () => {
    // Short hold: the wake timer, armed by the previous pump, must fire on its own.
    const held = service.enqueue({
      prompt: 'wake me',
      provider: 'cursor',
      workspace,
      holdUntil: Date.now() + 150,
    });
    expect(repo.findById(held.id)?.status).toBe('QUEUED');
    // No startNow / manual pump — only the timer moves it.
    const run = await waitForStatus(held.id, ['RUNNING', 'DONE', 'FAILED']);
    expect(['RUNNING', 'DONE', 'FAILED']).toContain(run.status);
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
