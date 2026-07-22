import {
  Injectable,
  type OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import type {
  ScheduleDispatchClaim,
  ScheduleDispatchIntent,
} from './schedule-dispatch-intents.repository';
import { nextFireAfter, parseScheduleSpec } from './schedule-spec';
import { SchedulesRepository } from './schedules.repository';
import type {
  Clock,
  CreateScheduleDto,
  EventFilter,
  LoopTriggerContext,
  ScheduleDto,
  ScheduleKind,
  StaleScheduleSkip,
} from './scheduler.types';
import type { ForgeWebhookEvent } from '../forges/forges.types';

/** How stale a missed slot may be to still fire-once on boot; older = recompute-skip. */
const MISSED_FIRE_WINDOW_MS = 24 * 60 * 60_000;
/** How often the production timer scans for due schedules. */
const SCAN_INTERVAL_MS = 30_000;
/** Backoff after a transient intent settlement/tombstone write failure. */
const DISPATCH_DRAIN_RETRY_MS = 100;
/** Durable ownership window for receipt-less system target execution. */
const SYSTEM_DISPATCH_LEASE_MS = 60_000;
/** Renew well before expiry while a system handler promise remains unsettled. */
const SYSTEM_DISPATCH_HEARTBEAT_MS = 20_000;

/**
 * Daemon-resident firing loop (rung 2 sub-phase B). Scans due cron/heartbeat
 * schedules and matches event schedules against inbound (already de-duplicated)
 * webhook deliveries, firing targets through TasksService — so runner concurrency
 * caps apply. All time flows through the injectable `clock` (deterministic tests).
 * Restart-safe: next_fire_at is recomputed from spec + clock at boot.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  /** Injectable clock seam — overridden in tests for deterministic time. */
  clock: Clock = { now: () => Date.now() };
  /** Timing seams keep lease/heartbeat boundaries deterministic in focused tests. */
  systemDispatchLeaseMs = SYSTEM_DISPATCH_LEASE_MS;
  systemDispatchHeartbeatMs = SYSTEM_DISPATCH_HEARTBEAT_MS;

  /** Schedule ids whose prior fire is still in flight (overlap guard). */
  private readonly inFlight = new Set<string>();
  /** Missed slots keyed by the exact generation/cursor observed during rehydration. */
  private readonly missed = new Map<
    string,
    Pick<ScheduleDto, 'generation' | 'nextFireAt'>
  >();
  /**
   * Schedules whose stored next-fire was older than the missed-fire window on
   * boot (machine offline > 24h): rehydrate skipped them forward. Buffered here
   * until an observer (the heartbeat) drains + surfaces them, so the skip is not
   * silent. Bounded — one entry per stale schedule, cleared on drain.
   */
  private staleSkips: StaleScheduleSkip[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly dispatchDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly systemClaimRenewalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private destroyed = false;
  /**
   * Loop-fire handler, registered by LoopsService — avoids a DI cycle between
   * SchedulerModule and LoopsModule. Resolves a {kind:'loop',loopId} target to a
   * budget-checked loop run.
   */
  private loopFireHandler:
    | ((loopId: string, trigger?: LoopTriggerContext) => unknown)
    | null = null;

  /**
   * System-fire handlers (HeartbeatService + dispatcher, registered to avoid DI cycles).
   * Resolve a {kind:'system',job} target — rung-3/rung-4 system layers.
   */
  private readonly systemFireHandlers = new Set<(job: string) => unknown>();

  constructor(
    private readonly schedules: SchedulesRepository,
    @Optional() private readonly tasks?: TasksService,
  ) {}

  onModuleInit(): void {
    const recoveringSchedules = new Set(
      this.schedules.dispatches.listPending().map((intent) => intent.scheduleId),
    );
    this.rehydrate(recoveringSchedules);
    // The production driver; tests call scanDue() directly with a set clock.
    this.timer = setInterval(() => {
      if (!this.destroyed) this.scanDue();
    }, SCAN_INTERVAL_MS);
    // Don't keep the process alive on the scan tick alone.
    this.timer.unref?.();
  }

  onApplicationBootstrap(): void {
    this.recoverPendingDispatches();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const retry of this.dispatchDrainRetryTimers.values()) clearTimeout(retry);
    this.dispatchDrainRetryTimers.clear();
    for (const renewal of this.systemClaimRenewalTimers.values()) clearInterval(renewal);
    this.systemClaimRenewalTimers.clear();
  }

  /** One schedule by id, or null — for consumers joining schedule data (e.g. loops). */
  getSchedule(id: string): ScheduleDto | null {
    return this.schedules.findById(id);
  }

  /** All schedule rows — used by the heartbeat to ensure-exactly-one system row per job. */
  listSchedules(): ScheduleDto[] {
    return this.schedules.list();
  }

  /**
   * Change a schedule's kind + spec and recompute next fire (used when a heartbeat
   * cadence setting changes, or a loop edits its trigger). Clears any pending
   * missed-fire marker. An `event` kind has no clock fire — computeNextFire yields
   * null, so the row stops being scanned and starts matching webhook deliveries.
   */
  updateSpec(id: string, kind: ScheduleKind, spec: string): void {
    this.missed.delete(id);
    for (;;) {
      const current = this.requireSchedule(id);
      const nextFireAt = this.validatedNextFire(kind, spec, current.enabled);
      if (this.schedules.setSpec(current, kind, spec, nextFireAt)) return;
    }
  }

  create(input: CreateScheduleDto): ScheduleDto {
    const enabled = input.enabled !== false;
    const nextFireAt = this.validatedNextFire(input.kind, input.spec, enabled);
    return this.schedules.create({ ...input, nextFireAt });
  }

  /**
   * Boot rehydration: for each enabled cron/heartbeat schedule recompute the next
   * occurrence from spec + clock. A stored next_fire that passed RECENTLY (within
   * the missed-fire window) is a genuinely missed slot — keep it due and flag it
   * so the next scan fires it once with a 'missed' marker. A stale/garbage value
   * (older than the window, or null) is just recomputed to the future.
   */
  rehydrate(skipScheduleIds: ReadonlySet<string> = new Set()): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    for (const s of this.schedules.list()) {
      if (!s.enabled || skipScheduleIds.has(s.id)) continue;
      if (s.kind !== 'cron' && s.kind !== 'heartbeat') continue;
      const recentlyMissed =
        s.nextFireAt !== null && s.nextFireAt <= now && s.nextFireAt >= now - MISSED_FIRE_WINDOW_MS;
      if (recentlyMissed) {
        // Leave next_fire due. The generation/cursor pair prevents this in-memory
        // marker from leaking onto a concurrently edited schedule revision.
        this.missed.set(s.id, { generation: s.generation, nextFireAt: s.nextFireAt });
        continue;
      }
      const next = this.computeNextFire(s.kind, s.spec, now);
      const advanced = this.schedules.setNextFire(s, next);
      // A next-fire that passed longer ago than the window is a genuinely-skipped
      // slot (machine was offline > 24h). Surface it only if this exact stale
      // generation/cursor won the write; a concurrent edit owns its own cursor.
      if (advanced && s.nextFireAt !== null && s.nextFireAt < now - MISSED_FIRE_WINDOW_MS) {
        this.staleSkips.push({
          scheduleId: s.id,
          kind: s.kind,
          spec: s.spec,
          target: s.target,
          previousFireAt: s.nextFireAt,
          recomputedFireAt: next,
        });
      }
    }
  }

  /**
   * Take and clear the buffered stale-skip records (schedules advanced past a
   * >24h-stale next-fire on boot). The heartbeat drains this once after boot to
   * raise a missed-schedule attention item; a second drain returns empty.
   */
  drainStaleSkips(): StaleScheduleSkip[] {
    const drained = this.staleSkips;
    this.staleSkips = [];
    return drained;
  }

  /** Fire every due schedule once. The single-timer scan; called directly in tests. */
  scanDue(): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    for (const s of this.schedules.listDue(now)) {
      if (this.inFlight.has(s.id)) {
        // The prior fire of THIS schedule is still running — never overlap. A
        // concurrent edit or cursor claim makes this stale snapshot lose cleanly.
        this.schedules.recordFire(s, now, 'skipped-overlap', this.advance(s, now));
        continue;
      }
      const missed = this.missed.get(s.id);
      this.missed.delete(s.id);
      const isMissed = missed?.generation === s.generation
        && missed.nextFireAt === s.nextFireAt;
      this.fire(s, now, isMissed ? 'missed' : 'ok');
    }
  }

  /**
   * Match an inbound (already de-duplicated) webhook event against event schedules.
   * `projectPath` is the local project the delivery's repo resolved to (from the
   * webhook layer). A schedule whose filter is scoped to a project fires ONLY when
   * that project matches — so a same-named event+label on another repo can never
   * fire the wrong loop. An unscoped filter (no projectPath) matches any repo.
   */
  handleWebhookEvent(
    _provider: string,
    event: ForgeWebhookEvent,
    projectPath?: string | null,
  ): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    const trigger = this.triggerContext(event);
    for (const schedule of this.matchingEventSchedules(event, projectPath ?? null)) {
      this.fire(schedule, now, 'ok', trigger);
    }
  }

  /**
   * Webhook acceptance path: persist every matching intent and synchronous target
   * row inside the caller's transaction, but return all drain/pump work as an
   * idempotent continuation that must run only after that transaction commits.
   */
  handleWebhookEventTransactional(
    _provider: string,
    event: ForgeWebhookEvent,
    projectPath?: string | null,
  ): () => void {
    if (this.destroyed) {
      throw new Error('Scheduler is unavailable for transactional webhook dispatch');
    }
    const now = this.clock.now();
    const trigger = this.triggerContext(event);
    const intents = this.matchingEventSchedules(event, projectPath ?? null).map((schedule) =>
      this.persistDispatchIntent(schedule, now, 'ok', trigger),
    );
    const persistTargets = () => {
      for (const intent of intents) this.persistTransactionalTarget(intent);
    };
    const deferred = this.tasks
      ? this.tasks.deferPumpUntilCommit(persistTargets)
      : { result: persistTargets(), afterCommit: () => {} };
    const scheduleIds = new Set(intents.map((intent) => intent.scheduleId));
    let continued = false;
    return () => {
      if (continued) return;
      continued = true;
      try {
        for (const scheduleId of scheduleIds) this.continueDispatchDrain(scheduleId);
      } finally {
        deferred.afterCommit();
      }
    };
  }

  setEnabled(id: string, enabled: boolean): ScheduleDto {
    if (!enabled) this.missed.delete(id);
    for (;;) {
      const current = this.requireSchedule(id);
      const nextFireAt = enabled
        ? this.validatedNextFire(current.kind, current.spec, true)
        : null;
      if (!this.schedules.setEnabled(current, enabled, nextFireAt)) continue;
      return this.requireSchedule(id);
    }
  }

  /** Remove a schedule row (a loop deleting its owned schedule). */
  deleteSchedule(id: string): void {
    this.missed.delete(id);
    this.schedules.delete(id);
  }

  /** Register the loop-fire handler (LoopsService, to avoid a DI cycle). */
  setLoopFireHandler(handler: (loopId: string, trigger?: LoopTriggerContext) => unknown): void {
    this.loopFireHandler = handler;
  }

  /** Register the system-fire handler (HeartbeatService, to avoid a DI cycle). */
  setSystemFireHandler(handler: (job: string) => unknown): void {
    this.systemFireHandlers.add(handler);
  }

  /** Add a system-fire handler without replacing existing handlers. */
  addSystemFireHandler(handler: (job: string) => unknown): void {
    this.systemFireHandlers.add(handler);
  }

  private persistTransactionalTarget(intent: ScheduleDispatchIntent): void {
    const oldest = this.schedules.dispatches.findOldestPending(intent.scheduleId);
    if (oldest?.id !== intent.id) {
      throw new Error(`Schedule ${intent.scheduleId} has an earlier pending dispatch`);
    }

    const target = intent.target;
    let returned: unknown;
    if (target.kind === 'task') {
      if (!this.tasks) throw new Error(`Task dispatch ${intent.id} has no task service`);
      returned = this.schedules.dispatches.withTargetCreation(intent.id, () =>
        this.tasks!.enqueue({ ...target.template, prompt: target.template.prompt }),
      );
    } else if (target.kind === 'loop') {
      if (!this.loopFireHandler) throw new Error(`Loop dispatch ${intent.id} has no loop handler`);
      returned = this.schedules.dispatches.withTargetCreation(intent.id, () =>
        this.loopFireHandler!(target.loopId, intent.trigger ?? undefined),
      );
    } else {
      throw new Error('System targets cannot be accepted from transactional webhooks');
    }

    if (
      returned !== null
      && (typeof returned === 'object' || typeof returned === 'function')
      && typeof (returned as { then?: unknown }).then === 'function'
    ) {
      void Promise.resolve(returned).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[scheduler] rejected asynchronous transactional target ${intent.id}: ${reason}`);
      });
      throw new Error(`Transactional dispatch target ${intent.id} did not persist synchronously`);
    }
    if (!this.schedules.dispatches.settle(intent, null)) {
      throw new Error(`Transactional dispatch intent ${intent.id} could not be completed`);
    }
  }

  /**
   * Fire a schedule's target through TasksService. DB-observable effects (inFlight,
   * recordFire, advance) are applied SYNCHRONOUSLY so `scanDue()` leaves a
   * deterministic state; the enqueue itself is tracked async (its promise governs
   * the overlap window). Never throws — an enqueue failure downgrades the result
   * to `error:<reason>`.
   */
  private fire(
    schedule: ScheduleDto,
    now: number,
    result: 'ok' | 'missed',
    trigger?: LoopTriggerContext,
  ): void {
    if (this.destroyed) return;
    let intent: ScheduleDispatchIntent;
    try {
      intent = this.persistDispatchIntent(schedule, now, result, trigger ?? null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[scheduler] could not persist dispatch intent for ${schedule.id}: ${reason}`);
      return;
    }
    this.continueDispatchDrain(intent.scheduleId);
  }

  private persistDispatchIntent(
    schedule: ScheduleDto,
    now: number,
    result: 'ok' | 'missed',
    trigger: LoopTriggerContext | null,
  ): ScheduleDispatchIntent {
    return this.schedules.dispatches.begin(
      schedule,
      now,
      result,
      this.advance(schedule, now),
      trigger,
    );
  }

  private recoverPendingDispatches(): void {
    const scheduleIds = new Set(
      this.schedules.dispatches.listPending().map((intent) => intent.scheduleId),
    );
    for (const scheduleId of scheduleIds) this.continueDispatchDrain(scheduleId);
  }

  /**
   * Serialize one schedule's durable intents. Only the oldest pending row may own
   * the target at a time; every terminal intent write immediately advances the
   * same drain, so event bursts and restart backlogs cannot strand later rows.
   */
  private drainSchedule(scheduleId: string): void {
    if (this.destroyed || this.inFlight.has(scheduleId)) return;

    while (!this.destroyed && !this.inFlight.has(scheduleId)) {
      const intent = this.schedules.dispatches.findOldestPending(scheduleId);
      if (!intent) return;

      const existing = this.schedules.dispatches.findTargetReceipt(intent);
      if (existing) {
        if (!this.settleDispatch(intent, null)) {
          this.scheduleDispatchDrainRetry(scheduleId);
          return;
        }
        continue;
      }

      const current = this.schedules.findById(intent.scheduleId);
      if (!current || !current.enabled || current.generation !== intent.generation) {
        if (!this.tombstoneDispatch(intent)) {
          this.scheduleDispatchDrainRetry(scheduleId);
          return;
        }
        continue;
      }

      if (intent.target.kind === 'system') {
        const now = this.clock.now();
        const claimed = this.schedules.dispatches.claimSystem(
          intent,
          now,
          this.systemDispatchLeaseMs,
        );
        if (claimed.status === 'in-progress') {
          this.scheduleDispatchDrainRetry(
            scheduleId,
            Math.max(DISPATCH_DRAIN_RETRY_MS, claimed.retryAt - now + 1),
          );
          return;
        }
        if (claimed.status === 'unavailable') continue;
        this.startDispatch(intent, claimed.claim);
        return;
      }

      this.startDispatch(intent);
      return;
    }
  }

  private startDispatch(
    intent: ScheduleDispatchIntent,
    systemClaim: ScheduleDispatchClaim | null = null,
  ): void {
    this.inFlight.add(intent.scheduleId);
    const stopSystemClaimRenewal = systemClaim
      ? this.startSystemClaimRenewal(systemClaim)
      : () => {};
    let pending: Promise<unknown>;
    try {
      const target = intent.target;
      let returned: unknown;
      if (target.kind === 'task') {
        returned = this.schedules.dispatches.withTargetCreation(intent.id, () =>
          this.tasks?.enqueue({ ...target.template, prompt: target.template.prompt }),
        );
      } else if (target.kind === 'loop') {
        returned = this.schedules.dispatches.withTargetCreation(intent.id, () =>
          this.loopFireHandler?.(target.loopId, intent.trigger ?? undefined),
        );
      } else {
        if (!systemClaim) throw new Error(`System dispatch ${intent.id} has no durable claim`);
        returned = Promise.all([...this.systemFireHandlers].map((handler) => handler(target.job)));
      }
      pending = Promise.resolve(returned);
    } catch (error) {
      // A concurrent/re-entrant replay may have won the unique receipt race after
      // our initial lookup. Treat its committed target as this intent's success.
      const receipt = this.schedules.dispatches.findTargetReceipt(intent);
      pending = receipt ? Promise.resolve(receipt) : Promise.reject(error);
    }

    void pending.then(
      () => {
        stopSystemClaimRenewal();
        this.finishDispatch(intent, null, systemClaim);
      },
      (error) => {
        stopSystemClaimRenewal();
        const reason = error instanceof Error ? error.message : String(error);
        this.finishDispatch(intent, `error:${reason.slice(0, 120)}`, systemClaim);
      },
    );
  }

  private finishDispatch(
    intent: ScheduleDispatchIntent,
    errorResult: `error:${string}` | null,
    systemClaim: ScheduleDispatchClaim | null,
  ): void {
    if (this.destroyed) {
      this.inFlight.delete(intent.scheduleId);
      return;
    }
    const settled = this.settleDispatch(intent, errorResult, systemClaim);
    this.inFlight.delete(intent.scheduleId);
    if (settled) this.continueDispatchDrain(intent.scheduleId);
    else this.scheduleDispatchDrainRetry(intent.scheduleId);
  }

  private startSystemClaimRenewal(claim: ScheduleDispatchClaim): () => void {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const timer = this.systemClaimRenewalTimers.get(claim.token);
      if (timer) clearInterval(timer);
      this.systemClaimRenewalTimers.delete(claim.token);
    };
    const heartbeatMs = Number.isFinite(this.systemDispatchHeartbeatMs)
      ? Math.max(1, Math.floor(this.systemDispatchHeartbeatMs))
      : 1;
    const timer = setInterval(() => {
      if (this.destroyed) {
        stop();
        return;
      }
      try {
        if (!this.schedules.dispatches.renewSystemClaim(
          claim,
          this.clock.now(),
          this.systemDispatchLeaseMs,
        )) stop();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[scheduler] could not renew system dispatch ${claim.intentId}: ${reason}`);
      }
    }, heartbeatMs);
    timer.unref?.();
    this.systemClaimRenewalTimers.set(claim.token, timer);
    return stop;
  }

  private continueDispatchDrain(scheduleId: string): void {
    try {
      this.drainSchedule(scheduleId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[scheduler] dispatch drain failed for ${scheduleId}; retrying: ${reason}`);
      this.scheduleDispatchDrainRetry(scheduleId);
    }
  }

  private scheduleDispatchDrainRetry(
    scheduleId: string,
    delayMs = DISPATCH_DRAIN_RETRY_MS,
  ): void {
    if (this.destroyed || this.dispatchDrainRetryTimers.has(scheduleId)) return;
    const retry = setTimeout(() => {
      this.dispatchDrainRetryTimers.delete(scheduleId);
      this.continueDispatchDrain(scheduleId);
    }, Math.max(1, delayMs));
    retry.unref?.();
    this.dispatchDrainRetryTimers.set(scheduleId, retry);
  }

  private tombstoneDispatch(intent: ScheduleDispatchIntent): boolean {
    if (this.destroyed) return false;
    try {
      return this.schedules.dispatches.tombstone(intent, this.clock.now());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[scheduler] could not tombstone dispatch intent ${intent.id}: ${reason}`);
      return false;
    }
  }

  private settleDispatch(
    intent: ScheduleDispatchIntent,
    errorResult: `error:${string}` | null,
    systemClaim: ScheduleDispatchClaim | null = null,
  ): boolean {
    if (this.destroyed) return false;
    try {
      return systemClaim
        ? this.schedules.dispatches.settleSystem(
            intent,
            errorResult,
            systemClaim,
            this.clock.now(),
          )
        : this.schedules.dispatches.settle(intent, errorResult);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[scheduler] could not settle dispatch intent ${intent.id}: ${reason}`);
      return false;
    }
  }

  /** Next fire for a schedule after `now` (null for event schedules / bad specs). */
  private advance(schedule: ScheduleDto, now: number): number | null {
    return this.computeNextFire(schedule.kind, schedule.spec, now);
  }

  private requireSchedule(id: string): ScheduleDto {
    const schedule = this.schedules.findById(id);
    if (!schedule) throw new Error(`Schedule ${id} does not exist`);
    return schedule;
  }

  private validatedNextFire(kind: ScheduleKind, spec: string, enabled: boolean): number | null {
    if (kind === 'event' || !enabled) return null;
    return nextFireAfter(parseScheduleSpec(spec), this.clock.now());
  }

  private computeNextFire(kind: string, spec: string, now: number): number | null {
    if (kind === 'event') return null;
    try {
      return nextFireAfter(parseScheduleSpec(spec), now);
    } catch {
      return null; // unparseable spec — never fired by the clock
    }
  }

  private matchingEventSchedules(
    event: ForgeWebhookEvent,
    projectPath: string | null,
  ): ScheduleDto[] {
    const matches: ScheduleDto[] = [];
    for (const schedule of this.schedules.listEnabledEvents()) {
      let filter: EventFilter;
      try {
        filter = JSON.parse(schedule.spec) as EventFilter;
      } catch {
        continue; // malformed filter — skip, never crash the dispatch
      }
      if (this.eventMatches(filter, event, projectPath)) matches.push(schedule);
    }
    return matches;
  }

  private eventMatches(
    filter: EventFilter,
    event: ForgeWebhookEvent,
    projectPath: string | null,
  ): boolean {
    if (filter.event !== `${event.kind}.${this.effectiveAction(event)}`) return false;
    if (filter.label && !event.labels.includes(filter.label)) return false;
    // Scope guard: a project-scoped filter fires ONLY for its own project.
    if (filter.projectPath && filter.projectPath !== projectPath) return false;
    return true;
  }

  /**
   * The action a loop filter matches on. A GitHub PR merge arrives as
   * `pull_request.closed` with `merged:true` (the parser keeps `closed` so the
   * PR-lifecycle router still sees a close); for loop matching we normalize it to
   * `merged`, so `pull_request.merged` fires on a merge and `pull_request.closed`
   * fires only on a non-merged close — mirroring GitLab's distinct actions.
   */
  private effectiveAction(event: ForgeWebhookEvent): string {
    if (event.kind === 'pull_request' && event.merged === true) return 'merged';
    return event.action;
  }

  /** Minimal identifying context for the triggering issue/PR (loop fires only). */
  private triggerContext(event: ForgeWebhookEvent): LoopTriggerContext {
    const title = event.kind === 'issue' || event.kind === 'pull_request' ? event.title : undefined;
    const url = 'url' in event ? event.url : undefined;
    return {
      kind: event.kind,
      action: this.effectiveAction(event),
      repo: event.repoFullName,
      number: event.number,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
  }
}
