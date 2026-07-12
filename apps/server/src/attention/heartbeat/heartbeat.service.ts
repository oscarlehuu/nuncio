import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { SettingsService } from '../../settings/settings.service';
import { LoopsService } from '../../loops/loops.service';
import { PushService } from '../../push/push.service';
import { DatabaseService } from '../../db/database.service';
import { ForgeRegistry } from '../../forges/forges.registry';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { TasksService } from '../../tasks/tasks.service';
import { AttentionService } from '../attention.service';
import { AttentionRepository } from '../attention.repository';
import { AttentionCollectors } from '../attention-collectors';
import { buildGlobalTimeline, foldObservabilityRollups } from '../../observability/observability-folds';
import type { ObservabilitySources } from '../../observability/observability.types';
import type { Clock } from '../../scheduler/scheduler.types';
import { DigestRepository } from './digest.repository';
import { InfraChecks } from './infra-checks';
import { buildDigest, digestPushContent, type DigestInput } from './digest';
import { gatherDigestCounts } from './digest-counts';
import type { DigestCounts, DigestVariant, HeartbeatJob, InfraCheckResult } from './heartbeat.types';

/** Bounded run of one layer's work, so a hung layer can never wedge the scan. */
export const DEFAULT_LAYER_TIMEOUT_MS = 10_000;

const EMPTY_COUNTS: DigestCounts = {
  runsOk: 0,
  runsFailed: 0,
  prsOpened: 0,
  attentionRaised: 0,
  attentionResolved: 0,
  sessionsCompleted: 0,
  sessionsNeedsYou: 0,
  runsToday: 0,
  cap: 24,
};

/** The 4 system jobs → their settings-key + variant, ensured on boot. */
const SYSTEM_JOBS: ReadonlyArray<{ job: HeartbeatJob; specKey: string; defaultSpec: string }> = [
  { job: 'infra', specKey: 'NUNCIO_HEARTBEAT_INFRA_SPEC', defaultSpec: 'every:15m' },
  { job: 'reconcile', specKey: 'NUNCIO_HEARTBEAT_RECONCILE_SPEC', defaultSpec: 'every:60m' },
  { job: 'digest-morning', specKey: 'NUNCIO_HEARTBEAT_DIGEST_MORNING', defaultSpec: 'daily@08:00' },
  { job: 'digest-evening', specKey: 'NUNCIO_HEARTBEAT_DIGEST_EVENING', defaultSpec: 'daily@20:00' },
];

/**
 * The heartbeat (rung 3, sub-phase B) — 3 rhythm layers riding the rung-2
 * scheduler as `{kind:'system'}` schedules. On boot it ensures the system
 * schedules exist (idempotent, upsert-by-job) and registers the system-fire
 * handler; a fired job dispatches to its layer. Every layer is bounded, closed-
 * guarded, and double-fire idempotent — a fire during shutdown / a duplicate slot
 * / a second reconcile are all safe. System schedules use a target the loops UI
 * never lists, so they are invisible/unbreakable from there.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit {
  clock: Clock = { now: () => Date.now() };
  layerTimeoutMs = DEFAULT_LAYER_TIMEOUT_MS;

  /**
   * Layer work seams (settable, like the clock). `onModuleInit` binds them to the
   * real collaborators; the unit spec drives them with fakes so dispatch,
   * idempotency, timeout-isolation and closed-guard are testable without the graph.
   */
  onInfra: () => Promise<void> = async () => this.runInfraChecks();
  onDigest: (variant: DigestVariant) => Promise<void> = async (v) => this.runDigest(v);
  reconcileAttention: () => void = () => this.attention?.reconcileOpenItems();
  reconcileLoops: () => void = () => this.loops?.reconcilePendingRuns();
  /**
   * Poll-collector sweep — re-run on the reconcile cadence so a loop that trips or
   * a PR opened AFTER boot enters the queue without a restart (finding #1). Bound
   * to AttentionCollectors.sweep() in onModuleInit.
   */
  onSweep: () => Promise<void> = async () => {};
  /** Window-scoped digest counts from durable rows — bound in onModuleInit. */
  gatherDigestCounts: (from: number, to: number) => DigestCounts = () => EMPTY_COUNTS;
  isClosed: () => boolean = () => this.database?.closed ?? false;

  constructor(
    @Optional() private readonly scheduler?: SchedulerService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly attention?: AttentionService,
    @Optional() private readonly loops?: LoopsService,
    @Optional() private readonly infra?: InfraChecks,
    @Optional() private readonly digests?: DigestRepository,
    @Optional() private readonly push?: PushService,
    @Optional() private readonly database?: DatabaseService,
    @Optional() private readonly forges?: ForgeRegistry,
    @Optional() private readonly sessions?: SessionsRepository,
    @Optional() private readonly events?: EventsRepository,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly collectors?: AttentionCollectors,
    @Optional() private readonly attentionItems?: AttentionRepository,
  ) {}

  onModuleInit(): void {
    this.bindInfraProbes();
    this.bindDataSeams();
    this.scheduler?.setSystemFireHandler((job) => this.dispatch(job as HeartbeatJob));
    this.ensureSchedules();
  }

  /** Bind the sweep + digest-count seams to real collaborators (findings #1, #5). */
  private bindDataSeams(): void {
    if (this.collectors) this.onSweep = () => this.collectors!.sweep();
    this.gatherDigestCounts = (from, to) =>
      gatherDigestCounts(
        {
          loopRuns: this.allLoopRuns(),
          attentionItems: this.attentionItems?.list() ?? [],
          // Archived-INCLUSIVE: a session completed-and-archived before the digest
          // fires is still a completion (finding #3) — list(false) would hide it.
          sessions: this.sessions?.listUserFacing(true) ?? [],
          latestEventAt: (id) => this.events?.latestEventAt(id) ?? null,
          maxRunsPerDay: 24,
        },
        from,
        to,
        this.clock.now(),
      );
  }

  private allLoopRuns() {
    const loops = this.loops?.list() ?? [];
    return loops.flatMap((l) => this.loops!.runs(l.id));
  }

  /**
   * Bind the infra-check data seams to real, provider-neutral sources: CONNECTED
   * forges (registry.available → only those with a resolved credential; absent =
   * unconfigured, never probed) and RUNNING sessions + their last-event time.
   */
  private bindInfraProbes(): void {
    if (!this.infra) return;
    const infraZombieAge = Number(this.settings?.resolve('NUNCIO_HEARTBEAT_ZOMBIE_AGE_MIN'));
    if (Number.isInteger(infraZombieAge) && infraZombieAge > 0) {
      this.infra.zombieAgeMs = infraZombieAge * 60_000;
    }
    if (this.forges) {
      this.infra.connectedForges = async () => {
        const available = await this.forges!.available();
        return available.map((provider) => ({
          id: provider.id,
          probe: async () => {
            await provider.getCurrentUser(); // rejects on 401 / expiry
          },
        }));
      };
    }
    if (this.sessions && this.events) {
      this.infra.runningSessions = () =>
        this.sessions!
          .listUserFacing(false)
          .filter((s) => s.status === 'RUNNING')
          .map((s) => ({
            id: s.id,
            projectPath: s.projectPath ?? null,
            // No event yet → treat the session's own createdAt as the last activity.
            lastEventAt: this.events!.latestEventAt(s.id) ?? s.createdAt,
          }));

      // A zombie item clears once its session leaves RUNNING-and-stale (finding
      // #3): the infra check only enumerates CURRENT running sessions, so a
      // finished/errored session emits no OK signal. This probe lets
      // reconcileOpenItems auto-resolve the stale item. subjectId = 'session:<id>'.
      this.attention?.registerProbe('zombie-session', (item) => {
        const sessionId = item.subjectId.replace(/^session:/, '');
        const session = this.sessions!.findById(sessionId);
        if (!session || session.status !== 'RUNNING') return false; // gone/finished → clear
        const lastEventAt = this.events!.latestEventAt(sessionId) ?? session.createdAt;
        return this.clock.now() - lastEventAt > this.infra!.zombieAgeMs; // still stale?
      });
    }
  }

  /** Route a fired system job to its layer. NEVER throws into the scheduler scan. */
  async dispatch(job: HeartbeatJob): Promise<void> {
    if (this.isClosed()) return; // fire during shutdown → no-op
    try {
      if (job === 'infra') {
        await this.withTimeout(this.onInfra());
      } else if (job === 'reconcile') {
        this.reconcileAttention();
        this.reconcileLoops();
        // Re-run the poll collectors so post-boot loop trips / new PRs enter the
        // queue without a restart (finding #1).
        await this.withTimeout(this.onSweep());
      } else if (job === 'digest-morning') {
        await this.withTimeout(this.onDigest('morning'));
      } else if (job === 'digest-evening') {
        await this.withTimeout(this.onDigest('evening'));
      }
    } catch {
      // A layer failure is recorded via the layer's own paths (attention items /
      // best-effort push); it must never escape into scanDue.
    }
  }

  /**
   * Bound a layer's promise: settle (resolve) at `layerTimeoutMs` even if the work
   * hangs, so the schedule's inFlight releases and the next fire proceeds (finding
   * #2). The underlying work keeps running best-effort; we just stop waiting.
   */
  private withTimeout(work: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.layerTimeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      // Settle on BOTH success and failure — the layer records its own failures;
      // the bounded wrapper only stops waiting and must swallow the rejection so
      // it never surfaces as an unhandled rejection.
      work.then(settle, settle);
    });
  }

  /** Layer 1 — infra self-check: fold check results into the attention queue. */
  async runInfraChecks(): Promise<void> {
    if (!this.infra || !this.attention) return;
    const results = await this.infra.run();
    for (const r of results) this.foldCheck(r);
  }

  /** A failing check raises/updates an item; a passing one clears its condition. */
  private foldCheck(r: InfraCheckResult): void {
    if (!this.attention) return;
    if (r.ok) {
      this.attention.onConditionCleared(r.kind, r.subjectId);
    } else {
      this.attention.raise({
        kind: r.kind,
        subjectId: r.subjectId,
        projectPath: r.projectPath,
        title: r.title,
        payload: r.payload ?? null,
      });
    }
  }

  /** Layer 2 — fleet reconciliation: the two IDEMPOTENT boot passes on a cadence. */
  runFleetReconcile(): void {
    this.reconcileAttention();
    this.reconcileLoops();
  }

  /**
   * Layer 3 — digest: build the slot from since-last data + send once. Slot-keyed
   * on (day, variant): a second fire of the same slot (missed-fire catch-up on
   * boot) is a no-op — the durable marker is the double-send guard.
   */
  async runDigest(variant: DigestVariant): Promise<void> {
    if (!this.digests) return;
    const now = this.clock.now();
    const slotKey = this.slotKey(now, variant);
    if (this.digests.wasSent(slotKey)) return; // already sent this slot

    const windowFrom = this.digests.latest()?.windowTo ?? 0;
    const digest = buildDigest(this.digestInput(windowFrom, now), variant, windowFrom, now);
    this.digests.markSent({ slotKey, variant, sentAt: now, windowFrom, windowTo: now, digest });
    await this.push?.broadcast(digestPushContent(digest, slotKey));
  }

  /**
   * Gather digest inputs from existing durable rows (finding #5): REAL
   * window-scoped counts via the bound `gatherDigestCounts` seam, plus the current
   * open-attention snapshot. Every exposed number is true — never a fake all-clear.
   */
  private digestInput(windowFrom: number, windowTo: number): DigestInput {
    const c = this.gatherDigestCounts(windowFrom, windowTo);
    const openTopCount = this.attention?.list().counts.total ?? 0;
    const observabilitySources = this.observabilitySources();
    const observabilityQuery = { window: { from: windowFrom, to: windowTo }, now: windowTo };
    return {
      runsOk: c.runsOk,
      runsFailed: c.runsFailed,
      prsOpened: c.prsOpened,
      attentionRaised: c.attentionRaised,
      attentionResolved: c.attentionResolved,
      openTopCount,
      sessionsCompleted: c.sessionsCompleted,
      sessionsNeedsYou: c.sessionsNeedsYou,
      runsToday: c.runsToday,
      cap: c.cap,
      timelineEntries: buildGlobalTimeline(observabilitySources, { ...observabilityQuery, limit: 100 }),
      projectRollups: foldObservabilityRollups(observabilitySources, observabilityQuery, 'project'),
    };
  }

  private observabilitySources(): ObservabilitySources {
    const sessions = this.sessions?.listUserFacing(true) ?? [];
    return {
      sessions,
      eventsBySession: Object.fromEntries(
        sessions.map((session) => [session.id, this.events?.list(session.id) ?? []]),
      ),
      tasks: this.tasks?.list() ?? [],
      loopRuns: this.allLoopRuns(),
      attentionItems: this.attentionItems?.list() ?? [],
      digestRuns: this.digests?.list() ?? [],
    };
  }

  private slotKey(now: number, variant: DigestVariant): string {
    const d = new Date(now);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${day}:${variant}`;
  }

  /**
   * Ensure the system schedules exist AND reflect the current cadence settings
   * (idempotent — a reboot never duplicates). Keyed by job: a missing job is
   * created; an EXISTING job whose stored spec differs from the current setting is
   * updated so a NUNCIO_HEARTBEAT_* change takes effect on the next boot (finding
   * #4). A matching spec is left untouched (no needless next-fire reset).
   */
  ensureSchedules(): void {
    if (!this.scheduler || this.isClosed()) return;
    const bySystemJob = new Map<string, { id: string; spec: string }>();
    for (const s of this.scheduler.listSchedules()) {
      if (s.target.kind === 'system') {
        bySystemJob.set((s.target as { kind: 'system'; job: string }).job, { id: s.id, spec: s.spec });
      }
    }
    for (const { job, specKey, defaultSpec } of SYSTEM_JOBS) {
      const spec = this.settings?.resolve(specKey)?.trim() || defaultSpec;
      const kind: 'cron' | 'heartbeat' = spec.startsWith('daily@') ? 'cron' : 'heartbeat';
      const current = bySystemJob.get(job);
      if (!current) {
        this.scheduler.create({ kind, spec, target: { kind: 'system', job } });
      } else if (current.spec !== spec) {
        this.scheduler.updateSpec(current.id, kind, spec);
      }
    }
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
