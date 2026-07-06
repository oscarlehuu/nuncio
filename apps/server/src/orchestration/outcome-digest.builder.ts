import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';
import { byteLength, truncateHeadBytes, truncateTailBytes } from './byte-truncate';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const SUMMARY_MAX_BYTES = 1024;
const SUMMARY_FLOOR_BYTES = 256;
const VERIFY_OUTPUT_MAX_BYTES = 512;
/** Matches the events-log per-payload contract; the digest self-enforces it. */
const PAYLOAD_MAX_BYTES = 4096;

function lastAssistantText(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'assistant_message') continue;
    const text = (event.payload as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return null;
}

function lastVerify(events: SessionEvent[]): TaskCompletedPayload['verify'] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'verify_result') continue;
    const payload = event.payload as { ok?: unknown; outputTail?: unknown } | null;
    if (!payload || typeof payload.ok !== 'boolean') return null;
    const output =
      typeof payload.outputTail === 'string' && payload.outputTail.length > 0
        ? truncateHeadBytes(payload.outputTail, VERIFY_OUTPUT_MAX_BYTES)
        : undefined;
    return { passed: payload.ok, ...(output !== undefined ? { output } : {}) };
  }
  return null;
}

/**
 * Keep the serialized digest within the events-log payload budget. Trims in a
 * fixed order — dirtyFiles entries (preserving overflow-marker semantics), then
 * diffStat, then outcomeSummary down to a floor. If it still overflows (a
 * pathological scalar such as a giant branch name), the whole workspace and
 * childBranch are dropped as a final backstop — the bound then holds
 * unconditionally. Never touches taskId, status, or verify.passed.
 */
function fitToBudget(payload: TaskCompletedPayload): TaskCompletedPayload {
  const over = () => byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES;
  if (!over()) return payload;

  // 1. Shed dirty files from the tail, keeping/extending the "…and N more" marker.
  if (payload.workspace && payload.workspace.dirtyFiles.length > 0) {
    const ws = payload.workspace;
    const files = [...ws.dirtyFiles];
    const markerAt = files.findIndex((f) => /^…and \d+ more$/.test(f));
    let listed = markerAt >= 0 ? files.slice(0, markerAt) : files;
    let hidden = markerAt >= 0 ? Number(files[markerAt]!.match(/\d+/)?.[0] ?? 0) : 0;
    while (over() && listed.length > 0) {
      listed.pop();
      hidden += 1;
      ws.dirtyFiles = hidden > 0 ? [...listed, `…and ${hidden} more`] : listed;
    }
  }
  if (!over()) return payload;

  // 2. Drop the diffStat entirely.
  if (payload.workspace?.diffStat) {
    payload.workspace.diffStat = null;
  }
  if (!over()) return payload;

  // 3. Shrink the summary toward its floor.
  if (payload.outcomeSummary) {
    let budget = SUMMARY_MAX_BYTES;
    while (over() && budget > SUMMARY_FLOOR_BYTES) {
      budget = Math.max(SUMMARY_FLOOR_BYTES, Math.floor(budget / 2));
      payload.outcomeSummary = truncateTailBytes(payload.outcomeSummary, budget);
    }
  }
  if (!over()) return payload;

  // 4. Backstop: an unbounded scalar (e.g. a giant branch name) can still
  // overflow after the ladder. Drop the whole workspace + childBranch so the
  // budget holds no matter what — the protected fields and floored summary stay.
  payload.workspace = null;
  payload.childBranch = null;
  return payload;
}

/**
 * Build the compact, deterministic digest a parent session receives when one of
 * its subagent tasks reaches a terminal state. No LLM: the summary is the tail
 * of the child's last assistant message. A CANCELLED task carries no summary.
 * The result is guaranteed to serialize within the events-log payload budget.
 */
export function buildOutcomeDigest(
  task: TaskDto,
  childSessionId: string | null,
  events: SessionEvent[],
  workspace: WorkspaceSnapshot | null,
): TaskCompletedPayload {
  const status = task.status === 'DONE' || task.status === 'CANCELLED' ? task.status : 'FAILED';
  const summaryText = status === 'CANCELLED' ? null : lastAssistantText(events);
  // Clone the workspace so budget trimming never mutates the caller's snapshot.
  const workspaceCopy = workspace ? { ...workspace, dirtyFiles: [...workspace.dirtyFiles] } : null;
  const payload: TaskCompletedPayload = {
    taskId: task.id,
    childSessionId,
    status,
    outcomeSummary: summaryText ? truncateTailBytes(summaryText, SUMMARY_MAX_BYTES) : null,
    verify: lastVerify(events),
    workspace: workspaceCopy,
    childBranch: workspaceCopy?.branch ?? null,
  };
  return fitToBudget(payload);
}
