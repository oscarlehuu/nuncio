import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { TasksService } from '../../../src/tasks/tasks.service';
import { LoopsRepository } from '../../../src/loops/loops.repository';
import { LoopsService } from '../../../src/loops/loops.service';
import type { CreateLoopDto } from '../../../src/loops/loops.types';

/**
 * The loop primitive integration — deterministic via the injected clock. Spy
 * scheduler + tasks record the loop↔schedule lifecycle and enqueues without the
 * real timer/runner.
 */

class SpyScheduler {
  readonly created: Array<{ id: string; kind: string; target: unknown }> = [];
  readonly enabledCalls: Array<{ id: string; enabled: boolean }> = [];
  readonly deleted: string[] = [];
  private readonly rows = new Map<string, { kind: string; spec: string; nextFireAt: number | null }>();
  private n = 0;
  create(input: { kind: string; spec: string; target: unknown }) {
    this.n += 1;
    const id = `sched-${this.n}`;
    this.created.push({ id, kind: input.kind, target: input.target });
    this.rows.set(id, { kind: input.kind, spec: input.spec, nextFireAt: 1_800_000 });
    return { id };
  }
  setEnabled(id: string, enabled: boolean) {
    this.enabledCalls.push({ id, enabled });
    return { id, enabled };
  }
  deleteSchedule(id: string) {
    this.deleted.push(id);
    this.rows.delete(id);
  }
  getSchedule(id: string) {
    const row = this.rows.get(id);
    return row ? { id, kind: row.kind, spec: row.spec, nextFireAt: row.nextFireAt } : null;
  }
  setLoopFireHandler(_fn: (loopId: string) => unknown) {
    void _fn;
  }
}

interface FakeTask {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  outcome?: Record<string, unknown>;
}

class SpyTasks {
  readonly enqueued: Array<{ prompt: string; useWorktree?: boolean; projectPath?: string }> = [];
  private readonly tasks = new Map<string, FakeTask>();
  private readonly handlers = new Set<(t: FakeTask) => void>();
  private n = 0;

  enqueue(input: { prompt: string; useWorktree?: boolean; projectPath?: string }) {
    this.n += 1;
    const id = `task-${this.n}`;
    this.enqueued.push(input);
    this.tasks.set(id, { id, status: 'RUNNING' });
    return { id };
  }

  /** Set a task to a non-terminal state (simulate a QUEUED/RUNNING task at boot). */
  setStatus(id: string, status: FakeTask['status']): void {
    const t = this.tasks.get(id);
    if (t) t.status = status;
  }

  /** Remove a task entirely (simulate its row vanishing across a crash). */
  vanish(id: string): void {
    this.tasks.delete(id);
  }

  onTaskFinished(handler: (t: FakeTask) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  findById(id: string): FakeTask | null {
    return this.tasks.get(id) ?? null;
  }

  /** Simulate a task settling on a terminal path and firing the settlement hook. */
  settle(id: string, status: 'DONE' | 'FAILED', outcome?: Record<string, unknown>): void {
    const t: FakeTask = { id, status, ...(outcome ? { outcome } : {}) };
    this.tasks.set(id, t);
    for (const h of this.handlers) h(t);
  }

  /** Mark a task terminal WITHOUT firing the hook (simulate a crash before settle). */
  forceTerminal(id: string, status: 'DONE' | 'FAILED', outcome?: Record<string, unknown>): void {
    this.tasks.set(id, { id, status, ...(outcome ? { outcome } : {}) });
  }
}

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe('LoopsService', () => {
  let module: TestingModule;
  let loops: LoopsService;
  let repo: LoopsRepository;
  let scheduler: SpyScheduler;
  let tasks: SpyTasks;
  let clockNow = at(2026, 7, 7, 8, 0);
  const dirsToClean: string[] = [];

  async function build(): Promise<TestingModule> {
    scheduler = new SpyScheduler();
    tasks = new SpyTasks();
    return Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        LoopsRepository,
        LoopsService,
        { provide: SchedulerService, useValue: scheduler },
        { provide: TasksService, useValue: tasks },
      ],
    }).compile();
  }

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-loops-svc-'));
    dirsToClean.push(dataDir);
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await build();
    loops = module.get(LoopsService);
    repo = module.get(LoopsRepository);
    clockNow = at(2026, 7, 7, 8, 0);
    loops.clock = { now: () => clockNow };
    // compile() does not run lifecycle hooks — invoke onModuleInit so the
    // scheduler/task-settlement handlers are registered (as in production).
    loops.onModuleInit();
  });

  afterEach(async () => {
    await module.close();
    delete process.env.NUNCIO_DATA_DIR;
  });

  afterAll(() => {
    for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
  });

  const create = (over: Partial<CreateLoopDto> = {}): CreateLoopDto => ({
    goal: 'nightly maintenance',
    schedule: { kind: 'cron', spec: 'daily@02:00' },
    projectPath: '/repos/x',
    ...over,
  });

  it('creates a loop and OWNS a schedule row targeting the loop', () => {
    const loop = loops.create(create());
    expect(loop.status).toBe('active');
    expect(loop.goal).toBe('nightly maintenance');
    expect(scheduler.created).toHaveLength(1);
    expect(loop.scheduleId).toBe(scheduler.created[0]!.id);
    // The schedule's target references this loop (B's {kind:'loop',loopId} seam).
    expect(scheduler.created[0]!.target).toMatchObject({ kind: 'loop', loopId: loop.id });
  });

  describe('read path carries the displayable schedule (UI join)', () => {
    it('list + get include schedule {kind, spec} and nextFireAt joined from the owned row', () => {
      loops.create(create({ schedule: { kind: 'cron', spec: 'daily@22:00' } }));
      const listed = loops.list()[0]!;
      expect(listed.schedule).toEqual({ kind: 'cron', spec: 'daily@22:00' });
      expect(typeof listed.nextFireAt).toBe('number');

      const got = loops.findById(listed.id)!;
      expect(got.schedule).toEqual({ kind: 'cron', spec: 'daily@22:00' });
      expect(got.nextFireAt).toBe(listed.nextFireAt);
    });

    it('a missing/corrupt schedule row yields null schedule + null nextFireAt, never a throw', () => {
      const loop = loops.create(create());
      // Simulate the schedule row vanishing (delete the scheduler side only).
      scheduler.deleteSchedule(loop.scheduleId);
      const got = loops.findById(loop.id)!;
      expect(got.schedule).toBeNull();
      expect(got.nextFireAt).toBeNull();
      // list must also survive it.
      expect(() => loops.list()).not.toThrow();
    });
  });

  it('rejects an empty goal', () => {
    expect(() => loops.create(create({ goal: '' }))).toThrow(/goal/i);
  });

  it('rejects non-positive-integer budget counts', () => {
    expect(() => loops.create(create({ maxRunsPerDay: 0 }))).toThrow(/runs|budget/i);
    expect(() => loops.create(create({ maxConsecutiveFailures: -1 }))).toThrow(/failures|budget/i);
    expect(() => loops.create(create({ maxRunsPerDay: 2.5 }))).toThrow(/runs|budget/i);
  });

  it('rejects an unknown stop-condition kind', () => {
    expect(() => loops.create(create({ stop: { kind: 'whenever' } as never }))).toThrow(/stop/i);
  });

  describe('fire — a loop run is a task with a fresh worktree', () => {
    it('fires within budget, enqueues the goal as a task, and records a run row', () => {
      const loop = loops.create(create({ maxRunsPerDay: 3 }));
      const runResult = loops.fire(loop.id);
      expect(runResult).not.toBeNull();
      expect(repo.listRuns(loop.id)).toHaveLength(1);
      expect(tasks.enqueued).toHaveLength(1);
      expect(tasks.enqueued[0]!.prompt).toBe('nightly maintenance');
    });

    it('a loop NEVER runs in-place — the enqueued task forces useWorktree=true (locked)', () => {
      const loop = loops.create(create());
      loops.fire(loop.id);
      expect(tasks.enqueued[0]!.useWorktree).toBe(true);
    });

    it('a run is born PENDING, never ok, until its task settles', () => {
      const loop = loops.create(create());
      const run = loops.fire(loop.id)!;
      expect(run.outcome).toBe('pending');
      expect(repo.listRuns(loop.id)[0]!.outcome).toBe('pending');
    });
  });

  describe('settlement from the task lane (finding #1)', () => {
    it('a task that FAILS finalizes its run to failed and increments the streak', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      // The task settles FAILED via the registered onTaskFinished handler.
      tasks.settle(run.taskId!, 'FAILED', { error: 'boom' });
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('failed');
    });

    it('three FAILED task settlements trip the breaker (the loop sees reality)', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      for (let i = 0; i < 3; i += 1) {
        const r = loops.fire(loop.id)!;
        tasks.settle(r.taskId!, 'FAILED');
      }
      expect(repo.findById(loop.id)!.status).toBe('broken');
    });

    it('a DONE task with a green verify settles the run green', () => {
      const loop = loops.create(create({ maxRunsPerDay: 10, maxConsecutiveFailures: 10 }));
      const r = loops.fire(loop.id)!;
      tasks.settle(r.taskId!, 'DONE', { verify: { ok: true } });
      const settled = repo.listRuns(loop.id).find((x) => x.id === r.id)!;
      expect(settled.outcome).toBe('ok');
      expect(settled.verify).toBe('green');
    });

    it('a DONE task that ended needs-attention counts as failed (rung-1 gave up)', () => {
      const loop = loops.create(create({ maxRunsPerDay: 10, maxConsecutiveFailures: 10 }));
      const r = loops.fire(loop.id)!;
      tasks.settle(r.taskId!, 'DONE', { verify: { ok: false }, needsAttention: { reason: 'max_rounds' } });
      expect(repo.listRuns(loop.id).find((x) => x.id === r.id)!.outcome).toBe('failed');
    });
  });

  describe('restart reconciliation of pending runs (finding #1)', () => {
    it('a run left pending across a restart is reconciled from the task, not stuck pending', async () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      // Simulate a crash: the task went terminal (FAILED) but the settlement hook
      // never fired before the daemon died — the run is still pending.
      tasks.forceTerminal(run.taskId!, 'FAILED');
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('pending');

      const dataDir = process.env.NUNCIO_DATA_DIR!;
      await module.close();
      process.env.NUNCIO_DATA_DIR = dataDir;
      // Fresh module on the same DB. The SAME task store is re-provided so the
      // reconcile can read the now-terminal task.
      const survivingTasks = tasks;
      module = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          LoopsRepository,
          LoopsService,
          { provide: SchedulerService, useValue: new SpyScheduler() },
          { provide: TasksService, useValue: survivingTasks },
        ],
      }).compile();
      loops = module.get(LoopsService);
      repo = module.get(LoopsRepository);
      loops.clock = { now: () => clockNow };
      loops.onModuleInit(); // runs reconcilePendingRuns

      const reconciled = repo.listRuns(loop.id).find((r) => r.id === run.id)!;
      expect(reconciled.outcome).toBe('failed');
    });

    // Rebuild the module on the SAME DB with the surviving task store — as a
    // daemon restart would, so reconcilePendingRuns runs against real task state.
    async function restart(survivingTasks: SpyTasks): Promise<void> {
      const dataDir = process.env.NUNCIO_DATA_DIR!;
      await module.close();
      process.env.NUNCIO_DATA_DIR = dataDir;
      module = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          LoopsRepository,
          LoopsService,
          { provide: SchedulerService, useValue: new SpyScheduler() },
          { provide: TasksService, useValue: survivingTasks },
        ],
      }).compile();
      loops = module.get(LoopsService);
      repo = module.get(LoopsRepository);
      loops.clock = { now: () => clockNow };
      loops.onModuleInit(); // runs reconcilePendingRuns
    }

    it('a still-QUEUED task keeps its run PENDING, then settles ok when it later completes', async () => {
      // The bug: reconcile eagerly failed a live task's run, and onTaskSettled
      // (which only updates pending rows) could never correct it.
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      tasks.setStatus(run.taskId!, 'QUEUED'); // alive, re-run by the pump after boot

      await restart(tasks);
      // A live task's run must NOT be phantom-failed at boot.
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('pending');

      // The re-run completes green → the normal settlement hook folds it.
      tasks.settle(run.taskId!, 'DONE', { verify: { ok: true } });
      const settled = repo.listRuns(loop.id).find((r) => r.id === run.id)!;
      expect(settled.outcome).toBe('ok');
      expect(repo.findById(loop.id)!.status).toBe('active'); // no phantom failure → no breaker
    });

    it('a still-RUNNING task at boot keeps its run pending (reclaimed/settled by the task lane)', async () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 1, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      tasks.setStatus(run.taskId!, 'RUNNING');
      await restart(tasks);
      // maxConsecutiveFailures=1: if reconcile wrongly failed it, the breaker would
      // trip. It must stay pending → active.
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('pending');
      expect(repo.findById(loop.id)!.status).toBe('active');
    });

    it('a vanished task finalizes the run failed', async () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      tasks.vanish(run.taskId!); // task row gone across the crash
      await restart(tasks);
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('failed');
    });

    it('an already-FAILED task finalizes the run failed', async () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3, maxRunsPerDay: 10 }));
      const run = loops.fire(loop.id)!;
      tasks.forceTerminal(run.taskId!, 'FAILED'); // e.g. failInterrupted ran before reconcile
      await restart(tasks);
      expect(repo.listRuns(loop.id).find((r) => r.id === run.id)!.outcome).toBe('failed');
    });
  });

  describe('schedule validation at creation (finding #2)', () => {
    it('rejects a typo cron spec — no inert loop is stored', () => {
      expect(() => loops.create(create({ schedule: { kind: 'cron', spec: 'daliy@02:00' } }))).toThrow(/spec/i);
      expect(loops.list().every((l) => l.goal !== 'nightly maintenance')).toBe(true);
    });

    it('rejects an unsupported schedule kind', () => {
      expect(() =>
        loops.create(create({ schedule: { kind: 'weekly' as never, spec: 'daily@02:00' } })),
      ).toThrow(/kind/i);
    });

    it('accepts a valid cron spec', () => {
      const loop = loops.create(create({ schedule: { kind: 'cron', spec: 'every:30m' } }));
      expect(loop.status).toBe('active');
    });
  });

  describe('day budget', () => {
    // Settle each run so the next fire is not blocked by the overlap guard.
    const fireAndSettle = (loopId: string) => {
      const r = loops.fire(loopId);
      if (r?.taskId) tasks.settle(r.taskId, 'DONE', { verify: { ok: true } });
      return r;
    };

    it('skips a fire once maxRunsPerDay is reached, then resumes after local midnight', () => {
      const loop = loops.create(create({ maxRunsPerDay: 2, maxConsecutiveFailures: 10 }));
      fireAndSettle(loop.id);
      fireAndSettle(loop.id);
      // Third fire same day → budget exhausted, no new task run.
      const third = loops.fire(loop.id);
      expect(third).toBeNull();
      const runs = repo.listRuns(loop.id);
      expect(runs.filter((r) => r.outcome === 'budget-exhausted').length).toBeGreaterThanOrEqual(1);

      // Cross midnight → budget resets.
      clockNow = at(2026, 7, 8, 2, 0);
      const nextDay = loops.fire(loop.id);
      expect(nextDay).not.toBeNull();
    });
  });

  describe('overlap guard — no stacking while a run is unsettled (finding #2)', () => {
    it('a fire while a prior run is still pending SKIPS without consuming budget', () => {
      const loop = loops.create(create({ maxRunsPerDay: 5, maxConsecutiveFailures: 3 }));
      const first = loops.fire(loop.id)!;
      expect(first.outcome).toBe('pending');
      // Second fire while #1 is unsettled → skip-overlap, no new task.
      const second = loops.fire(loop.id);
      expect(second).toBeNull();
      expect(tasks.enqueued).toHaveLength(1); // only ONE task enqueued
      const runs = repo.listRuns(loop.id);
      expect(runs.filter((r) => r.outcome === 'skipped-overlap')).toHaveLength(1);
      // The skip did NOT consume the day budget: only the 1 pending run counts.
      expect(runs.filter((r) => r.outcome === 'pending')).toHaveLength(1);
    });

    it('after the pending run settles, the next fire proceeds', () => {
      const loop = loops.create(create({ maxRunsPerDay: 5, maxConsecutiveFailures: 3 }));
      const first = loops.fire(loop.id)!;
      expect(loops.fire(loop.id)).toBeNull(); // skipped while pending
      tasks.settle(first.taskId!, 'DONE', { verify: { ok: true } });
      const next = loops.fire(loop.id);
      expect(next).not.toBeNull();
      expect(next!.outcome).toBe('pending');
      expect(tasks.enqueued).toHaveLength(2);
    });

    it('skip-overlap rows are transparent to the failure streak (breaker still trips at 3 real failures)', () => {
      const loop = loops.create(create({ maxRunsPerDay: 20, maxConsecutiveFailures: 3 }));
      for (let i = 0; i < 3; i += 1) {
        const r = loops.fire(loop.id)!;
        // A stray skip attempt while pending must not reset the streak.
        loops.fire(loop.id); // skipped-overlap
        tasks.settle(r.taskId!, 'FAILED');
      }
      expect(repo.findById(loop.id)!.status).toBe('broken');
    });
  });

  describe('breaker', () => {
    it('trips after N consecutive failures: status broken, schedule disabled, needs-attention emitted', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3 }));
      for (let i = 0; i < 3; i += 1) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId ?? `t${i}`, false); // failed
      }
      const broken = repo.findById(loop.id)!;
      expect(broken.status).toBe('broken');
      // Schedule disabled via the scheduler seam.
      expect(scheduler.enabledCalls.some((c) => c.id === loop.scheduleId && c.enabled === false)).toBe(true);
    });

    it('honours a per-loop maxConsecutiveFailures override (trips at 2)', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 2 }));
      for (let i = 0; i < 2; i += 1) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId ?? `t${i}`, false);
      }
      expect(repo.findById(loop.id)!.status).toBe('broken');
    });

    it('a success mid-streak resets the streak (no trip)', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3 }));
      const outcomes = [false, false, true, false];
      for (const ok of outcomes) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId ?? 't', ok);
      }
      expect(repo.findById(loop.id)!.status).toBe('active');
    });

    it('manual resume re-enables the schedule and zeroes the streak', () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 2 }));
      for (let i = 0; i < 2; i += 1) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId ?? 't', false);
      }
      expect(repo.findById(loop.id)!.status).toBe('broken');

      const resumed = loops.resume(loop.id);
      expect(resumed.status).toBe('active');
      expect(scheduler.enabledCalls.some((c) => c.id === loop.scheduleId && c.enabled === true)).toBe(true);
      // The streak is zeroed (a resume marker), so one more failure does not re-trip.
      const r = loops.fire(loop.id)!;
      loops.recordTaskOutcome(loop.id, r.taskId ?? 't', false);
      expect(repo.findById(loop.id)!.status).toBe('active');
    });
  });

  describe('stop condition', () => {
    it('auto-completes when maxTotalRuns is reached', () => {
      const loop = loops.create(create({ stop: { kind: 'maxTotalRuns', n: 2 } }));
      const r1 = loops.fire(loop.id)!;
      loops.recordTaskOutcome(loop.id, r1.taskId ?? 't', true);
      const r2 = loops.fire(loop.id)!;
      loops.recordTaskOutcome(loop.id, r2.taskId ?? 't', true);
      // Stop reached → completed, schedule disabled, no further fires.
      expect(repo.findById(loop.id)!.status).toBe('completed');
      expect(loops.fire(loop.id)).toBeNull();
    });

    it('verifyGreenN: auto-completes after N consecutive green-verify runs', () => {
      const loop = loops.create(create({
        stop: { kind: 'verifyGreenN', n: 3 },
        maxRunsPerDay: 10,
        maxConsecutiveFailures: 10, // don't let the breaker interfere
      }));
      for (let i = 0; i < 3; i += 1) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId!, { ok: true, verify: 'green' });
      }
      expect(repo.findById(loop.id)!.status).toBe('completed');
    });

    it('verifyGreenN: a red verify resets the green streak (does not complete early)', () => {
      const loop = loops.create(create({
        stop: { kind: 'verifyGreenN', n: 2 },
        maxRunsPerDay: 10,
        maxConsecutiveFailures: 10,
      }));
      const greens = [true, false, true]; // green, red, green -> streak 1, not 2
      for (const ok of greens) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId!, { ok, verify: ok ? 'green' : 'red' });
      }
      expect(repo.findById(loop.id)!.status).toBe('active');
    });

    it('verifyGreenN: a run with no verify signal carries the streak (neither counts nor resets)', () => {
      const loop = loops.create(create({
        stop: { kind: 'verifyGreenN', n: 2 },
        maxRunsPerDay: 10,
        maxConsecutiveFailures: 10,
      }));
      const runs: Array<{ ok: boolean; verify: 'green' | 'red' | 'none' }> = [
        { ok: true, verify: 'green' },
        { ok: true, verify: 'none' }, // no verify configured — transparent
        { ok: true, verify: 'green' },
      ];
      for (const o of runs) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId!, o);
      }
      // The two greens (bracketing the no-verify run) reach n=2 → completed.
      expect(repo.findById(loop.id)!.status).toBe('completed');
    });
  });

  describe('pause / resume / delete', () => {
    it('pause disables the schedule and stops fires; resume re-enables', () => {
      const loop = loops.create(create());
      loops.pause(loop.id);
      expect(repo.findById(loop.id)!.status).toBe('paused');
      expect(loops.fire(loop.id)).toBeNull();
      loops.resume(loop.id);
      expect(repo.findById(loop.id)!.status).toBe('active');
    });

    it('delete removes the loop (and its owned schedule)', () => {
      const loop = loops.create(create());
      loops.delete(loop.id);
      expect(loops.findById(loop.id)).toBeNull();
    });

    it('a completed loop cannot be paused or resumed past its stop (finding #3)', () => {
      const loop = loops.create(create({ stop: { kind: 'maxTotalRuns', n: 1 } }));
      const r = loops.fire(loop.id)!;
      tasks.settle(r.taskId!, 'DONE', { verify: { ok: true } });
      expect(repo.findById(loop.id)!.status).toBe('completed');

      // pause must not transition a completed loop (which would let resume revive it).
      expect(() => loops.pause(loop.id)).toThrow(/completed|pausable/i);
      // resume must never resurrect a completed loop.
      expect(() => loops.resume(loop.id)).toThrow(/completed|resumable/i);
      expect(repo.findById(loop.id)!.status).toBe('completed');
      // The schedule stays disabled (was disabled at completion).
      expect(scheduler.enabledCalls.some((c) => c.id === loop.scheduleId && c.enabled === false)).toBe(true);
    });
  });

  describe('restart', () => {
    it('rebuilds the failure streak from loop_runs after a restart (no in-memory truth)', async () => {
      const loop = loops.create(create({ maxConsecutiveFailures: 3 }));
      // Two failures, not yet tripped.
      for (let i = 0; i < 2; i += 1) {
        const r = loops.fire(loop.id)!;
        loops.recordTaskOutcome(loop.id, r.taskId ?? 't', false);
      }
      const dataDir = process.env.NUNCIO_DATA_DIR!;
      await module.close();

      // Fresh module on the same DB — the streak must re-fold to 2.
      process.env.NUNCIO_DATA_DIR = dataDir;
      module = await build();
      loops = module.get(LoopsService);
      repo = module.get(LoopsRepository);
      loops.clock = { now: () => clockNow };
      // One more failure trips the breaker (streak 2 -> 3), proving the streak survived.
      const r = loops.fire(loop.id)!;
      loops.recordTaskOutcome(loop.id, r.taskId ?? 't', false);
      expect(repo.findById(loop.id)!.status).toBe('broken');
    });
  });

  describe('unknown project fallthrough', () => {
    it('a loop whose projectPath has no projects row still fires (soft ref, no crash)', () => {
      const loop = loops.create(create({ projectPath: '/never/configured/repo' }));
      expect(() => loops.fire(loop.id)).not.toThrow();
    });
  });
});
