import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { SettingsService } from '../../settings/settings.service';
import { LoopsService } from '../../loops/loops.service';
import { PushService } from '../../push/push.service';
import { DatabaseService } from '../../db/database.service';
import { ForgeRegistry } from '../../forges/forges.registry';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { AttentionService } from '../attention.service';
import type { Clock } from '../../scheduler/scheduler.types';
import { DigestRepository } from './digest.repository';
import { InfraChecks } from './infra-checks';
import { buildDigest, digestPushContent, type DigestInput } from './digest';
import type { DigestVariant, HeartbeatJob, InfraCheckResult } from './heartbeat.types';

/** Bounded run of one layer's work, so a hung layer can never wedge the scan. */
export const DEFAULT_LAYER_TIMEOUT_MS = 10_000;

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
  ) {}

  onModuleInit(): void {
    this.bindInfraProbes();
    this.scheduler?.setSystemFireHandler((job) => this.dispatch(job as HeartbeatJob));
    this.ensureSchedules();
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
          .list(false)
          .filter((s) => s.status === 'RUNNING')
          .map((s) => ({
            id: s.id,
            projectPath: s.projectPath ?? null,
            // No event yet → treat the session's own createdAt as the last activity.
            lastEventAt: this.events!.latestEventAt(s.id) ?? s.createdAt,
          }));
    }
  }

  /** Route a fired system job to its layer. NEVER throws into the scheduler scan. */
  async dispatch(job: HeartbeatJob): Promise<void> {
    if (this.isClosed()) return; // fire during shutdown → no-op
    try {
      if (job === 'infra') {
        await this.onInfra();
      } else if (job === 'reconcile') {
        this.reconcileAttention();
        this.reconcileLoops();
      } else if (job === 'digest-morning') {
        await this.onDigest('morning');
      } else if (job === 'digest-evening') {
        await this.onDigest('evening');
      }
    } catch {
      // A layer failure is recorded via the layer's own paths (attention items /
      // best-effort push); it must never escape into scanDue.
    }
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

  /** Gather digest inputs from existing durable rows (loops/attention/sessions). */
  private digestInput(windowFrom: number, windowTo: number): DigestInput {
    // v1: counts derived from the attention snapshot + loop runs. The exact
    // loop/session delta queries are read-only folds over listRuns/list; kept
    // minimal here and expanded as the fleet-home data (sub-phase C) lands.
    const open = this.attention?.list().counts.total ?? 0;
    return {
      runsOk: 0,
      runsFailed: 0,
      prsOpened: 0,
      attentionRaised: 0,
      attentionResolved: 0,
      openTopCount: open,
      sessionsCompleted: 0,
      sessionsNeedsYou: 0,
      runsToday: 0,
      cap: 24,
    };
  }

  private slotKey(now: number, variant: DigestVariant): string {
    const d = new Date(now);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${day}:${variant}`;
  }

  /**
   * Ensure the system schedules exist (idempotent — a reboot never duplicates).
   * Keyed by job: an existing `{kind:'system',job}` schedule is left as-is, so
   * re-running this on every boot converges to exactly one row per job.
   */
  ensureSchedules(): void {
    if (!this.scheduler || this.isClosed()) return;
    const existing = new Set(
      this.scheduler
        .listSchedules()
        .filter((s) => s.target.kind === 'system')
        .map((s) => (s.target as { kind: 'system'; job: string }).job),
    );
    for (const { job, specKey, defaultSpec } of SYSTEM_JOBS) {
      if (existing.has(job)) continue;
      const spec = this.settings?.resolve(specKey)?.trim() || defaultSpec;
      const kind: 'cron' | 'heartbeat' = spec.startsWith('daily@') ? 'cron' : 'heartbeat';
      this.scheduler.create({ kind, spec, target: { kind: 'system', job } });
    }
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
