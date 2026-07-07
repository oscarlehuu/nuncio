import { byteLength, truncateHeadBytes, truncateTailBytes } from '../orchestration/byte-truncate';
import type { SessionEvent } from '../sessions/domain/sessions.types';

const DEFAULT_BUDGET_BYTES = 4096;
const ASSISTANT_TAIL_BYTES = 512;
const VERIFY_REASON_BYTES = 200;

export interface RenderEventsScope {
  sessionId: string;
  sinceSeq: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Primary path/arg for a tool_start line: file_path | path | cwd, else nothing. */
function toolArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'cwd'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Compact one line for an event, or null when the event type is excluded
 * (deltas, thinking, status, steer_queued, transcript_refreshed) or the payload
 * is malformed. Never throws.
 */
function lineFor(event: SessionEvent): string | null {
  const payload = event.payload;
  switch (event.type) {
    case 'user_message': {
      const text = str((payload as { text?: unknown } | null)?.text);
      return text ? `**User:** ${text}` : null;
    }
    case 'assistant_message': {
      const text = str((payload as { text?: unknown } | null)?.text);
      return text ? `**Assistant:** ${truncateTailBytes(text, ASSISTANT_TAIL_BYTES)}` : null;
    }
    case 'tool_start': {
      const tool = str((payload as { tool?: unknown } | null)?.tool);
      if (!tool) return null;
      const arg = toolArg((payload as { input?: unknown } | null)?.input);
      return arg ? `→ tool ${tool}(${arg})` : `→ tool ${tool}`;
    }
    case 'verify_result': {
      const ok = (payload as { ok?: unknown } | null)?.ok;
      if (typeof ok !== 'boolean') return null;
      if (ok) return '✔ verify passed';
      const reason = str((payload as { outputTail?: unknown } | null)?.outputTail);
      return reason ? `✘ verify failed: ${truncateHeadBytes(reason, VERIFY_REASON_BYTES)}` : '✘ verify failed';
    }
    case 'error': {
      const message = str((payload as { message?: unknown } | null)?.message);
      return message ? `⚠ error: ${message}` : null;
    }
    case 'task_completed': {
      const status = str((payload as { status?: unknown } | null)?.status);
      if (!status) return null;
      const summary = str((payload as { outcomeSummary?: unknown } | null)?.outcomeSummary);
      return summary
        ? `↳ task ${status}: ${truncateTailBytes(summary, ASSISTANT_TAIL_BYTES)}`
        : `↳ task ${status}`;
    }
    default:
      return null; // assistant_delta, thinking_*, status, steer_queued, transcript_refreshed, …
  }
}

/**
 * Render a compact, budgeted, lossy-by-design slice of a session's history —
 * the one sanctioned way to move another session's timeline into a prompt.
 * Included/excluded types per B5; lines are evicted newest-first (oldest lines
 * drop first) to fit `budgetBytes`, with a `_(N earlier events dropped)_` marker
 * and a header. Deterministic and never throws.
 */
export function renderEventsSince(
  events: SessionEvent[],
  budgetBytes: number = DEFAULT_BUDGET_BYTES,
  scope: RenderEventsScope,
): string {
  const header = `## Session ${scope.sessionId} since seq ${scope.sinceSeq} (compacted)`;

  const lines: string[] = [];
  for (const event of events) {
    const line = lineFor(event);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return header;

  // Retain newest-first: keep as many trailing lines as fit, note the drop.
  const kept: string[] = [];
  let used = byteLength(header);
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const cost = byteLength(line) + 1; // +1 for the joining newline
    if (used + cost <= budgetBytes) {
      kept.push(line);
      used += cost;
    } else {
      dropped = i + 1; // everything at or before this index is dropped
      break;
    }
  }
  kept.reverse();

  const parts = [header, ...kept];
  if (dropped > 0) {
    const marker = `_(${dropped} earlier events dropped)_`;
    // The marker is small and important; make room by shedding the oldest kept
    // lines until it fits, so the byte ceiling holds unconditionally.
    let total = byteLength([...parts, marker].join('\n'));
    while (total > budgetBytes && parts.length > 1) {
      parts.splice(1, 1); // drop the oldest kept line
      dropped += 1;
      total = byteLength([header, ...parts.slice(1), `_(${dropped} earlier events dropped)_`].join('\n'));
    }
    parts.push(`_(${dropped} earlier events dropped)_`);
  }
  return parts.join('\n');
}
