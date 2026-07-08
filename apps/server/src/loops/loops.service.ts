import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';
import { AgentRegistry } from '../agents/agents.registry';
import { TasksService } from '../tasks/tasks.service';
import { TERMINAL_TASK_STATUSES } from '../tasks/tasks.types';
import { LoopsRepository } from './loops.repository';
import {
  dayBucket,
  failureStreak,
  runsOnDay,
  totalRuns,
  verifyGreenStreak,
} from './loop-accounting';
import { buildRunContext, withRunContext } from './loop-context';
import { computeLoopStats, type LoopStats } from './loop-stats';
import { parseScheduleSpec } from '../scheduler/schedule-spec';
import type { Clock } from '../scheduler/scheduler.types';
import type { TaskDto } from '../tasks/tasks.types';
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_RUNS_PER_DAY,
  type CreateLoopDto,
  type LoopDto,
  type LoopRunDto,
  type LoopRunVerify,
  type StopCondition,
  type UpdateLoopDto,
} from './loops.types';

/** The verify signal a settled task run yields. */
export interface RunOutcome {
  ok: boolean;
  verify: LoopRunVerify;
}

/** Derive the loop-run signal from a settled task's terminal outcome. */
export function outcomeFromTask(task: TaskDto): RunOutcome {
  const outcome = (task.outcome ?? {}) as {
    verify?: { ok?: boolean };
    needsAttention?: unknown;
  };
  const verify: LoopRunVerify =
    outcome.verify === undefined ? 'none' : outcome.verify.ok ? 'green' : 'red';
  // A run is 'ok' only when the task finished DONE and nothing flagged failure:
  // a failing verify, a needs-attention (rung-1 gave up), or a FAILED status.
  const ok =
    task.status === 'DONE' && verify !== 'red' && outcome.needsAttention === undefined;
  return { ok, verify };
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

  /**
   * Engine-id validation seam. Defaults to the injected AgentRegistry; tests can
   * override it directly (like {@link clock}) to avoid pulling the full agent
   * provider graph into a unit spec. Throws BadRequestException on an unknown id.
   */
  assertKnownEngine: (id: string) => void = (id) => {
    if (this.agents) this.agents.get(id);
  };

  /**
   * Model-id validation seam (like {@link assertKnownEngine}, overridable in
   * tests). Default: resolve the effective engine (per-loop engine → project
   * defaultEngine → registry default), then check the model id against that
   * provider's listModels() catalog. Throws BadRequestException on an unknown
   * model or when no engine resolves. No engine branch — the provider's own
   * catalog is the single source of valid model ids.
   */
  assertKnownModel: (
    model: string,
    engine: string | null,
    projectPath: string | null,
  ) => void | Promise<void> = async (model, engine, projectPath) => {
    if (!this.agents) return;
    let engineId =
      engine ??
      (projectPath ? this.projectDefaults?.resolveDefaultEngine(projectPath) : null) ??
      null;
    if (!engineId) {
      try {
        engineId = await this.agents.defaultId();
      } catch {
        throw new BadRequestException(
          `model "${model}" requires a resolvable engine (set the loop engine, a project defaultEngine, or configure a provider)`,
        );
      }
    }
    const provider = this.agents.get(engineId); // 400s on an unknown engine id
    const catalogs = await provider.listModels();
    const known = catalogs.some((entry) =>
      (entry.groups ?? []).some((group) => group.models.some((m) => m.id === model)),
    );
    if (!known) {
      throw new BadRequestException(`unknown model "${model}" for engine "${engineId}"`);
    }
  };

  constructor(
    private readonly loops: LoopsRepository,
    @Optional() private readonly scheduler?: SchedulerService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly projectDefaults?: ProjectDefaultsResolver,
    @Optional() private readonly agents?: AgentRegistry,
  ) {}

  onModuleInit(): void {
    // Resolve a scheduler {kind:'loop',loopId} fire into a budget-checked run.
    this.scheduler?.setLoopFireHandler((loopId) => this.fire(loopId));
    // Fold every settled loop task back into its run + re-evaluate breaker/stop.
    this.tasks?.onTaskFinished((task) => this.onTaskSettled(task));
    // A run left 'pending' by a crash before its task settled is reconciled from
    // the task's now-terminal state (or marked failed if the task vanished).
    this.reconcilePendingRuns();
  }

  /** A task settled — fold it into the matching pending loop-run (by task id). */
  private onTaskSettled(task: TaskDto): void {
    const run = this.findPendingRunByTask(task.id);
    if (!run) return;
    const { ok, verify } = outcomeFromTask(task);
    this.loops.updateRunOutcome(run.id, ok ? 'ok' : 'failed', verify);
    this.evaluate(run.loopId);
  }

  /**
   * Boot reconciliation of runs left `pending` by a crash. Finalize a run ONLY
   * when its task is already TERMINAL (fold the real outcome) or MISSING (the row
   * vanished → count as failed). A still-LIVE task (QUEUED awaiting the pump's
   * re-run, or RUNNING) keeps its run `pending` and settles later through the
   * normal `onTaskFinished` hook — the task lane re-drives a QUEUED task and
   * fails a RUNNING one via its own restart sweep (`failInterrupted`, which runs
   * before this since TasksService is constructed first), each firing the hook.
   * Eagerly failing a live run would corrupt the streak with a phantom failure
   * the later real settlement could never correct.
   */
  reconcilePendingRuns(): void {
    for (const loop of this.loops.list()) {
      for (const run of this.loops.listRuns(loop.id)) {
        if (run.outcome !== 'pending' || !run.taskId) continue;
        const task = this.tasks?.findById(run.taskId);
        if (!task) {
          // Task row vanished across the crash — nothing will ever settle it.
          this.loops.updateRunOutcome(run.id, 'failed', 'none');
        } else if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          // Any terminal status folds (DONE/FAILED/CANCELLED, and any future one).
          // A CANCELLED task is terminal but not DONE → outcomeFromTask yields
          // ok:false, so the run settles failed and stops bricking the overlap guard.
          const { ok, verify } = outcomeFromTask(task);
          this.loops.updateRunOutcome(run.id, ok ? 'ok' : 'failed', verify);
        }
        // else: task is QUEUED/RUNNING — still alive; leave the run pending.
      }
      this.evaluate(loop.id);
    }
  }

  private findPendingRunByTask(taskId: string): LoopRunDto | undefined {
    for (const loop of this.loops.list()) {
      const run = this.loops
        .listRuns(loop.id)
        .find((r) => r.taskId === taskId && r.outcome === 'pending');
      if (run) return run;
    }
    return undefined;
  }

  async create(input: CreateLoopDto): Promise<LoopDto> {
    const goal = input.goal?.trim();
    if (!goal) throw new BadRequestException('loop goal is required');
    const maxRunsPerDay = this.positiveInt(input.maxRunsPerDay, DEFAULT_MAX_RUNS_PER_DAY, 'maxRunsPerDay (budget)');
    const maxConsecutiveFailures = this.positiveInt(
      input.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
      'maxConsecutiveFailures (budget)',
    );
    this.validateStop(input.stop ?? null);
    this.validateSchedule(input.schedule);
    const engine = this.validateEngine(input.engine);

    // The loop OWNS a schedule targeting itself (B's {kind:'loop',loopId} seam).
    // Create the loop first (its id is the schedule target), then the schedule,
    // then link — one sequence at personal scale.
    const projectPath = input.projectPath?.trim() || null;
    const model = await this.validateModel(input.model, engine, projectPath);
    const name = this.normalizeName(input.name);
    const created = this.loops.create({
      name,
      goal,
      scheduleId: 'pending',
      maxRunsPerDay,
      maxConsecutiveFailures,
      stopJson: input.stop ? JSON.stringify(input.stop) : null,
      escalation: 'needs-attention',
      projectPath,
      engine,
      model,
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
    return this.loops.list().map((loop) => this.withSchedule(loop));
  }

  findById(id: string): LoopDto | null {
    const loop = this.loops.findById(id);
    return loop ? this.withSchedule(loop) : null;
  }

  /**
   * Join the owned schedule row so the UI can render the displayable trigger +
   * next fire. A missing/corrupt schedule → `schedule`/`nextFireAt` null (never a
   * throw) so a loop whose schedule vanished still lists.
   */
  private withSchedule(loop: LoopDto): LoopDto {
    let schedule: LoopDto['schedule'] = null;
    let nextFireAt: number | null = null;
    if (loop.scheduleId && loop.scheduleId !== 'pending') {
      try {
        const row = this.scheduler?.getSchedule(loop.scheduleId);
        if (row) {
          schedule = { kind: row.kind, spec: row.spec };
          nextFireAt = row.nextFireAt;
        }
      } catch {
        // Corrupt schedule read — leave nulls, never break the list.
      }
    }
    return { ...loop, schedule, nextFireAt };
  }

  /**
   * A scheduler fire (or manual trigger) resolves loopId → a budget-checked run.
   * Returns the pending run row, or null when skipped (paused/broken/completed or
   * day budget exhausted). The task is enqueued with a FORCED fresh worktree.
   */
  fire(loopId: string): LoopRunDto | null {
    const result = this.fireInternal(loopId);
    return 'run' in result ? result.run : null;
  }

  /**
   * The fire path, reporting WHY it skipped so callers can differentiate: the
   * scheduler ({@link fire}) collapses a skip to null, while a manual fire
   * ({@link fireManual}) maps overlap/budget to a 409. `inactive` covers a
   * missing / paused / broken / completed loop (the scheduler ignores it).
   */
  private fireInternal(
    loopId: string,
  ): { run: LoopRunDto } | { skipped: 'overlap' | 'budget' | 'inactive' } {
    const loop = this.loops.findById(loopId);
    if (!loop || loop.status !== 'active') return { skipped: 'inactive' };

    const runs = this.loops.listRuns(loopId);
    const today = dayBucket(this.clock.now());

    // Overlap guard at the LOOP level (the scheduler's guard only covers the
    // enqueue promise, not task settlement): never stack a new run while the
    // prior one is still unsettled — otherwise the breaker can never trip and
    // pending runs burn the day budget. Skip transparently (no budget consumed,
    // streak-neutral), and settle-then-fire on the next tick.
    if (runs.some((r) => r.outcome === 'pending')) {
      this.loops.appendRun({ loopId, taskId: null, outcome: 'skipped-overlap', dayBucket: today });
      return { skipped: 'overlap' };
    }

    if (runsOnDay(runs, today) >= loop.maxRunsPerDay) {
      this.loops.appendRun({ loopId, taskId: null, outcome: 'budget-exhausted', dayBucket: today });
      return { skipped: 'budget' };
    }

    // Engine resolution: per-loop override → project defaultEngine → (undefined,
    // so the task/session path resolves the registry's AVAILABLE default). No
    // engine branch — an explicit engine is passed through to the runner.
    const provider =
      loop.engine ??
      (loop.projectPath ? this.projectDefaults?.resolveDefaultEngine(loop.projectPath) : null) ??
      undefined;

    // Memories v1: prepend a compact previous-run context block to the goal.
    const context = buildRunContext({
      runs,
      lastVerifyTail: this.lastVerifyTail(runs),
      maxRunsPerDay: loop.maxRunsPerDay,
      now: this.clock.now(),
    });
    const prompt = withRunContext(loop.goal, context);

    // Enqueue a task: goal (+context) as prompt, project scope, FORCED fresh
    // worktree (a loop NEVER runs in-place — locked write policy).
    const task = this.tasks?.enqueue({
      prompt,
      useWorktree: true,
      ...(loop.projectPath ? { projectPath: loop.projectPath } : {}),
      ...(provider ? { provider } : {}),
      // Per-loop model override (validated at create/update); null = provider default.
      ...(loop.model ? { model: loop.model } : {}),
    });

    // Born PENDING — a run must never be born `ok`. Settlement (onTaskSettled /
    // reconcile) finalizes it to ok/failed; the day-budget still counts it.
    const run = this.loops.appendRun({
      loopId,
      taskId: task?.id ?? null,
      outcome: 'pending',
      verify: 'none',
      dayBucket: today,
    });
    return { run };
  }

  /** The most recent settled run's verify output tail, from its task outcome. */
  private lastVerifyTail(runs: LoopRunDto[]): string | null {
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const r = runs[i]!;
      if (r.outcome !== 'ok' && r.outcome !== 'failed') continue;
      if (!r.taskId) return null;
      const task = this.tasks?.findById(r.taskId);
      const verify = (task?.outcome as { verify?: { outputTail?: string } } | undefined)?.verify;
      return verify?.outputTail ?? null;
    }
    return null;
  }

  /**
   * Fold a settled task's outcome into its PENDING run row, then re-evaluate
   * breaker + stop. Correlates by task id. `outcome` is a boolean ok or a full
   * {ok, verify}. Production settlement goes through onTaskSettled; this is the
   * explicit entry point (and what the tests drive).
   */
  recordTaskOutcome(loopId: string, taskId: string, outcome: boolean | RunOutcome): void {
    const resolved: RunOutcome =
      typeof outcome === 'boolean' ? { ok: outcome, verify: outcome ? 'green' : 'red' } : outcome;
    const run = this.loops
      .listRuns(loopId)
      .find((r) => r.taskId === taskId && r.outcome === 'pending');
    if (run) {
      this.loops.updateRunOutcome(run.id, resolved.ok ? 'ok' : 'failed', resolved.verify);
    }
    this.evaluate(loopId);
  }

  pause(id: string): LoopDto {
    const loop = this.loops.findById(id);
    if (!loop) throw new BadRequestException(`Loop ${id} not found`);
    // Only an active loop can be paused. A completed loop must stay completed
    // (never resurrected past its stop); a broken loop is resumed, not paused.
    if (loop.status !== 'active') {
      throw new BadRequestException(`Loop ${id} is ${loop.status}, not pausable`);
    }
    if (loop.scheduleId !== 'pending') this.scheduler?.setEnabled(loop.scheduleId, false);
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

  /** Patch a loop's mutable fields (v1.1). Validates budgets/stop/engine/model. */
  async update(id: string, patch: UpdateLoopDto): Promise<LoopDto> {
    const existing = this.loops.findById(id);
    if (!existing) throw new NotFoundException(`Loop ${id} not found`);
    // A completed loop's config is history — editing it is meaningless (it will
    // never fire again). Active/paused/broken loops are all editable.
    if (existing.status === 'completed') {
      throw new BadRequestException(`Loop ${id} is completed and cannot be edited`);
    }
    const repoPatch: Parameters<LoopsRepository['update']>[1] = {};
    if (patch.name !== undefined) {
      repoPatch.name = this.normalizeName(patch.name);
    }
    if (patch.goal !== undefined) {
      const g = patch.goal.trim();
      if (!g) throw new BadRequestException('goal cannot be empty');
      repoPatch.goal = g;
    }
    if (patch.maxRunsPerDay !== undefined) {
      repoPatch.maxRunsPerDay = this.positiveInt(patch.maxRunsPerDay, existing.maxRunsPerDay, 'maxRunsPerDay (budget)');
    }
    if (patch.maxConsecutiveFailures !== undefined) {
      repoPatch.maxConsecutiveFailures = this.positiveInt(patch.maxConsecutiveFailures, existing.maxConsecutiveFailures, 'maxConsecutiveFailures (budget)');
    }
    if (patch.stop !== undefined) {
      this.validateStop(patch.stop);
      repoPatch.stopJson = patch.stop ? JSON.stringify(patch.stop) : null;
    }
    if (patch.engine !== undefined) {
      repoPatch.engine = this.validateEngine(patch.engine);
      // Engine change without an explicit model key CLEARS the stored model
      // (clear-always): the old model belongs to the old engine's catalog, and
      // keeping it would let the next fire() enqueue an invalid provider/model
      // combo. Matches the UI semantic — picking an engine resets the model to
      // the provider default. An explicit model in the same patch overrides below.
      if (patch.model === undefined) repoPatch.model = null;
    }
    if (patch.model !== undefined) {
      // Validate against the engine as patched in the SAME call, else the stored one.
      const effectiveEngine =
        patch.engine !== undefined ? repoPatch.engine ?? null : existing.engine;
      repoPatch.model = await this.validateModel(patch.model, effectiveEngine, existing.projectPath);
    }
    return this.loops.update(id, repoPatch) ?? existing;
  }

  /** Manual run-now: bypass the schedule, but a manual fire is still a consumed
   *  run subject to the overlap guard + day budget. Only an active loop fires. */
  fireManual(id: string): LoopRunDto {
    const loop = this.loops.findById(id);
    if (!loop) throw new NotFoundException(`Loop ${id} not found`);
    if (loop.status !== 'active') {
      throw new BadRequestException(`Loop ${id} is ${loop.status}, cannot fire`);
    }
    const result = this.fireInternal(id); // same budget/overlap path as the scheduler
    if ('run' in result) return result.run;
    // Nothing was enqueued: a manual fire that skips is a 409, not a silent 200.
    // `inactive` cannot occur here (status checked above) — treat it as overlap-safe.
    const reason = result.skipped === 'budget' ? 'budget' : 'overlap';
    throw new ConflictException({ reason, message: `manual fire skipped (${reason})` });
  }

  /** Fleet loop stats (v1.1) from settled run outcomes only. */
  stats(): LoopStats {
    const loops = this.loops.list();
    const runs = loops.flatMap((l) => this.loops.listRuns(l.id));
    return computeLoopStats(loops, runs, this.clock.now());
  }

  /**
   * Run detail (v1.1): the run row plus joined task/session/verify data. Null-safe
   * on a vanished task. `failureReason` precedence: needs-attention reason →
   * task error → verify red.
   */
  runDetail(loopId: string, runId: string): Record<string, unknown> {
    const run = this.loops.listRuns(loopId).find((r) => r.id === runId);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    const task = run.taskId ? this.tasks?.findById(run.taskId) ?? null : null;
    const outcome = (task?.outcome ?? {}) as {
      verify?: { ok?: boolean; outputTail?: string };
      needsAttention?: { reason?: string };
      error?: string;
    };
    let failureReason: string | null = null;
    if (run.outcome === 'failed') {
      failureReason =
        outcome.needsAttention?.reason ??
        outcome.error ??
        (outcome.verify && outcome.verify.ok === false ? 'verify red' : null);
    }
    const startedAt = task?.startedAt ?? null;
    const settledAt = task?.finishedAt ?? null;
    return {
      ...run,
      sessionId: task?.sessionId ?? null,
      durationMs: startedAt && settledAt ? settledAt - startedAt : null,
      verifyOutputTail: outcome.verify?.outputTail ?? null,
      failureReason,
      startedAt,
      settledAt,
    };
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

  /** Trim a name to a non-empty label, or null (fall back to goal for display). */
  private normalizeName(name: string | null | undefined): string | null {
    if (name === undefined || name === null) return null;
    const trimmed = name.trim();
    return trimmed === '' ? null : trimmed;
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

  /**
   * Validate a per-loop engine override against the AgentRegistry ids. Empty →
   * null (inherit). An unknown engine 400s. No engine branch — the registry is
   * the single source of valid ids.
   */
  private validateEngine(engine: string | null | undefined): string | null {
    if (engine === undefined || engine === null) return null;
    const trimmed = engine.trim();
    if (trimmed === '') return null;
    // Seam throws BadRequestException for an unknown id (default: registry.get).
    this.assertKnownEngine(trimmed);
    return trimmed;
  }

  /**
   * Validate a per-loop model override. Empty/null → null (the resolved engine's
   * default model). A non-null model must be a known model id for the effective
   * engine (loop engine → project defaultEngine → registry default) — the
   * {@link assertKnownModel} seam 400s otherwise.
   */
  private async validateModel(
    model: string | null | undefined,
    engine: string | null,
    projectPath: string | null,
  ): Promise<string | null> {
    if (model === undefined || model === null) return null;
    const trimmed = model.trim();
    if (trimmed === '') return null;
    await this.assertKnownModel(trimmed, engine, projectPath);
    return trimmed;
  }

  /**
   * Validate the trigger BEFORE creating anything — an unparseable spec or
   * unsupported kind must 400, never store an inert active loop that never fires.
   */
  private validateSchedule(schedule: CreateLoopDto['schedule']): void {
    const kind = schedule?.kind;
    const spec = schedule?.spec?.trim();
    if (kind !== 'cron' && kind !== 'heartbeat' && kind !== 'event') {
      throw new BadRequestException(`unsupported schedule kind "${kind}"`);
    }
    if (!spec) throw new BadRequestException('schedule spec is required');
    if (kind === 'event') {
      // Event spec is a JSON filter { event, label? }.
      try {
        const filter = JSON.parse(spec) as { event?: string };
        if (!filter.event) throw new Error('missing event');
      } catch {
        throw new BadRequestException(`invalid event schedule spec "${spec}" (want JSON {event, label?})`);
      }
      return;
    }
    // cron / heartbeat: must parse against the v1 subset (throws BadRequest on typos).
    parseScheduleSpec(spec);
  }
}
