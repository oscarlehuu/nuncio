import type { HandoffBrief } from './handoff-brief.types';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const BRIEF_MAX_BYTES = 2048;
const TRUNCATION_MARKER = '_(brief truncated)_';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function workspaceLines(ws: WorkspaceSnapshot): string[] {
  const lines: string[] = [];
  if (ws.branch) lines.push(`- branch: ${ws.branch}`);
  if (ws.headSha) lines.push(`- head: ${ws.headSha}`);
  if (ws.baseBranch) lines.push(`- base: ${ws.baseBranch}`);
  if (ws.dirtyFiles.length) lines.push(`- dirty: ${ws.dirtyFiles.join(', ')}`);
  if (ws.diffStat) lines.push('```', ws.diffStat, '```');
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
      return rendered;
    }
  }
  // Unreachable: the loop always returns on its last iteration.
  return compose(brief, new Set(shedOrder), true);
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
