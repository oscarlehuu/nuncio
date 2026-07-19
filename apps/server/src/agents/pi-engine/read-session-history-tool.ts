import { renderEventsSince } from '../../context/events-compactor';
import type { SessionEvent } from '../../sessions/domain/sessions.types';

export const READ_SESSION_HISTORY_TOOL_NAME = 'read_session_history';

/**
 * Re-read this session's own durable history (phase 06,
 * plans/260719-engine-shell-and-compaction). Compaction summaries end with a
 * pointer here: unlike a file-path transcript hint, Nuncio's event log is
 * seekable by `seq` cursor, so the model can pull back exactly the compacted
 * range it needs. Read-only, bounded, session-scoped.
 */

export interface ReadSessionHistoryDeps {
  sessionId: string;
  /** Durable event log read: events with seq > sinceSeq, at most limit rows. */
  listEvents(sinceSeq: number, limit: number): SessionEvent[];
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const OUTPUT_BUDGET_BYTES = 24_576;

const PARAMETERS = {
  type: 'object',
  properties: {
    sinceSeq: {
      type: 'number',
      description: 'Read events with seq greater than this cursor (default 0 = from the start).',
    },
    untilSeq: {
      type: 'number',
      description: 'Stop at this seq (inclusive). Omit to read forward until the limit.',
    },
    types: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional event-type filter, e.g. ["user_message","assistant_message","verify_result"].',
    },
    limit: {
      type: 'number',
      description: `Maximum events to read (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`,
    },
  },
};

function invalid(text: string) {
  return { content: [{ type: 'text', text }], isError: true, details: {} };
}

function optionalNonNegativeInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function buildReadSessionHistoryTool(
  deps: ReadSessionHistoryDeps,
  defineTool?: (tool: unknown) => unknown,
): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: READ_SESSION_HISTORY_TOOL_NAME,
    label: 'Read session history',
    description:
      'Re-read earlier turns of THIS session from the durable Nuncio event log — including turns '
      + 'that were compacted out of your context. Seek by seq cursor; filter by event types; '
      + 'output is a bounded, compacted timeline.',
    promptSnippet:
      'read_session_history: re-read earlier (possibly compacted) turns of this session by seq range.',
    parameters: PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const input = (params ?? {}) as Record<string, unknown>;
      const sinceSeq = optionalNonNegativeInt(input.sinceSeq);
      const untilSeq = optionalNonNegativeInt(input.untilSeq);
      const limit = optionalNonNegativeInt(input.limit);
      if (sinceSeq === null || untilSeq === null || limit === null) {
        return invalid('read_session_history ignored: sinceSeq/untilSeq/limit must be non-negative integers.');
      }
      let types: string[] | undefined;
      if (input.types !== undefined) {
        if (!Array.isArray(input.types) || input.types.some((type) => typeof type !== 'string')) {
          return invalid('read_session_history ignored: types must be an array of event-type strings.');
        }
        types = input.types as string[];
      }

      const effectiveSince = sinceSeq ?? 0;
      const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      let events = deps.listEvents(effectiveSince, effectiveLimit);
      if (untilSeq !== undefined) events = events.filter((event) => event.seq <= untilSeq);
      if (types) {
        const allowed = new Set(types);
        events = events.filter((event) => allowed.has(event.type));
      }
      if (events.length === 0) {
        return {
          content: [{ type: 'text', text: `No events in that range (since seq ${effectiveSince}).` }],
          details: {},
        };
      }
      const text = renderEventsSince(events, OUTPUT_BUDGET_BYTES, {
        sessionId: deps.sessionId,
        sinceSeq: effectiveSince,
      });
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}
