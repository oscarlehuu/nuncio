import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const SUMMARY_MAX_BYTES = 1024;
const VERIFY_OUTPUT_MAX_BYTES = 512;

/** Keep the trailing `maxBytes` bytes of `text`, dropping any partial multi-byte lead. */
function tailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const tail = bytes.slice(bytes.byteLength - maxBytes);
  // A tail slice can start mid-character; fatal:false yields U+FFFD for the
  // broken lead, which we strip so no mojibake reaches the reader.
  return new TextDecoder('utf-8', { fatal: false }).decode(tail).replace(/^�+/, '');
}

/** Keep the leading `maxBytes` bytes, dropping a trailing partial multi-byte sequence. */
function headBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes)).replace(/�+$/, '');
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
    const output =
      typeof payload.outputTail === 'string' && payload.outputTail.length > 0
        ? headBytes(payload.outputTail, VERIFY_OUTPUT_MAX_BYTES)
        : undefined;
    return { passed: payload.ok, ...(output !== undefined ? { output } : {}) };
  }
  return null;
}

/**
 * Build the compact, deterministic digest a parent session receives when one of
 * its subagent tasks reaches a terminal state. No LLM: the summary is the tail
 * of the child's last assistant message. A CANCELLED task carries no summary.
 */
export function buildOutcomeDigest(
  task: TaskDto,
  childSessionId: string | null,
  events: SessionEvent[],
  workspace: WorkspaceSnapshot | null,
): TaskCompletedPayload {
  const status = task.status === 'DONE' || task.status === 'CANCELLED' ? task.status : 'FAILED';
  const summaryText = status === 'CANCELLED' ? null : lastAssistantText(events);
  return {
    taskId: task.id,
    childSessionId,
    status,
    outcomeSummary: summaryText ? tailBytes(summaryText, SUMMARY_MAX_BYTES) : null,
    verify: lastVerify(events),
    workspace,
    childBranch: workspace?.branch ?? null,
  };
}
