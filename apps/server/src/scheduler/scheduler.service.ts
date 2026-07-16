import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { nextFireAfter, parseScheduleSpec } from './schedule-spec';
import { SchedulesRepository } from './schedules.repository';
import type {
  Clock,
  CreateScheduleDto,
  EventFilter,
  ScheduleDto,
  StaleScheduleSkip,
} from './scheduler.types';
import type { ForgeWebhookEvent } from '../forges/forges.types';

/** How stale a missed slot may be to still fire-once on boot; older = recompute-skip. */
const MISSED_FIRE_WINDOW_MS = 24 * 60 * 60_000;
/** How often the production timer scans for due schedules. */
const SCAN_INTERVAL_MS = 30_000;

/**
 * Daemon-resident firing loop (rung 2 sub-phase B). Scans due cron/heartbeat
 * schedules and matches event schedules against inbound (already de-duplicated)
 * webhook deliveries, firing targets through TasksService — so runner concurrency
 * caps apply. All time flows through the injectable `clock` (deterministic tests).
 * Restart-safe: next_fire_at is recomputed from spec + clock at boot.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  /** Injectable clock seam — overridden in tests for deterministic time. */
  clock: Clock = { now: () => Date.now() };

  /** Schedule ids whose prior fire is still in flight (overlap guard). */
  private readonly inFlight = new Set<string>();
  /** Schedule ids that missed a slot during downtime — their next fire records 'missed'. */
  private readonly missed = new Set<string>();
  /**
   * Schedules whose stored next-fire was older than the missed-fire window on
   * boot (machine offline > 24h): rehydrate skipped them forward. Buffered here
   * until an observer (the heartbeat) drains + surfaces them, so the skip is not
   * silent. Bounded — one entry per stale schedule, cleared on drain.
   */
  private staleSkips: StaleScheduleSkip[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /**
   * Loop-fire handler, registered by LoopsService — avoids a DI cycle between
   * SchedulerModule and LoopsModule. Resolves a {kind:'loop',loopId} target to a
   * budget-checked loop run.
   */
  private loopFireHandler: ((loopId: string) => unknown) | null = null;

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
    this.rehydrate();
    // The production driver; tests call scanDue() directly with a set clock.
    this.timer = setInterval(() => {
      if (!this.destroyed) this.scanDue();
    }, SCAN_INTERVAL_MS);
    // Don't keep the process alive on the scan tick alone.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
   * cadence setting changes). Clears any pending missed-fire marker.
   */
  updateSpec(id: string, kind: 'cron' | 'heartbeat', spec: string): void {
    this.missed.delete(id);
    const nextFireAt = this.computeNextFire(kind, spec, this.clock.now());
    this.schedules.setSpec(id, kind, spec, nextFireAt);
  }

  create(input: CreateScheduleDto): ScheduleDto {
    const nextFireAt = this.computeNextFire(input.kind, input.spec, this.clock.now());
    return this.schedules.create({ ...input, nextFireAt });
  }

  /**
   * Boot rehydration: for each enabled cron/heartbeat schedule recompute the next
   * occurrence from spec + clock. A stored next_fire that passed RECENTLY (within
   * the missed-fire window) is a genuinely missed slot — keep it due and flag it
   * so the next scan fires it once with a 'missed' marker. A stale/garbage value
   * (older than the window, or null) is just recomputed to the future.
   */
  rehydrate(): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    for (const s of this.schedules.list()) {
      if (!s.enabled) continue;
      if (s.kind !== 'cron' && s.kind !== 'heartbeat') continue;
      const recentlyMissed =
        s.nextFireAt !== null && s.nextFireAt <= now && s.nextFireAt >= now - MISSED_FIRE_WINDOW_MS;
      if (recentlyMissed) {
        this.missed.add(s.id); // leave next_fire due; scanDue fires it once as 'missed'
        continue;
      }
      const next = this.computeNextFire(s.kind, s.spec, now);
      // A next-fire that passed longer ago than the window is a genuinely-skipped
      // slot (machine was offline > 24h): we advance it silently to the future.
      // Record the skip so an observer can surface it instead of it vanishing.
      if (s.nextFireAt !== null && s.nextFireAt < now - MISSED_FIRE_WINDOW_MS) {
        this.staleSkips.push({
          scheduleId: s.id,
          kind: s.kind,
          spec: s.spec,
          target: s.target,
          previousFireAt: s.nextFireAt,
          recomputedFireAt: next,
        });
      }
      this.schedules.setNextFire(s.id, next);
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
        // The prior fire of THIS schedule is still running — never overlap.
        this.schedules.recordFire(s.id, now, 'skipped-overlap', this.advance(s, now));
        continue;
      }
      const missed = this.missed.delete(s.id);
      this.fire(s, now, missed ? 'missed' : 'ok');
    }
  }

  /** Match an inbound (already de-duplicated) webhook event against event schedules. */
  handleWebhookEvent(_provider: string, event: ForgeWebhookEvent): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    for (const s of this.schedules.listEnabledEvents()) {
      let filter: EventFilter;
      try {
        filter = JSON.parse(s.spec) as EventFilter;
      } catch {
        continue; // malformed filter — skip, never crash the dispatch
      }
      if (this.eventMatches(filter, event)) {
        this.fire(s, now, 'ok');
      }
    }
  }

  setEnabled(id: string, enabled: boolean): ScheduleDto {
    const current = this.schedules.findById(id);
    const nextFireAt = enabled && current ? this.computeNextFire(current.kind, current.spec, this.clock.now()) : null;
    if (!enabled) this.missed.delete(id);
    return this.schedules.setEnabled(id, enabled, nextFireAt);
  }

  /** Remove a schedule row (a loop deleting its owned schedule). */
  deleteSchedule(id: string): void {
    this.missed.delete(id);
    this.schedules.delete(id);
  }

  /** Register the loop-fire handler (LoopsService, to avoid a DI cycle). */
  setLoopFireHandler(handler: (loopId: string) => unknown): void {
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

  /**
   * Fire a schedule's target through TasksService. DB-observable effects (inFlight,
   * recordFire, advance) are applied SYNCHRONOUSLY so `scanDue()` leaves a
   * deterministic state; the enqueue itself is tracked async (its promise governs
   * the overlap window). Never throws — an enqueue failure downgrades the result
   * to `error:<reason>`.
   */
  private fire(schedule: ScheduleDto, now: number, result: 'ok' | 'missed'): void {
    if (this.destroyed) return;
    this.inFlight.add(schedule.id);
    const next = this.advance(schedule, now);
    this.schedules.recordFire(schedule.id, now, result, next);

    // Invoke the target enqueue SYNCHRONOUSLY (so a spy's synchronous push lands
    // before scanDue returns); its return may be a promise (a real/gated runner),
    // which governs the overlap window via inFlight until it settles.
    let pending: Promise<unknown>;
    try {
      const target = schedule.target;
      let returned: unknown;
      if (target.kind === 'task') {
        returned = this.tasks?.enqueue({ ...target.template, prompt: target.template.prompt });
      } else if (target.kind === 'loop') {
        // Loop targets resolve through the registered handler (budget-checked run).
        returned = this.loopFireHandler?.(target.loopId);
      } else if (target.kind === 'system') {
        // System layers (heartbeat, dispatcher) share this seam.
        returned = Promise.all([...this.systemFireHandlers].map((handler) => handler(target.job)));
      }
      pending = Promise.resolve(returned);
    } catch (error) {
      pending = Promise.reject(error);
    }

    void pending
      .catch((error) => {
        if (this.destroyed) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.schedules.recordFire(schedule.id, now, `error:${reason.slice(0, 120)}`, next);
      })
      .finally(() => this.inFlight.delete(schedule.id));
  }

  /** Next fire for a schedule after `now` (null for event schedules / bad specs). */
  private advance(schedule: ScheduleDto, now: number): number | null {
    return this.computeNextFire(schedule.kind, schedule.spec, now);
  }

  private computeNextFire(kind: string, spec: string, now: number): number | null {
    if (kind === 'event') return null;
    try {
      return nextFireAfter(parseScheduleSpec(spec), now);
    } catch {
      return null; // unparseable spec — never fired by the clock
    }
  }

  private eventMatches(filter: EventFilter, event: ForgeWebhookEvent): boolean {
    if (filter.event !== `${event.kind}.${event.action}`) return false;
    if (filter.label && !event.labels.includes(filter.label)) return false;
    return true;
  }
}
