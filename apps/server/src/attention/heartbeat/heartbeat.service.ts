import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '../../scheduler/scheduler.types';
import type { DigestVariant, HeartbeatJob } from './heartbeat.types';

/** Bounded run of one layer's work, so a hung layer can never wedge the scan. */
export const DEFAULT_LAYER_TIMEOUT_MS = 10_000;

/**
 * The heartbeat (rung 3, sub-phase B) — 3 rhythm layers riding the rung-2
 * scheduler as `{kind:'system'}` schedules. On boot it ensures the system
 * schedules exist (idempotent, upsert-by-job) and registers the system-fire
 * handler; a fired job dispatches to its layer. Every layer is bounded, closed-
 * guarded, and double-fire idempotent — a fire during shutdown / a duplicate slot
 * / a second reconcile are all safe.
 *
 * RED until implemented — neutral TODO throws, no false greens.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit {
  clock: Clock = { now: () => Date.now() };
  layerTimeoutMs = DEFAULT_LAYER_TIMEOUT_MS;

  /**
   * Layer work seams (settable, like the clock). Wiring binds these to the real
   * infra-checks / reconcile passes / digest send; tests drive them with fakes so
   * dispatch, idempotency, timeout-isolation and closed-guard are unit-testable
   * without the whole module graph.
   */
  onInfra: () => Promise<void> = async () => {};
  onDigest: (variant: DigestVariant) => Promise<void> = async () => {};
  /**
   * The two IDEMPOTENT boot-reconcile passes the hourly layer re-runs. NOTE: the
   * scheduler's own `rehydrate()` is deliberately NOT here — it recomputes
   * next_fire_at and is boot-only; re-running it on a cadence would perturb timing.
   */
  reconcileAttention: () => void = () => {};
  reconcileLoops: () => void = () => {};
  /** Shutdown guard — a fire during a closing DB is a no-op. */
  isClosed: () => boolean = () => false;

  /** Convenience for the dispatch spec: fires both reconcile passes. */
  private onReconcile: () => void = () => {
    this.reconcileAttention();
    this.reconcileLoops();
  };

  onModuleInit(): void {
    // Ensure the 3+1 system schedules (idempotent) + register setSystemFireHandler.
    throw new Error('TODO: HeartbeatService.onModuleInit not implemented');
  }

  /** Route a fired system job to its layer. Never throws into the scheduler scan. */
  async dispatch(job: HeartbeatJob): Promise<void> {
    throw new Error('TODO: HeartbeatService.dispatch not implemented');
    void job;
  }

  /** Layer 1 — infra self-check: fold check results into the attention queue. */
  async runInfraChecks(): Promise<void> {
    throw new Error('TODO: HeartbeatService.runInfraChecks not implemented');
  }

  /** Layer 2 — fleet reconciliation: the two IDEMPOTENT boot passes on a cadence. */
  runFleetReconcile(): void {
    throw new Error('TODO: HeartbeatService.runFleetReconcile not implemented');
  }

  /** Layer 3 — digest: build + send the slot (idempotent; not double-sent). */
  async runDigest(variant: DigestVariant): Promise<void> {
    throw new Error('TODO: HeartbeatService.runDigest not implemented');
    void variant;
  }

  /** Ensure the system schedules exist (idempotent — a reboot never duplicates). */
  ensureSchedules(): void {
    throw new Error('TODO: HeartbeatService.ensureSchedules not implemented');
  }
}
