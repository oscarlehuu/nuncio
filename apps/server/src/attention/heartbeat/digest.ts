import type { ObservabilityRollupDto, TimelineEntryDto } from '../../observability/observability.types';
import { timelineSignificance } from '../../observability/observability-timeline-significance';
import type { Digest, DigestHighlight, DigestProjectLine, DigestPushContent, DigestVariant } from './heartbeat.types';

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
  /** Global timeline facts already folded by observability for this window. */
  timelineEntries?: TimelineEntryDto[];
  /** Project rollups already folded by observability for this window. */
  projectRollups?: ObservabilityRollupDto[];
  highlightLimit?: number;
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
    highlights: digestHighlights(input.timelineEntries ?? [], input.highlightLimit ?? 5),
    projectLines: digestProjectLines(input.projectRollups ?? []),
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

function digestHighlights(entries: TimelineEntryDto[], limit: number): DigestHighlight[] {
  return [...entries]
    .sort((a, b) => timelineSignificance(b.kind) - timelineSignificance(a.kind) || b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      id: entry.id,
      ts: entry.ts,
      kind: entry.kind,
      title: entry.title,
      projectPath: entry.projectPath,
      provider: entry.provider,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.loopId ? { loopId: entry.loopId } : {}),
      ...(entry.attentionId ? { attentionId: entry.attentionId } : {}),
      ...(entry.prUrl ? { prUrl: entry.prUrl } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.verify ? { verify: entry.verify } : {}),
      ...(entry.severity !== undefined ? { severity: entry.severity } : {}),
    }));
}

function digestProjectLines(rollups: ObservabilityRollupDto[]): DigestProjectLine[] {
  return rollups
    .filter((rollup) => rollup.dimension === 'project')
    .filter((rollup) =>
      rollup.metrics.loops.total > 0 || (rollup.metrics.verify.passed ?? 0) > 0 || rollup.metrics.attention.open > 0,
    )
    .map((rollup) => {
      const runs = rollup.metrics.loops.total;
      const green = rollup.metrics.verify.passed ?? 0;
      const needsYou = rollup.metrics.attention.open;
      return {
        projectPath: rollup.key === 'unassigned' ? null : rollup.key,
        title: `${projectLabel(rollup.key)}: ${runs} runs, ${green} green, ${needsYou} needs you`,
      };
    });
}

function projectLabel(projectPath: string): string {
  if (projectPath === 'unassigned') return 'unassigned';
  return projectPath.split('/').filter(Boolean).at(-1) || projectPath;
}
