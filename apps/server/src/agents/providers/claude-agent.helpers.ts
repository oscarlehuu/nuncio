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

import type { ClaudeResultMessage, ClaudeStreamEventMessage } from './claude-agent.sdk';

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
          tool: block.name ?? 'tool',
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

/**
 * Classify a terminal `result` message. The SDK reports interrupts and
 * cannot-resume as `error_during_execution` results (not thrown exceptions), so
 * blanket-mapping the error subtype to a failure is wrong: discriminate by
 * `terminal_reason` (an interrupt is a clean stop, session stays alive) and by
 * the `errors[]` text (a moved/evicted workspace yields "No conversation
 * found", a user-actionable cannot-resume — not an internal error).
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

  const cannotResume = (message.errors ?? []).find((error) => error.includes(CANNOT_RESUME_MARKER));
  if (cannotResume) {
    return { kind: 'cannot-resume', message: cannotResume };
  }

  const detail = (message.errors ?? []).join('; ') || message.subtype || 'Claude run failed.';
  return { kind: 'error', message: detail };
}
