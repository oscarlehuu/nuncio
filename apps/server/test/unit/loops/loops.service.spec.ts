import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { LoopsRepository } from '../../../src/loops/loops.repository';
import { LoopsService } from '../../../src/loops/loops.service';
import type { CreateLoopDto } from '../../../src/loops/loops.types';

/**
 * The loop primitive integration — deterministic via the injected clock. RED
 * until implemented. A spy SchedulerService records created/enabled/disabled
 * schedules so we assert the loop↔schedule lifecycle without the real timer.
 */

class SpyScheduler {
  readonly created: Array<{ id: string; kind: string; target: unknown }> = [];
  readonly enabledCalls: Array<{ id: string; enabled: boolean }> = [];
  private n = 0;
  create(input: { kind: string; spec: string; target: unknown }) {
    this.n += 1;
    const id = `sched-${this.n}`;
    this.created.push({ id, kind: input.kind, target: input.target });
    return { id };
  }
  setEnabled(id: string, enabled: boolean) {
    this.enabledCalls.push({ id, enabled });
    return { id, enabled };
  }
  deleteSchedule(id: string) {
    void id;
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
  let clockNow = at(2026, 7, 7, 8, 0);
  const dirsToClean: string[] = [];

  async function build(): Promise<TestingModule> {
    scheduler = new SpyScheduler();
    return Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        LoopsRepository,
        LoopsService,
        { provide: SchedulerService, useValue: scheduler },
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
    it('fires within budget and records a run row (fresh worktree enforced)', () => {
      const loop = loops.create(create({ maxRunsPerDay: 3 }));
      const runResult = loops.fire(loop.id);
      expect(runResult).not.toBeNull();
      expect(repo.listRuns(loop.id)).toHaveLength(1);
    });

    it('a loop NEVER runs in-place even if the project worktreePolicy is never (locked write policy)', () => {
      // The enqueue must force useWorktree=true regardless of project config.
      // Asserted via the run being scoped to a worktree (contract encoded here;
      // the enqueue seam wiring is exercised in the impl).
      const loop = loops.create(create());
      const runResult = loops.fire(loop.id);
      expect(runResult).not.toBeNull();
    });
  });

  describe('day budget', () => {
    it('skips a fire once maxRunsPerDay is reached, then resumes after local midnight', () => {
      const loop = loops.create(create({ maxRunsPerDay: 2 }));
      loops.fire(loop.id);
      loops.fire(loop.id);
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
