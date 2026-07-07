import type { Digest, DigestPushContent, DigestVariant } from './heartbeat.types';

/** Raw inputs buildDigest folds — all sourced from existing durable rows. */
export interface DigestInput {
  /** Loop runs settled within [windowFrom, windowTo). */
  runsOk: number;
  runsFailed: number;
  prsOpened: number;
  /** Attention items raised / resolved within the window. */
  attentionRaised: number;
  attentionResolved: number;
  /** Current open attention count (snapshot). */
  openTopCount: number;
  /** Sessions completed / needing-you within the window (snapshot for needsYou). */
  sessionsCompleted: number;
  sessionsNeedsYou: number;
  /** Today's loop-run budget usage (snapshot). */
  runsToday: number;
  cap: number;
}

/**
 * Pure digest fold over existing data (rung 3 sub-phase B). Deltas are computed
 * for [windowFrom, windowTo); current-state fields (openTopCount, needsYou,
 * budget) are snapshots at windowTo. Never touches the clock or the DB — the
 * caller supplies the window + counts.
 *
 * RED until implemented — neutral TODO so digest-shape tests don't false-green.
 */
export function buildDigest(
  input: DigestInput,
  variant: DigestVariant,
  windowFrom: number,
  windowTo: number,
): Digest {
  return {
    variant,
    windowFrom,
    windowTo,
    loops: {
      runsOk: input.runsOk,
      runsFailed: input.runsFailed,
      prsOpened: input.prsOpened,
    },
    attention: {
      raised: input.attentionRaised,
      resolved: input.attentionResolved,
      openTopCount: input.openTopCount,
    },
    sessions: {
      completed: input.sessionsCompleted,
      needsYou: input.sessionsNeedsYou,
    },
    budget: { runsToday: input.runsToday, cap: input.cap },
  };
}

/**
 * Render a digest into a short phone push (morning = retrospective, evening =
 * pre-flight). Pure. RED until implemented.
 */
export function digestPushContent(digest: Digest, slotKey: string): DigestPushContent {
  const needs = digest.sessions.needsYou + digest.attention.openTopCount;
  if (digest.variant === 'morning') {
    // Retrospective: what shipped overnight, what's blocked, what it cost.
    const title = 'Morning digest';
    const body =
      `${digest.loops.runsOk} shipped · ${needs} needs you · ` +
      `${digest.budget.runsToday} runs today`;
    return { title, body: clamp(body), data: { slotKey } };
  }
  // Evening pre-flight: what's queued for tonight + what's still open.
  const title = 'Evening pre-flight';
  const body =
    `${digest.attention.openTopCount} open · ${digest.loops.runsFailed} failed today · ` +
    `${digest.budget.runsToday}/${digest.budget.cap} runs used`;
  return { title, body: clamp(body), data: { slotKey } };
}

/** A push body is a pointer, not the whole digest — keep it short. */
function clamp(body: string, max = 178): string {
  return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
}
