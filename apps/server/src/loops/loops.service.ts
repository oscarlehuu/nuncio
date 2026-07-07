import { BadRequestException, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';
import { TasksService } from '../tasks/tasks.service';
import { LoopsRepository } from './loops.repository';
import {
  dayBucket,
  failureStreak,
  runsOnDay,
  totalRuns,
  verifyGreenStreak,
} from './loop-accounting';
import type { Clock } from '../scheduler/scheduler.types';
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_RUNS_PER_DAY,
  type CreateLoopDto,
  type LoopDto,
  type LoopRunDto,
  type LoopRunVerify,
  type StopCondition,
} from './loops.types';

/** The verify signal a settled task run yields. */
export interface RunOutcome {
  ok: boolean;
  verify: LoopRunVerify;
}

/**
 * The loop primitive (rung 2 sub-phase C): standing tasks firing loop-runs
 * through the scheduler inside run-count budgets + a consecutive-failure breaker,
 * output landing via worktree + PR. All budget/breaker/stop state is DERIVED FROM
 * durable loop_runs rows (restart-safe, no in-memory counters).
 */
@Injectable()
export class LoopsService implements OnModuleInit {
  /** Injectable clock seam — deterministic in tests. */
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly loops: LoopsRepository,
    @Optional() private readonly scheduler?: SchedulerService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly projectDefaults?: ProjectDefaultsResolver,
  ) {}

  onModuleInit(): void {
    // Resolve a scheduler {kind:'loop',loopId} fire into a budget-checked run.
    this.scheduler?.setLoopFireHandler((loopId) => this.fire(loopId));
  }

  create(input: CreateLoopDto): LoopDto {
    const goal = input.goal?.trim();
    if (!goal) throw new BadRequestException('loop goal is required');
    const maxRunsPerDay = this.positiveInt(input.maxRunsPerDay, DEFAULT_MAX_RUNS_PER_DAY, 'maxRunsPerDay (budget)');
    const maxConsecutiveFailures = this.positiveInt(
      input.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
      'maxConsecutiveFailures (budget)',
    );
    this.validateStop(input.stop ?? null);

    // The loop OWNS a schedule targeting itself (B's {kind:'loop',loopId} seam).
    // Create the loop first (its id is the schedule target), then the schedule,
    // then link — one sequence at personal scale.
    const projectPath = input.projectPath?.trim() || null;
    const created = this.loops.create({
      goal,
      scheduleId: 'pending',
      maxRunsPerDay,
      maxConsecutiveFailures,
      stopJson: input.stop ? JSON.stringify(input.stop) : null,
      escalation: 'needs-attention',
      projectPath,
    });
    const schedule = this.scheduler?.create({
      kind: input.schedule.kind,
      spec: input.schedule.spec,
      target: { kind: 'loop', loopId: created.id },
    });
    if (schedule) {
      this.loops.setScheduleId(created.id, schedule.id);
    }
    return this.loops.findById(created.id)!;
  }

  list(): LoopDto[] {
    return this.loops.list();
  }

  findById(id: string): LoopDto | null {
    return this.loops.findById(id);
  }

  /**
   * A scheduler fire (or manual trigger) resolves loopId → a budget-checked run.
   * Returns the pending run row, or null when skipped (paused/broken/completed or
   * day budget exhausted). The task is enqueued with a FORCED fresh worktree.
   */
  fire(loopId: string): LoopRunDto | null {
    const loop = this.loops.findById(loopId);
    if (!loop || loop.status !== 'active') return null;

    const runs = this.loops.listRuns(loopId);
    const today = dayBucket(this.clock.now());
    if (runsOnDay(runs, today) >= loop.maxRunsPerDay) {
      this.loops.appendRun({ loopId, taskId: null, outcome: 'budget-exhausted', dayBucket: today });
      return null;
    }

    // Enqueue a task: goal as prompt, project scope, FORCED fresh worktree (a loop
    // NEVER runs in-place — locked write policy, regardless of project config).
    const provider = loop.projectPath
      ? this.projectDefaults?.resolveDefaultEngine(loop.projectPath) ?? undefined
      : undefined;
    const task = this.tasks?.enqueue({
      prompt: loop.goal,
      useWorktree: true,
      ...(loop.projectPath ? { projectPath: loop.projectPath } : {}),
      ...(provider ? { provider } : {}),
    });

    return this.loops.appendRun({
      loopId,
      taskId: task?.id ?? null,
      outcome: 'ok', // provisional; recordTaskOutcome finalizes on settle
      verify: 'none',
      dayBucket: today,
    });
  }

  /**
   * Fold a settled task's outcome into the run row, then re-evaluate breaker + stop
   * from the durable rows. `outcome` is a boolean ok or a full {ok, verify}.
   */
  recordTaskOutcome(loopId: string, taskId: string, outcome: boolean | RunOutcome): void {
    const resolved: RunOutcome =
      typeof outcome === 'boolean' ? { ok: outcome, verify: outcome ? 'green' : 'red' } : outcome;
    const run = this.loops
      .listRuns(loopId)
      .find((r) => r.taskId === taskId && r.outcome === 'ok' && r.verify === 'none');
    if (run) {
      this.loops.updateRunOutcome(run.id, resolved.ok ? 'ok' : 'failed', resolved.verify);
    }
    this.evaluate(loopId);
  }

  pause(id: string): LoopDto {
    const loop = this.loops.findById(id);
    if (loop && loop.scheduleId !== 'pending') this.scheduler?.setEnabled(loop.scheduleId, false);
    return this.loops.setStatus(id, 'paused');
  }

  resume(id: string): LoopDto {
    const loop = this.loops.findById(id);
    if (!loop) throw new BadRequestException(`Loop ${id} not found`);
    if (loop.status !== 'paused' && loop.status !== 'broken') {
      throw new BadRequestException(`Loop ${id} is ${loop.status}, not resumable`);
    }
    // A 'resume' row is a fold boundary that zeroes both streaks.
    this.loops.appendRun({
      loopId: id,
      taskId: null,
      outcome: 'resume',
      dayBucket: dayBucket(this.clock.now()),
    });
    if (loop.scheduleId !== 'pending') this.scheduler?.setEnabled(loop.scheduleId, true);
    return this.loops.setStatus(id, 'active');
  }

  delete(id: string): void {
    const loop = this.loops.findById(id);
    if (loop && loop.scheduleId !== 'pending') this.scheduler?.deleteSchedule(loop.scheduleId);
    this.loops.delete(id); // run history kept (founder-locked)
  }

  runs(id: string): LoopRunDto[] {
    return this.loops.listRuns(id);
  }

  /** Re-evaluate breaker + stop from durable rows after a settled run. */
  private evaluate(loopId: string): void {
    const loop = this.loops.findById(loopId);
    if (!loop || loop.status !== 'active') return;
    const runs = this.loops.listRuns(loopId);

    // Breaker: consecutive failures reached the threshold → broken.
    if (failureStreak(runs) >= loop.maxConsecutiveFailures) {
      this.trip(loop);
      return;
    }

    // Stop condition satisfied → completed.
    if (this.stopSatisfied(loop.stop, runs)) {
      if (loop.scheduleId !== 'pending') this.scheduler?.setEnabled(loop.scheduleId, false);
      this.loops.setStatus(loopId, 'completed');
    }
  }

  /** Trip the breaker: broken + disable schedule + emit needs-attention. */
  private trip(loop: LoopDto): void {
    if (loop.scheduleId !== 'pending') this.scheduler?.setEnabled(loop.scheduleId, false);
    this.loops.setStatus(loop.id, 'broken');
    // Needs-attention emission (rung-1 vocabulary) — the attention-queue seam.
    this.emitNeedsAttention(loop);
  }

  /** Emit the needs-attention signal for a tripped breaker (rung-3 seam). */
  private emitNeedsAttention(loop: LoopDto): void {
    // v1: the durable 'broken' status IS the attention signal a fleet view reads.
    // A richer event/push emission lands with rung 3; this method is the seam.
    void loop;
  }

  private stopSatisfied(stop: StopCondition, runs: LoopRunDto[]): boolean {
    if (!stop) return false;
    if (stop.kind === 'maxTotalRuns') return totalRuns(runs) >= stop.n;
    if (stop.kind === 'verifyGreenN') return verifyGreenStreak(runs) >= stop.n;
    return false;
  }

  private positiveInt(value: number | undefined, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${label} must be a positive integer`);
    }
    return value;
  }

  private validateStop(stop: StopCondition): void {
    if (stop === null) return;
    if (stop.kind === 'maxTotalRuns' || stop.kind === 'verifyGreenN') {
      if (!Number.isInteger(stop.n) || stop.n <= 0) {
        throw new BadRequestException(`stop condition ${stop.kind} needs a positive integer n`);
      }
      return;
    }
    throw new BadRequestException(`unknown stop condition kind "${(stop as { kind: string }).kind}"`);
  }
}
