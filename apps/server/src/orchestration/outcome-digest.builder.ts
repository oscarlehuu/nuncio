import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';
import { byteLength, truncateHeadBytes, truncateTailBytes } from './byte-truncate';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const SUMMARY_MAX_BYTES = 1024;
const VERIFY_OUTPUT_MAX_BYTES = 512;
/** Matches the events-log per-payload contract; the digest self-enforces it. */
const PAYLOAD_MAX_BYTES = 4096;

/**
 * Strip C0 control characters (U+0000–U+001F) except tab and newline, plus DEL.
 * They are terminal noise in a transcript digest, and each costs 6 bytes as a
 * `\uXXXX` escape once the payload is serialized — stripping them keeps the
 * serialized-byte budget from being dominated by escape inflation. Built from
 * `\u` escapes so no literal control bytes live in this source file. The
 * serialized-byte trim loop below is the actual budget guarantee; this is
 * hygiene.
 */
// eslint-disable-next-line no-control-regex
const C0_CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
function stripControl(text: string): string {
  return text.replace(C0_CONTROL, '');
}

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
    const rawOutput =
      typeof payload.outputTail === 'string' ? stripControl(payload.outputTail) : '';
    const output =
      rawOutput.length > 0 ? truncateHeadBytes(rawOutput, VERIFY_OUTPUT_MAX_BYTES) : undefined;
    return { passed: payload.ok, ...(output !== undefined ? { output } : {}) };
  }
  return null;
}

/**
 * Keep the SERIALIZED digest within the events-log payload budget. All checks
 * measure `byteLength(JSON.stringify(payload))`, not raw string length, because
 * JSON escaping inflates control bytes ~6x and quotes/backslashes 2x. Trims in
 * a fixed order:
 *   1. dirtyFiles entries (preserving the "…and N more" marker),
 *   2. diffStat,
 *   3. the whole workspace + childBranch (unbounded scalars like a giant branch),
 *   4. a convergent loop halving verify.output then outcomeSummary (verify.output
 *      first — the summary is the more valuable field) until they hit zero.
 * With workspace, verify.output, and outcomeSummary all removable, the residual
 * (taskId/status/verify.passed/ids) is ~140 bytes, so the bound holds
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
    const listed = markerAt >= 0 ? files.slice(0, markerAt) : files;
    let hidden = markerAt >= 0 ? Number(files[markerAt]!.match(/\d+/)?.[0] ?? 0) : 0;
    while (over() && listed.length > 0) {
      listed.pop();
      hidden += 1;
      ws.dirtyFiles = [...listed, `…and ${hidden} more`];
    }
  }
  if (!over()) return payload;

  // 2. Drop the diffStat entirely.
  if (payload.workspace?.diffStat) {
    payload.workspace.diffStat = null;
  }
  if (!over()) return payload;

  // 3. Drop the whole workspace — an unbounded scalar (giant branch name) can
  // still overflow after 1–2.
  payload.workspace = null;
  payload.childBranch = null;
  if (!over()) return payload;

  // 4. Convergent final loop on the two large free-text fields. Halve the raw
  // byte budget each pass (UTF-8-boundary-safe) so the SERIALIZED size shrinks;
  // shed verify.output before outcomeSummary, and null a field once it reaches
  // zero. A progress guard breaks the loop if a pass fails to shrink the
  // payload — the only way that happens is corrupted/oversized internal ids
  // (taskId/childSessionId), which are never trimmed (identity) and are not
  // API-injectable; the events repo's 128KiB cap is the outer safety net.
  let verifyBudget = payload.verify?.output ? byteLength(payload.verify.output) : 0;
  let summaryBudget = payload.outcomeSummary ? byteLength(payload.outcomeSummary) : 0;
  while (over() && (verifyBudget > 0 || summaryBudget > 0)) {
    const before = byteLength(JSON.stringify(payload));
    if (verifyBudget > 0 && payload.verify?.output) {
      verifyBudget = Math.floor(verifyBudget / 2);
      if (verifyBudget <= 0) {
        delete (payload.verify as { output?: string }).output;
      } else {
        payload.verify.output = truncateTailBytes(payload.verify.output, verifyBudget);
      }
    } else if (summaryBudget > 0 && payload.outcomeSummary) {
      summaryBudget = Math.floor(summaryBudget / 2);
      payload.outcomeSummary =
        summaryBudget <= 0 ? null : truncateTailBytes(payload.outcomeSummary, summaryBudget);
    }
    // No forward progress this pass → nothing left to trim but the ids. Stop
    // rather than spin (accepts an over-budget payload; see comment above).
    if (byteLength(JSON.stringify(payload)) >= before) break;
  }
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
  const summaryRaw = status === 'CANCELLED' ? null : lastAssistantText(events);
  const summaryText = summaryRaw ? stripControl(summaryRaw) : null;
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
