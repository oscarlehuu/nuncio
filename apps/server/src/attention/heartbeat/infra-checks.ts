import { Injectable } from '@nestjs/common';
import type { Clock } from '../../scheduler/scheduler.types';
import type { InfraCheckResult } from './heartbeat.types';

/** Default per-check timeout — a hung probe can never wedge the self-check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2500;
/** Default zombie threshold: RUNNING with no event for this long (founder-tunable). */
export const DEFAULT_ZOMBIE_AGE_MS = 30 * 60 * 1000;

/** A connected forge to probe. `absent` forges are NOT passed in (unconfigured ≠ broken). */
export interface ForgeProbe {
  id: string;
  /** Validity probe (getCurrentUser under the hood): resolves ok, rejects on 401/expiry. */
  probe: () => Promise<void>;
}

/** A RUNNING session + the epoch-ms of its most recent event (for zombie age). */
export interface RunningSession {
  id: string;
  projectPath: string | null;
  lastEventAt: number;
}

/**
 * Layer 1 infra self-check (rung 3 sub-phase B): cheap, BOUNDED probes whose
 * results the heartbeat folds into the attention queue (a failure raises an item;
 * a pass auto-resolves it, respecting sub-phase A suppression). v1 checks:
 *
 *  - credential validity — a CONNECTED forge whose auth probe throws/401 is
 *    expiring/invalid (`credential-expiring`). An ABSENT credential is NOT a
 *    failure (unconfigured ≠ broken) → not supplied here → no item.
 *  - zombie sessions — RUNNING with last-event age STRICTLY > T (`zombie-session`).
 *
 * Every probe runs behind a per-check timeout; a timeout is a check-FAILED result
 * for THAT check only (Promise.allSettled), never a wedge.
 *
 * Seams (settable fields, like the loops/attention clock seam) keep this unit-
 * testable without the forge/session module graph. RED until implemented.
 */
@Injectable()
export class InfraChecks {
  clock: Clock = { now: () => Date.now() };
  checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  zombieAgeMs = DEFAULT_ZOMBIE_AGE_MS;

  /** Test/wiring seam: the connected forges to validity-probe. */
  connectedForges: () => Promise<ForgeProbe[]> = async () => [];
  /** Test/wiring seam: the currently-RUNNING sessions + their last-event time. */
  runningSessions: () => RunningSession[] = () => [];

  /** Run every v1 check; one result per condition (ok or failing). */
  async run(): Promise<InfraCheckResult[]> {
    throw new Error('TODO: InfraChecks.run not implemented');
  }

  /** Credential validity for connected forges (absent forges are never supplied). */
  async checkCredentials(): Promise<InfraCheckResult[]> {
    throw new Error('TODO: InfraChecks.checkCredentials not implemented');
  }

  /** Zombie sessions: RUNNING with last-event age STRICTLY greater than T. */
  checkZombieSessions(): InfraCheckResult[] {
    throw new Error('TODO: InfraChecks.checkZombieSessions not implemented');
  }
}
