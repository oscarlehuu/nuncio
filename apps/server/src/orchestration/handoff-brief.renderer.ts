import { byteLength, truncateHeadBytes } from './byte-truncate';
import type { HandoffBrief } from './handoff-brief.types';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const BRIEF_MAX_BYTES = 2048;
const TRUNCATION_MARKER = '_(brief truncated)_';

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Render workspace lines defensively — persisted data may be structurally
 * malformed (older rows, hand-edited JSON), and rendering must never throw at
 * task-execution time. Any non-conforming field is simply skipped.
 */
function workspaceLines(ws: WorkspaceSnapshot): string[] {
  if (typeof ws !== 'object' || ws === null) return [];
  const lines: string[] = [];
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const branch = str(ws.branch);
  const headSha = str(ws.headSha);
  const baseBranch = str(ws.baseBranch);
  const diffStat = str(ws.diffStat);
  if (branch) lines.push(`- branch: ${branch}`);
  if (headSha) lines.push(`- head: ${headSha}`);
  if (baseBranch) lines.push(`- base: ${baseBranch}`);
  if (Array.isArray(ws.dirtyFiles)) {
    const dirty = ws.dirtyFiles.filter((f): f is string => typeof f === 'string');
    if (dirty.length) lines.push(`- dirty: ${dirty.join(', ')}`);
  }
  if (diffStat) lines.push('```', diffStat, '```');
  return lines;
}

/**
 * Render a brief to plain markdown with a fixed section order. Truncation drops
 * `files`, then `decisions`, then `constraints` (in that order) to fit the
 * 2 KB budget; `goal`, `doneCriteria`, and `verifyCommand` are never dropped.
 * A truncation marker is appended whenever any content was removed.
 */
export function renderHandoffBrief(brief: HandoffBrief): string {
  // Progressive degradation: try full, then shed the cheapest sections first.
  const shedOrder: Array<'files' | 'decisions' | 'constraints'> = [
    'files',
    'decisions',
    'constraints',
  ];

  for (let dropped = 0; dropped <= shedOrder.length; dropped += 1) {
    const omit = new Set(shedOrder.slice(0, dropped));
    // Once we've had to shed anything the reader should know content is missing;
    // likewise if even the fully-shed brief still overflows (a giant goal), the
    // marker is honest about the byte cap even though nothing was dropped here.
    const droppedSomething =
      dropped > 0 &&
      shedOrder.slice(0, dropped).some((key) => (brief[key]?.length ?? 0) > 0);
    const atFloor = dropped === shedOrder.length;
    const overBudgetAtFloor = atFloor && byteLength(compose(brief, omit, false)) > BRIEF_MAX_BYTES;
    const rendered = compose(brief, omit, droppedSomething || overBudgetAtFloor);
    if (byteLength(rendered) <= BRIEF_MAX_BYTES || atFloor) {
      return clampToBudget(rendered);
    }
  }
  // Unreachable: the loop always returns on its last iteration.
  return clampToBudget(compose(brief, new Set(shedOrder), true));
}

/**
 * Final backstop: the shed ladder only drops droppable sections, so protected
 * fields (goal, doneCriteria, verifyCommand) can still push a fully-shed brief
 * over budget. Under the API's per-field caps this is unreachable, but a brief
 * assembled internally or persisted before those caps existed could overflow —
 * hard-truncate on a byte boundary and append the marker so the ceiling holds
 * unconditionally.
 */
function clampToBudget(rendered: string): string {
  if (byteLength(rendered) <= BRIEF_MAX_BYTES) return rendered;
  const suffix = `\n${TRUNCATION_MARKER}`;
  // Head-truncate the body on a clean UTF-8 boundary, leaving room for the marker.
  const body = truncateHeadBytes(rendered, BRIEF_MAX_BYTES - byteLength(suffix));
  return `${body}${suffix}`;
}

function compose(
  brief: HandoffBrief,
  omit: Set<'files' | 'decisions' | 'constraints'>,
  markTruncated: boolean,
): string {
  const parts: string[] = ['## Handoff brief', '', brief.goal];

  if (!omit.has('constraints') && brief.constraints?.length) {
    parts.push('', 'Constraints:', bulletList(brief.constraints));
  }
  if (!omit.has('decisions') && brief.decisions?.length) {
    parts.push('', 'Decisions already made:', bulletList(brief.decisions));
  }
  if (!omit.has('files') && brief.files?.length) {
    parts.push('', 'Start from:', bulletList(brief.files));
  }
  if (brief.workspace) {
    const lines = workspaceLines(brief.workspace);
    if (lines.length) parts.push('', 'Workspace:', ...lines);
  }
  if (brief.doneCriteria?.length) {
    parts.push('', 'Done when:', bulletList(brief.doneCriteria));
  }
  if (brief.verifyCommand) {
    parts.push('', `Verify: \`${brief.verifyCommand}\``);
  }
  if (markTruncated) {
    parts.push('', TRUNCATION_MARKER);
  }
  return parts.join('\n');
}
