/**
 * Pure SDK-message → nuncio-event mapping for the Claude provider. These
 * functions carry the tricky bits (delta discrimination, glued-text separation,
 * terminal-result classification) so the provider stays a thin lifecycle shell
 * and the mapping is unit-testable without spawning the SDK/CLI.
 *
 * The types below are narrow structural views of the SDK messages — only the
 * fields the mapping reads — so the mapping does not couple to the SDK's deep
 * generated type tree, which churns between releases.
 */

import { normalizeMcpToolName } from '../tools/claude-runtime-tools.adapter';
import type {
  ClaudeResultMessage,
  ClaudeStreamEventMessage,
  ClaudeToolResultBlock,
  ClaudeUserResultMessage,
} from './claude-agent.sdk';

/** One nuncio event the provider should append + emit. */
export interface MappedEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** State threaded across a turn so message-id changes can insert separation. */
export interface DeltaMappingState {
  /** stream_event uuid of the assistant message currently streaming. */
  currentMessageUuid?: string;
  /** Text accumulated so far this turn — the source for the paragraph boundary. */
  accumulatedText: string;
}

export function createDeltaMappingState(): DeltaMappingState {
  return { accumulatedText: '' };
}

/**
 * Map a `stream_event` to a nuncio event. Returns null for events that carry no
 * user-facing delta (message_start, content_block_stop, empty deltas, …).
 *
 * `paragraphBoundary` mirrors BaseAgentProvider.paragraphBoundary — injected so
 * this stays pure. When the assistant message uuid changes mid-turn, the first
 * text delta of the new segment is prefixed with a boundary so consecutive
 * segments render as distinct paragraphs instead of running together.
 */
export function mapStreamEvent(
  message: ClaudeStreamEventMessage,
  state: DeltaMappingState,
  paragraphBoundary: (accumulated: string) => string,
): MappedEvent | null {
  const event = message.event;
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block?.type === 'tool_use' && typeof block.id === 'string') {
      return {
        type: 'tool_start',
        payload: {
          callId: block.id,
          // In-process runtime tools surface as `mcp__<server>__<tool>`; strip the
          // prefix so the transcript shows the bare tool name.
          tool: normalizeMcpToolName(block.name ?? 'tool'),
          ...(block.input !== undefined ? { input: block.input } : {}),
        },
      };
    }
    return null;
  }

  if (event.type !== 'content_block_delta' || !event.delta) return null;
  const delta = event.delta;

  if (delta.type === 'text_delta') {
    const text = delta.text ?? '';
    if (!text) return null;
    const isNewMessage =
      state.currentMessageUuid !== undefined && message.uuid !== state.currentMessageUuid;
    const piece = isNewMessage
      ? `${paragraphBoundary(state.accumulatedText)}${text}`
      : text;
    state.currentMessageUuid = message.uuid;
    state.accumulatedText += piece;
    return { type: 'assistant_delta', payload: { delta: piece } };
  }

  if (delta.type === 'thinking_delta') {
    const text = delta.thinking ?? '';
    if (!text) return null;
    // thinkingId is stable within an assistant message + block; message uuid +
    // block index gives a unique, deterministic id the transcript can group by.
    const thinkingId = `${message.uuid}:${event.index ?? 0}`;
    state.currentMessageUuid = message.uuid;
    return { type: 'thinking_delta', payload: { thinkingId, delta: text } };
  }

  return null;
}

export type ResultClassification =
  | { kind: 'success'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'cannot-resume'; message: string }
  | { kind: 'error'; message: string };

const INTERRUPT_TERMINALS = new Set(['aborted_tools', 'aborted_streaming']);
const CANNOT_RESUME_MARKER = 'No conversation found';
const AUTH_ERROR_MARKERS = ['authentication_error', 'invalid x-api-key', 'invalid api key', 'x-api-key'];

/**
 * User-actionable messages for the SDK's known error result subtypes. The SDK
 * reports these as `result` messages (subtype in the SDKResultError union), not
 * thrown exceptions, so the provider must classify them here. Each message tells
 * the user what happened and what lever they hold; the raw `errors[]` detail is
 * appended when the SDK supplies one.
 */
const ERROR_SUBTYPE_MESSAGES: Record<string, string> = {
  error_max_turns:
    'Claude reached its maximum number of turns for this run before finishing. Send a follow-up to continue.',
  error_max_budget_usd:
    'Claude reached its configured cost limit for this run before finishing. Raise the budget or start a new run to continue.',
  error_max_structured_output_retries:
    'Claude could not produce a valid structured response after several attempts. Retry the request.',
};

/**
 * Classify a terminal `result` message. The SDK reports interrupts, cannot-resume,
 * auth failures, and budget/turn limits as `error_*` results (not thrown
 * exceptions), so blanket-mapping the error subtype to a bare failure is wrong.
 * Discriminate in this order:
 *  - success → authoritative text (fall back to accumulated deltas when empty).
 *  - interrupt terminal (`aborted_tools`/`aborted_streaming`) → clean stop, the
 *    session stays alive (NOT an error).
 *  - `errors[]` text "No conversation found" → cannot-resume (moved/evicted
 *    workspace), a user-actionable resume failure, not an internal error.
 *  - `errors[]` text signalling a bad API key → an auth error the user can fix.
 *  - a known limit subtype (`error_max_turns`/`error_max_budget_usd`/…) → a
 *    user-actionable message plus any SDK detail.
 *  - anything else → ERROR carrying the raw subtype so an unfamiliar failure is
 *    still diagnosable and never swallowed.
 *
 * `accumulatedText` is the fallback terminal text when a success result carries
 * an empty `result` string (e.g. a redirected turn ended before producing text).
 */
export function classifyResult(
  message: ClaudeResultMessage,
  accumulatedText: string,
): ResultClassification {
  if (message.subtype === 'success') {
    const text = (message.result ?? '').length > 0 ? message.result! : accumulatedText;
    return { kind: 'success', text };
  }

  if (message.terminal_reason && INTERRUPT_TERMINALS.has(message.terminal_reason)) {
    return { kind: 'interrupted' };
  }

  const errors = message.errors ?? [];
  const detail = errors.join('; ');
  const detailLower = detail.toLowerCase();

  const cannotResume = errors.find((error) => error.includes(CANNOT_RESUME_MARKER));
  if (cannotResume) {
    return { kind: 'cannot-resume', message: cannotResume };
  }

  if (AUTH_ERROR_MARKERS.some((marker) => detailLower.includes(marker))) {
    return {
      kind: 'error',
      message: `Claude authentication failed. Check ANTHROPIC_API_KEY or re-run \`claude /login\`: ${detail}`,
    };
  }

  const known = ERROR_SUBTYPE_MESSAGES[message.subtype];
  if (known) {
    return { kind: 'error', message: detail ? `${known} (${detail})` : known };
  }

  // Unknown/unexpected subtype: keep the raw subtype in the message so the
  // failure is diagnosable rather than a generic "run failed".
  const message_ = detail
    ? `Claude run failed (${message.subtype}): ${detail}`
    : `Claude run failed (${message.subtype || 'unknown'}).`;
  return { kind: 'error', message: message_ };
}

/** A `tool_end` event derived from a tool_result block, pairing back by callId. */
export interface MappedToolEnd {
  callId: string;
  isError: boolean;
  output?: string;
}

/** Flatten a tool_result block's `content` (string OR blocks array) to text. */
function toolResultOutput(content: ClaudeToolResultBlock['content']): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('');
  return text.length > 0 ? text : undefined;
}

/**
 * Extract `tool_end`s from a `user`-typed SDK message. Tool results arrive on a
 * user frame whose `message.content` is an array of blocks; each `tool_result`
 * block pairs back to a `tool_use.id` (the `callId` a `tool_start` already
 * emitted). Every other content shape — a bare-string user message, a steer
 * echo, an assistant frame replayed as user — yields no ends. The output
 * ceiling is enforced at the event layer, so the raw text passes through here.
 */
export function mapToolResults(message: ClaudeUserResultMessage): MappedToolEnd[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  const ends: MappedToolEnd[] = [];
  for (const block of content as ClaudeToolResultBlock[]) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const output = toolResultOutput(block.content);
    ends.push({
      callId: block.tool_use_id,
      isError: block.is_error === true,
      ...(output !== undefined ? { output } : {}),
    });
  }
  return ends;
}
