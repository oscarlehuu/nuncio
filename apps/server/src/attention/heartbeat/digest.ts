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
  throw new Error('TODO: buildDigest not implemented');
  void input;
  void variant;
  void windowFrom;
  void windowTo;
}

/**
 * Render a digest into a short phone push (morning = retrospective, evening =
 * pre-flight). Pure. RED until implemented.
 */
export function digestPushContent(digest: Digest, slotKey: string): DigestPushContent {
  throw new Error('TODO: digestPushContent not implemented');
  void digest;
  void slotKey;
}
