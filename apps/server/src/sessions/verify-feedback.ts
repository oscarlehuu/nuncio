import type { SessionEvent } from './domain/sessions.types';

/**
 * The verify-feedback loop turns a failing post-turn verify into an auto-steer:
 * feed the failure output back to the same session so the agent fixes it, up to
 * N rounds, then surface a needs-attention signal. All loop state is DERIVED FROM
 * THE EVENT LOG (no schema column), so it rebuilds exactly after a restart.
 */

export const DEFAULT_MAX_ROUNDS = 3;

/** `'1'`/`'true'` (case-insensitive) enable; everything else disables. */
export function parseAutoSteerEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Strict non-negative integer, else the default. Deliberately NOT `parseInt`:
 * `parseInt('2.7')` returns 2, which would silently accept a fractional setting.
 */
export function parseMaxRounds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ROUNDS;
  const trimmed = raw.trim();
  // Number('') === 0, so an empty/whitespace setting would silently become
  // max-rounds-0 (loop disabled). Treat blank as invalid → default.
  if (trimmed === '') return DEFAULT_MAX_ROUNDS;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_ROUNDS;
}

export interface VerifyResultPayload {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
  /** Workspace diff fingerprint captured after the command ran (git workspaces only). */
  fingerprint?: string;
  /** Distinct turn-diff classes of the dirty workspace at result time. */
  classes?: string[];
}

/**
 * The skip-on-clean pin: the fingerprint recorded on the LATEST verify_result,
 * but only when that result was green. A newer red result always invalidates
 * the pin so the feedback loop's re-verify semantics stay intact.
 */
export function latestGreenVerifyFingerprint(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'verify_result') continue;
    const payload = event.payload as VerifyResultPayload;
    if (payload.ok !== true) return null;
    return typeof payload.fingerprint === 'string' ? payload.fingerprint : null;
  }
  return null;
}

/** State of the CURRENT verify-feedback loop, folded from the event tail. */
export interface LoopState {
  /** verify_retry markers spent in the current loop. */
  roundsSpent: number;
  /** The most recent failing verify_result of the current loop, if any. */
  lastFail: VerifyResultPayload | null;
  /** Failing outputTails of the current loop, oldest→newest. */
  failTails: string[];
  /** A verify_retry whose auto-steer never followed (crash between marker & steer). */
  danglingRetryId: string | null;
  /** True once this loop has already emitted verify_needs_attention. */
  surfaced: boolean;
}

/**
 * Fold the event log into the current loop's state. The fold walks newest→oldest
 * and stops at the first BOUNDARY (exclusive): a green verify_result, a human
 * (untagged) steer_message, or a verify_needs_attention. Everything above the
 * boundary is a prior loop and does not count.
 */
export function foldLoopState(events: SessionEvent[]): LoopState {
  let boundary = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === 'verify_result' && (e.payload as VerifyResultPayload).ok === true) {
      boundary = i;
      break;
    }
    if (e.type === 'verify_needs_attention') {
      boundary = i;
      break;
    }
    if (e.type === 'steer_message' && (e.payload as { origin?: string }).origin !== 'verify_retry') {
      boundary = i;
      break;
    }
  }

  const scope = events.slice(boundary + 1);
  const failTails: string[] = [];
  const retryIds: string[] = [];
  const steeredRetryIds = new Set<string>();
  let roundsSpent = 0;
  let lastFail: VerifyResultPayload | null = null;

  for (const e of scope) {
    if (e.type === 'verify_result') {
      const p = e.payload as VerifyResultPayload;
      if (p.ok === false) {
        failTails.push(p.outputTail ?? '');
        lastFail = p;
      }
    } else if (e.type === 'verify_retry') {
      roundsSpent += 1;
      const id = (e.payload as { retryId?: string }).retryId;
      if (typeof id === 'string') retryIds.push(id);
    } else if (
      e.type === 'steer_message' &&
      (e.payload as { origin?: string }).origin === 'verify_retry'
    ) {
      const id = (e.payload as { retryId?: string }).retryId;
      if (typeof id === 'string') steeredRetryIds.add(id);
    }
  }

  const danglingRetryId =
    retryIds.find((id) => !steeredRetryIds.has(id)) ?? null;

  return {
    roundsSpent,
    lastFail,
    failTails,
    danglingRetryId,
    surfaced: boundary >= 0 && events[boundary]!.type === 'verify_needs_attention',
  };
}

export type LoopDecision =
  | { kind: 'retry'; round: number }
  | { kind: 'needs_attention'; reason: 'max_rounds' | 'repeated_failure'; rounds: number }
  | { kind: 'none' };

/**
 * Decide the next loop step after a failing verify. Pure over the folded state
 * and the max-rounds budget, so the same decision is reached live or on boot.
 */
export function decideNextStep(state: LoopState, maxRounds: number): LoopDecision {
  if (!state.lastFail) return { kind: 'none' };
  if (state.surfaced) return { kind: 'none' };

  // Futility: after TWO auto-retry rounds, the two most recent failures in this
  // loop are byte-identical → the agent is not making progress, stop early. The
  // roundsSpent>=2 gate is what makes this trip at exactly 2 retries (round 1 and
  // round 2 auto-steer; round 2's identical result trips before round 3).
  const n = state.failTails.length;
  if (
    state.roundsSpent >= 2 &&
    n >= 2 &&
    state.failTails[n - 1] === state.failTails[n - 2]
  ) {
    return { kind: 'needs_attention', reason: 'repeated_failure', rounds: state.roundsSpent };
  }

  if (state.roundsSpent >= maxRounds) {
    return { kind: 'needs_attention', reason: 'max_rounds', rounds: state.roundsSpent };
  }

  return { kind: 'retry', round: state.roundsSpent + 1 };
}

const NO_OUTPUT_NOTE = '(no output captured)';

/** Build the steer text handed to the provider from a failing verify_result. */
export function buildFeedbackMessage(fail: VerifyResultPayload): string {
  const status = fail.timedOut
    ? 'timed out'
    : fail.exitCode !== null
      ? `exit ${fail.exitCode}`
      : 'failed';
  const output = fail.outputTail.trim().length > 0 ? fail.outputTail : NO_OUTPUT_NOTE;
  return [
    `The verify step failed (${status}). Fix the cause and make it pass.`,
    `Command: ${fail.command}`,
    'Output:',
    output,
  ].join('\n');
}
