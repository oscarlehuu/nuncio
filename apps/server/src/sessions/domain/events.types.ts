export const DEFAULT_PAYLOAD_MAX_BYTES = 4096;

export type SessionEventType =
  | 'user_message'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_start'
  | 'tool_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_message'
  | 'error'
  | 'status'
  | 'transcript_refreshed'
  | 'steer_message';

export interface ToolStartPayload {
  callId?: string;
  tool: string;
  input?: unknown;
}

export interface ToolEndPayload {
  callId?: string;
  tool: string;
  isError?: boolean;
  output?: unknown;
}

export interface ThinkingStartPayload {
  thinkingId?: string;
}

export interface ThinkingDeltaPayload {
  thinkingId?: string;
  delta: string;
}

export interface ThinkingMessagePayload {
  thinkingId?: string;
  text: string;
}

export interface TruncatedPayload {
  truncated: true;
  preview: string;
}

export function truncatePayload(
  value: unknown,
  maxBytes = DEFAULT_PAYLOAD_MAX_BYTES,
): { value: unknown; truncated: boolean } {
  if (value === undefined || value === null) {
    return { value, truncated: false };
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  const preview = serialized.slice(0, maxBytes);
  return { value: { truncated: true, preview } satisfies TruncatedPayload, truncated: true };
}

export function isToolStartEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'tool_start'; payload: ToolStartPayload } {
  return (
    event.type === 'tool_start' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ToolStartPayload).tool === 'string'
  );
}

export function isToolEndEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'tool_end'; payload: ToolEndPayload } {
  return (
    event.type === 'tool_end' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ToolEndPayload).tool === 'string'
  );
}

export function isThinkingDeltaEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'thinking_delta'; payload: ThinkingDeltaPayload } {
  return (
    event.type === 'thinking_delta' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ThinkingDeltaPayload).delta === 'string'
  );
}
