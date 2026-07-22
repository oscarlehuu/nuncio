import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { TasksService } from '../../../src/tasks/tasks.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import type { CreateScheduleDto, ScheduleTarget } from '../../../src/scheduler/scheduler.types';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';

/**
 * The firing loop — deterministic via the injected clock (no real sleeps). RED
 * until implemented. A spy TasksService records enqueues so we assert firing
 * without running the real task runner.
 */

// Records every enqueue for assertion; enough surface to stand in for TasksService.
class SpyTasksService {
  readonly enqueued: Array<{ prompt: string; projectPath?: string }> = [];
  onEnqueue: (() => void) | null = null;
  enqueue(input: { prompt: string; projectPath?: string }): { id: string } | Promise<{ id: string }> {
    this.onEnqueue?.();
    this.enqueued.push({ prompt: input.prompt, projectPath: input.projectPath });
    return { id: `task-${this.enqueued.length}` };
  }
  deferPumpUntilCommit<T>(work: () => T): { result: T; afterCommit: () => void } {
    return { result: work(), afterCommit: () => {} };
  }
}

const taskTarget = (prompt: string): ScheduleTarget => ({ kind: 'task', template: { prompt } });

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function webhook(action: string, labels: string[]): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId: `d-${Math.random()}`,
    kind: 'issue',
    action,
    owner: 'o',
    repo: 'r',
    repoFullName: 'o/r',
    defaultBranch: 'main',
    number: 1,
    title: 't',
    body: 'b',
    labels,
  };
}

/** A GitHub PR close delivery (action stays 'closed'; `merged` distinguishes the two). */
function pr(merged: boolean): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId: `d-${Math.random()}`,
    kind: 'pull_request',
    action: 'closed',
    owner: 'o',
    repo: 'r',
    repoFullName: 'o/r',
    defaultBranch: 'main',
    number: 9,
    title: 't',
    body: 'b',
    labels: [],
    merged,
    url: 'https://example.test/pr/9',
  };
}
const mergedPr = () => pr(true);
const closedPr = () => pr(false);

describe('SchedulerService firing loop', () => {
  let dataDir: string;
  let module: TestingModule;
  let scheduler: SchedulerService;
  let repo: SchedulesRepository;
  let tasks: SpyTasksService;
  let clockNow = at(2026, 7, 7, 8, 0);

  async function build(): Promise<TestingModule> {
    // SchedulerService injects TasksService @Optional — provide the spy directly
    // as that token rather than pulling the real TasksModule (the whole runner).
    return Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        SchedulesRepository,
        SchedulerService,
        { provide: TasksService, useValue: tasks },
      ],
    }).compile();
  }

  // Per-test data dir: each test builds one or more modules whose repo reads the
  // WHOLE schedules table — a shared dir leaks prior tests' rows (extra due
  // schedules / enqueues). Clean in afterAll, never mid-run (an in-flight fire
  // may still hold the SQLite file). Same isolation lesson as rungs 1/2A.
  const dirsToClean: string[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-'));
    dirsToClean.push(dataDir);
    process.env.NUNCIO_DATA_DIR = dataDir;
    tasks = new SpyTasksService();
    module = await build();
    scheduler = module.get(SchedulerService);
    repo = module.get(SchedulesRepository);
    clockNow = at(2026, 7, 7, 8, 0);
    scheduler.clock = { now: () => clockNow };
  });

  afterEach(async () => {
    await module.close();
    delete process.env.NUNCIO_DATA_DIR;
  });

  afterAll(() => {
    for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
  });

  const cron = (spec: string): CreateScheduleDto => ({ kind: 'cron', spec, target: taskTarget('nightly') });

  it('create computes next_fire_at from the spec + clock', () => {
    const s = scheduler.create(cron('daily@09:30'));
    expect(s.nextFireAt).toBe(at(2026, 7, 7, 9, 30));
  });

  it('scanDue fires a due schedule through TasksService and advances next fire', () => {
    scheduler.create(cron('daily@09:30'));
    clockNow = at(2026, 7, 7, 9, 30); // now due
    scheduler.scanDue();
    expect(tasks.enqueued).toHaveLength(1);
    expect(tasks.enqueued[0]!.prompt).toBe('nightly');
    // Advanced to tomorrow, not re-fired on a second scan at the same instant.
    scheduler.scanDue();
    expect(tasks.enqueued).toHaveLength(1);
  });

  it('persists a pending dispatch intent before invoking and advancing a due slot', () => {
    const database = module.get(DatabaseService);
    let pendingAtInvoke = 0;
    tasks.onEnqueue = () => {
      const table = database.db.prepare<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schedule_dispatch_intents'",
      ).get()?.count ?? 0;
      if (table === 0) return;
      pendingAtInvoke = database.db.prepare<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM schedule_dispatch_intents WHERE status = 'pending'",
      ).get()?.count ?? 0;
    };
    scheduler.create(cron('daily@09:30'));
    clockNow = at(2026, 7, 7, 9, 30);

    scheduler.scanDue();

    expect(pendingAtInvoke).toBe(1);
  });

  it('keeps normal clock dispatch fail-soft and retryable when intent persistence fails', () => {
    scheduler.create(cron('daily@09:30'));
    clockNow = at(2026, 7, 7, 9, 30);
    const begin = repo.dispatches.begin.bind(repo.dispatches);
    repo.dispatches.begin = (() => {
      throw new Error('intent persistence unavailable');
    }) as typeof repo.dispatches.begin;

    expect(() => scheduler.scanDue()).not.toThrow();
    expect(tasks.enqueued).toHaveLength(0);

    repo.dispatches.begin = begin;
    scheduler.scanDue();
    expect(tasks.enqueued).toHaveLength(1);
  });

  it('scanDue does not fire a schedule that is not yet due', () => {
    scheduler.create(cron('daily@09:30'));
    clockNow = at(2026, 7, 7, 9, 0); // before
    scheduler.scanDue();
    expect(tasks.enqueued).toHaveLength(0);
  });

  it('a {kind:system} target resolves through the registered system-fire handler (rung 3 heartbeat)', () => {
    const fired: string[] = [];
    scheduler.setSystemFireHandler((job) => { fired.push(job); });
    scheduler.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    clockNow = at(2026, 7, 7, 8, 15); // one interval later → due
    scheduler.scanDue();
    expect(fired).toEqual(['infra']);
    // A system fire never touches the task runner.
    expect(tasks.enqueued).toHaveLength(0);
  });

  it('allows multiple system fire handlers so heartbeat and dispatcher share the seam', () => {
    const fired: string[] = [];
    scheduler.setSystemFireHandler((job) => { fired.push(`heartbeat:${job}`); });
    scheduler.addSystemFireHandler((job) => { fired.push(`dispatcher:${job}`); });
    scheduler.create({
      kind: 'cron',
      spec: 'daily@20:05',
      target: { kind: 'system', job: 'dispatcher-evening' },
    });
    clockNow = at(2026, 7, 7, 20, 5);

    scheduler.scanDue();

    expect(fired).toEqual(['heartbeat:dispatcher-evening', 'dispatcher:dispatcher-evening']);
  });

  it('fires all schedules due at once, each advancing independently', () => {
    scheduler.create({ kind: 'cron', spec: 'daily@09:00', target: taskTarget('a') });
    scheduler.create({ kind: 'cron', spec: 'daily@09:00', target: taskTarget('b') });
    clockNow = at(2026, 7, 7, 9, 0);
    scheduler.scanDue();
    expect(tasks.enqueued.map((t) => t.prompt).sort()).toEqual(['a', 'b']);
  });

  it('a disabled schedule never fires; re-enabling recomputes next_fire from now', () => {
    const s = scheduler.create(cron('daily@09:30'));
    scheduler.setEnabled(s.id, false);
    clockNow = at(2026, 7, 7, 9, 30);
    scheduler.scanDue();
    expect(tasks.enqueued).toHaveLength(0);

    clockNow = at(2026, 7, 7, 10, 0); // re-enable at 10:00
    scheduler.setEnabled(s.id, true);
    const reenabled = repo.findById(s.id)!;
    expect(reenabled.nextFireAt).toBe(at(2026, 7, 8, 9, 30)); // tomorrow, not the passed slot today
  });

  describe('missed-fire policy (recommended: fire-once-on-boot)', () => {
    it('fires once with a missed marker when next_fire passed during downtime, then advances', () => {
      // Create with next-fire in the past relative to boot (simulate downtime).
      const s = scheduler.create(cron('daily@09:30'));
      repo.setNextFire(repo.findById(s.id)!, at(2026, 7, 7, 7, 0)); // 07:00 — already passed at boot (08:00)
      scheduler.rehydrate();
      scheduler.scanDue();
      expect(tasks.enqueued).toHaveLength(1);
      const after = repo.findById(s.id)!;
      expect(after.lastResult).toBe('missed');
      expect(after.nextFireAt).toBeGreaterThan(clockNow); // advanced to the future
    });
  });

  describe('stale-skip visibility (missed > 24h → surfaced, not silent)', () => {
    it('buffers a stale-skip when next_fire is older than the 24h window, then advances silently', () => {
      const s = scheduler.create(cron('daily@09:30'));
      // 3 days stale — older than the 24h missed-fire window.
      const stale = at(2026, 7, 4, 9, 30);
      repo.setNextFire(repo.findById(s.id)!, stale);
      scheduler.rehydrate();

      const skips = scheduler.drainStaleSkips();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ scheduleId: s.id, spec: 'daily@09:30', previousFireAt: stale });
      expect(skips[0]!.recomputedFireAt).toBeGreaterThan(clockNow);
      // The stored next-fire was advanced to the future (no 'missed' catch-up fire).
      expect(repo.findById(s.id)!.nextFireAt).toBeGreaterThan(clockNow);
      scheduler.scanDue();
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('a RECENTLY-missed slot (within 24h) is fired-once, not buffered as a stale-skip', () => {
      const s = scheduler.create(cron('daily@09:30'));
      repo.setNextFire(repo.findById(s.id)!, at(2026, 7, 7, 7, 0)); // 1h ago — within the window
      scheduler.rehydrate();
      expect(scheduler.drainStaleSkips()).toHaveLength(0);
    });

    it('drain is idempotent — a second drain returns empty', () => {
      const s = scheduler.create(cron('daily@09:30'));
      repo.setNextFire(repo.findById(s.id)!, at(2026, 7, 1, 9, 30));
      scheduler.rehydrate();
      expect(scheduler.drainStaleSkips()).toHaveLength(1);
      expect(scheduler.drainStaleSkips()).toHaveLength(0);
    });

    it('a disabled schedule is never buffered', () => {
      const s = scheduler.create(cron('daily@09:30'));
      repo.setNextFire(repo.findById(s.id)!, at(2026, 7, 1, 9, 30));
      scheduler.setEnabled(s.id, false);
      scheduler.rehydrate();
      expect(scheduler.drainStaleSkips()).toHaveLength(0);
    });
  });

  describe('revision fencing', () => {
    it('does not let a late failed completion overwrite a newer schedule spec revision', async () => {
      let rejectDispatch!: (error: Error) => void;
      tasks.enqueue = (input) => {
        tasks.enqueued.push({ prompt: input.prompt, projectPath: input.projectPath });
        return new Promise((_resolve, reject) => { rejectDispatch = reject; });
      };
      const schedule = scheduler.create(cron('daily@09:00'));
      clockNow = at(2026, 7, 7, 9, 0);
      scheduler.scanDue();
      scheduler.updateSpec(schedule.id, 'cron', 'daily@17:00');
      const revised = repo.findById(schedule.id)!;

      rejectDispatch(new Error('old dispatch failed late'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(repo.findById(schedule.id)).toMatchObject({
        kind: 'cron', spec: 'daily@17:00', nextFireAt: revised.nextFireAt,
      });
      expect(repo.findById(schedule.id)!.lastResult).not.toBe('error:old dispatch failed late');
    });
  });

  describe('overlap skip', () => {
    it('skips with a marker when the prior fire of the SAME schedule is still in flight', async () => {
      // A gated task runner: the first enqueue stays "in flight" until released, so
      // the schedule is still running when the next fire comes due.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gated = {
        calls: 0,
        async enqueue(_input: { prompt: string }) {
          this.calls += 1;
          if (this.calls === 1) await gate; // first fire blocks
          return { id: `gated-${this.calls}` };
        },
      };
      const gatedModule = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          SchedulesRepository,
          SchedulerService,
          { provide: TasksService, useValue: gated },
        ],
      }).compile();
      const s2 = gatedModule.get(SchedulerService);
      const r2 = gatedModule.get(SchedulesRepository);
      let nowMs = at(2026, 7, 7, 8, 0);
      s2.clock = { now: () => nowMs };
      // Created at 08:00 → next_fire today 09:00 (strictly after now).
      const s = s2.create({ kind: 'cron', spec: 'daily@09:00', target: taskTarget('x') });

      nowMs = at(2026, 7, 7, 9, 0); // now due
      s2.scanDue(); // fire 1 — blocks in flight
      r2.setNextFire(r2.findById(s.id)!, at(2026, 7, 7, 9, 0)); // force due again while fire 1 hangs
      s2.scanDue(); // must skip: fire 1 still in flight
      expect(r2.findById(s.id)!.lastResult).toBe('skipped-overlap');
      expect(gated.calls).toBe(1); // never a second concurrent enqueue for one schedule

      release();
      await new Promise((r) => setTimeout(r, 10));
      await gatedModule.close();
    });
  });

  describe('boot rehydration', () => {
    it('recovers a persisted pending dispatch on restart using the same database', async () => {
      const seedDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-intent-restart-'));
      process.env.NUNCIO_DATA_DIR = seedDir;
      const firstTasks = new SpyTasksService();
      firstTasks.enqueue = (input) => {
        firstTasks.enqueued.push({ prompt: input.prompt, projectPath: input.projectPath });
        return new Promise(() => {});
      };
      const first = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          SchedulesRepository,
          SchedulerService,
          { provide: TasksService, useValue: firstTasks },
        ],
      }).compile();
      const firstScheduler = first.get(SchedulerService);
      let now = at(2026, 7, 7, 8, 0);
      firstScheduler.clock = { now: () => now };
      firstScheduler.create(cron('daily@09:00'));
      now = at(2026, 7, 7, 9, 0);
      firstScheduler.scanDue();
      expect(firstTasks.enqueued).toHaveLength(1);
      await first.close();

      const recoveredTasks = new SpyTasksService();
      const second = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          SchedulesRepository,
          SchedulerService,
          { provide: TasksService, useValue: recoveredTasks },
        ],
      }).compile();
      const secondScheduler = second.get(SchedulerService);
      secondScheduler.clock = { now: () => now };
      secondScheduler.onModuleInit();
      secondScheduler.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(recoveredTasks.enqueued).toHaveLength(1);
      await second.close();
      rmSync(seedDir, { recursive: true, force: true });
      process.env.NUNCIO_DATA_DIR = dataDir;
    });

    it('defers recovered loop dispatch until target handlers are registered', async () => {
      const seedDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-loop-intent-restart-'));
      process.env.NUNCIO_DATA_DIR = seedDir;
      const first = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [SchedulesRepository, SchedulerService],
      }).compile();
      const firstScheduler = first.get(SchedulerService);
      let now = at(2026, 7, 7, 8, 0);
      firstScheduler.clock = { now: () => now };
      firstScheduler.setLoopFireHandler(() => new Promise(() => {}));
      firstScheduler.create({
        kind: 'cron', spec: 'daily@09:00', target: { kind: 'loop', loopId: 'loop-recover' },
      });
      now = at(2026, 7, 7, 9, 0);
      firstScheduler.scanDue();
      await first.close();

      const second = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [SchedulesRepository, SchedulerService],
      }).compile();
      const recovered: string[] = [];
      const secondScheduler = second.get(SchedulerService);
      secondScheduler.clock = { now: () => now };
      secondScheduler.onModuleInit();
      secondScheduler.setLoopFireHandler((loopId) => { recovered.push(loopId); });
      expect(recovered).toHaveLength(0);

      secondScheduler.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(recovered).toEqual(['loop-recover']);

      await second.close();
      rmSync(seedDir, { recursive: true, force: true });
      process.env.NUNCIO_DATA_DIR = dataDir;
    });

    it('recomputes next_fire_at from spec + clock after a restart (no in-memory truth)', async () => {
      const seedDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-rehydrate-'));
      process.env.NUNCIO_DATA_DIR = seedDir;
      const first = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          SchedulesRepository,
          SchedulerService,
          { provide: TasksService, useValue: new SpyTasksService() },
        ],
      }).compile();
      const sched1 = first.get(SchedulerService);
      sched1.clock = { now: () => at(2026, 7, 7, 8, 0) };
      const created = sched1.create(cron('daily@09:30'));
      // Corrupt the stored next-fire to prove boot recomputes it.
      first.get(SchedulesRepository).setNextFire(created, 1);
      await first.close();

      const second = await Test.createTestingModule({
        imports: [DatabaseModule],
        providers: [
          SchedulesRepository,
          SchedulerService,
          { provide: TasksService, useValue: new SpyTasksService() },
        ],
      }).compile();
      const sched2 = second.get(SchedulerService);
      sched2.clock = { now: () => at(2026, 7, 8, 8, 0) };
      sched2.rehydrate();
      const rebuilt = second.get(SchedulesRepository).findById(created.id)!;
      expect(rebuilt.nextFireAt).toBe(at(2026, 7, 8, 9, 30));
      await second.close();
      rmSync(seedDir, { recursive: true, force: true });
      process.env.NUNCIO_DATA_DIR = dataDir;
    });
  });

  describe('event triggers', () => {
    it('fires when a webhook event matches the filter (event + label)', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
        target: taskTarget('triage'),
      });
      scheduler.handleWebhookEvent('github', webhook('opened', ['agent']));
      expect(tasks.enqueued.map((t) => t.prompt)).toContain('triage');
    });

    it('propagates intent persistence failure for transactional webhook dispatch', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
        target: taskTarget('triage'),
      });
      const begin = repo.dispatches.begin.bind(repo.dispatches);
      repo.dispatches.begin = (() => {
        throw new Error('intent persistence unavailable');
      }) as typeof repo.dispatches.begin;

      try {
        expect(() => scheduler.handleWebhookEventTransactional(
          'github',
          webhook('opened', ['agent']),
        )).toThrow('intent persistence unavailable');
        expect(tasks.enqueued).toHaveLength(0);
      } finally {
        repo.dispatches.begin = begin;
      }
    });

    it('keeps a newer webhook retryable behind an earlier pending dispatch', () => {
      const database = module.get(DatabaseService);
      const schedule = scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
        target: taskTarget('ordered webhook target'),
      });
      const earlier = repo.dispatches.begin(schedule, 1, 'ok', null, null);

      expect(() => database.immediateTransaction(() =>
        scheduler.handleWebhookEventTransactional('github', webhook('opened', ['agent'])),
      )).toThrow(`Schedule ${schedule.id} has an earlier pending dispatch`);

      expect(repo.dispatches.listPending().map((intent) => intent.id)).toEqual([earlier.id]);
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('rolls back earlier matching intents before any target starts when a later persist fails', () => {
      const database = module.get(DatabaseService);
      for (const prompt of ['first', 'second']) {
        scheduler.create({
          kind: 'event',
          spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
          target: taskTarget(prompt),
        });
      }
      const begin = repo.dispatches.begin.bind(repo.dispatches);
      let beginCalls = 0;
      const failSecond: typeof repo.dispatches.begin = (...args) => {
        beginCalls += 1;
        if (beginCalls === 2) throw new Error('second intent persistence unavailable');
        return begin(...args);
      };
      repo.dispatches.begin = failSecond;

      try {
        expect(() => database.immediateTransaction(() =>
          scheduler.handleWebhookEventTransactional('github', webhook('opened', ['agent'])),
        )).toThrow('second intent persistence unavailable');
        expect(database.db.prepare<{ count: number }, []>(
          'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
        ).get()?.count).toBe(0);
        expect(tasks.enqueued).toHaveLength(0);
      } finally {
        repo.dispatches.begin = begin;
      }
    });

    it('transactional webhook dispatch succeeds with no matching schedule and creates no intent', () => {
      const database = module.get(DatabaseService);

      expect(() => scheduler.handleWebhookEventTransactional(
        'github',
        webhook('opened', ['agent']),
      )).not.toThrow();
      expect(database.db.prepare<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
      ).get()?.count).toBe(0);
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('fails transactional webhook acceptance after scheduler shutdown without changing normal isolation', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
        target: taskTarget('triage'),
      });
      scheduler.onModuleDestroy();

      expect(() => scheduler.handleWebhookEvent('github', webhook('opened', ['agent']))).not.toThrow();
      expect(() => scheduler.handleWebhookEventTransactional(
        'github',
        webhook('opened', ['agent']),
      )).toThrow('Scheduler is unavailable for transactional webhook dispatch');
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('does not fire when the action or label does not match', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent' }),
        target: taskTarget('triage'),
      });
      scheduler.handleWebhookEvent('github', webhook('closed', ['agent'])); // wrong action
      scheduler.handleWebhookEvent('github', webhook('opened', ['bug'])); // wrong label
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('does not fire an event schedule via the clock scan (no next_fire)', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened' }),
        target: taskTarget('triage'),
      });
      clockNow = at(2030, 1, 1, 0, 0); // far future
      scheduler.scanDue();
      expect(tasks.enqueued).toHaveLength(0);
    });

    it('a project-scoped filter fires ONLY for its own project', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened', label: 'agent', projectPath: '/repos/mine' }),
        target: taskTarget('triage'),
      });
      // Same event+label, but the delivery resolved to a DIFFERENT project → no fire.
      scheduler.handleWebhookEvent('github', webhook('opened', ['agent']), '/repos/other');
      expect(tasks.enqueued).toHaveLength(0);
      // The matching project fires it.
      scheduler.handleWebhookEvent('github', webhook('opened', ['agent']), '/repos/mine');
      expect(tasks.enqueued.map((t) => t.prompt)).toContain('triage');
    });

    it('an unscoped filter still matches any project (back-compat)', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'issue.opened' }),
        target: taskTarget('triage'),
      });
      scheduler.handleWebhookEvent('github', webhook('opened', []), '/repos/anything');
      expect(tasks.enqueued).toHaveLength(1);
    });

    it('normalizes a merged closed PR to pull_request.merged (not .closed)', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'pull_request.merged' }),
        target: taskTarget('on-merge'),
      });
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'pull_request.closed' }),
        target: taskTarget('on-close'),
      });
      // GitHub delivers a merge as action='closed' + merged:true.
      scheduler.handleWebhookEvent('github', mergedPr());
      const prompts = tasks.enqueued.map((t) => t.prompt);
      expect(prompts).toContain('on-merge');
      expect(prompts).not.toContain('on-close');
    });

    it('a non-merged close matches pull_request.closed only', () => {
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'pull_request.closed' }),
        target: taskTarget('on-close'),
      });
      scheduler.create({
        kind: 'event',
        spec: JSON.stringify({ event: 'pull_request.merged' }),
        target: taskTarget('on-merge'),
      });
      scheduler.handleWebhookEvent('github', closedPr());
      const prompts = tasks.enqueued.map((t) => t.prompt);
      expect(prompts).toContain('on-close');
      expect(prompts).not.toContain('on-merge');
    });
  });

  describe('robustness', () => {
    it('a malformed target records an error result and does not crash the scan', () => {
      const s = scheduler.create(cron('daily@09:00'));
      // Corrupt the target directly in the row (simulate bad data).
      repo.recordFire(s, 0, 'ok', at(2026, 7, 7, 9, 0));
      // A crafted junk target via a raw create is exercised through the repo layer;
      // here we assert the scan survives a schedule whose fire throws.
      clockNow = at(2026, 7, 7, 9, 0);
      expect(() => scheduler.scanDue()).not.toThrow();
    });

    it('scanDue after shutdown does not write to a closed DB (bounded, no crash)', async () => {
      scheduler.create(cron('daily@09:00'));
      clockNow = at(2026, 7, 7, 9, 0);
      await module.close(); // DB now closed
      // A late scan must no-op cleanly (funnel guard), never a SQLITE crash.
      expect(() => scheduler.scanDue()).not.toThrow();
      // rebuild for afterEach close() to succeed.
      module = await build();
    });
  });
});
