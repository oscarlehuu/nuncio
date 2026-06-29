import { truncatePayload } from '../../sessions/domain/events.types';

export type CursorCliStreamEvent =
  | { kind: 'assistant_delta'; delta: string }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'tool_start'; callId: string; tool: string; input?: unknown }
  | { kind: 'tool_end'; callId: string; tool: string; isError?: boolean; output?: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'skip' };

interface StreamJsonLine {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  call_id?: string;
  result?: string;
  message?: string;
  error?: string;
  tool_call?: Record<string, unknown>;
}

export function parseCursorCliStreamLine(line: string): CursorCliStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'skip' };

  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(trimmed) as StreamJsonLine;
  } catch {
    return { kind: 'skip' };
  }

  if (parsed.type === 'assistant') {
    const text = extractAssistantText(parsed);
    if (!text) return { kind: 'skip' };
    if (parsed.timestamp_ms != null && parsed.model_call_id == null) {
      return { kind: 'assistant_delta', delta: text };
    }
    return { kind: 'skip' };
  }

  if (parsed.type === 'tool_call') {
    const callId = parsed.call_id?.trim();
    if (!callId) return { kind: 'skip' };
    const tool = extractCliToolName(parsed.tool_call);
    if (parsed.subtype === 'started') {
      const input = extractCliToolInput(parsed.tool_call);
      const truncatedInput = input !== undefined ? truncatePayload(input).value : undefined;
      return {
        kind: 'tool_start',
        callId,
        tool,
        ...(truncatedInput !== undefined ? { input: truncatedInput } : {}),
      };
    }
    if (parsed.subtype === 'completed') {
      const output = extractCliToolOutput(parsed.tool_call);
      const truncatedOutput = output !== undefined ? truncatePayload(output).value : undefined;
      return {
        kind: 'tool_end',
        callId,
        tool,
        isError: extractCliToolIsError(parsed.tool_call),
        ...(truncatedOutput !== undefined ? { output: truncatedOutput } : {}),
      };
    }
    return { kind: 'skip' };
  }

  if (parsed.type === 'result') {
    if (parsed.subtype === 'success' && parsed.result) {
      return { kind: 'assistant_message', text: parsed.result };
    }
    if (parsed.subtype === 'error') {
      return { kind: 'error', message: parsed.error ?? parsed.result ?? 'Cursor CLI run failed' };
    }
  }

  if (parsed.type === 'error') {
    return { kind: 'error', message: parsed.message ?? parsed.error ?? 'Cursor CLI error' };
  }

  return { kind: 'skip' };
}

/** Normalize CLI nested key like readToolCall → read. */
export function extractCliToolName(toolCall: Record<string, unknown> | undefined): string {
  if (!toolCall) return 'unknown';
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith('ToolCall')) {
      const base = key.slice(0, -'ToolCall'.length);
      return base ? base.toLowerCase() : 'unknown';
    }
  }
  return 'unknown';
}

function extractCliToolPayload(toolCall: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!toolCall) return undefined;
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith('ToolCall') && typeof toolCall[key] === 'object' && toolCall[key] !== null) {
      return toolCall[key] as Record<string, unknown>;
    }
  }
  return undefined;
}

function extractCliToolInput(toolCall: Record<string, unknown> | undefined): unknown {
  return extractCliToolPayload(toolCall)?.args;
}

function extractCliToolOutput(toolCall: Record<string, unknown> | undefined): unknown {
  const payload = extractCliToolPayload(toolCall);
  if (!payload) return undefined;
  if ('result' in payload) return payload.result;
  if ('error' in payload) return payload.error;
  return undefined;
}

function extractCliToolIsError(toolCall: Record<string, unknown> | undefined): boolean {
  const payload = extractCliToolPayload(toolCall);
  if (!payload) return false;
  if (payload.error !== undefined) return true;
  const result = payload.result;
  if (typeof result === 'object' && result !== null && 'error' in (result as Record<string, unknown>)) {
    return true;
  }
  return false;
}

function extractAssistantText(parsed: StreamJsonLine): string {
  const content = (parsed as { message?: { content?: Array<{ type?: string; text?: string }> } })
    .message?.content;
  if (!content) return '';
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!)
    .join('');
}

export interface CursorCliSpawnArgs {
  agentBin: string;
  workspace: string;
  chatId: string;
  message: string;
}

export function buildCursorCliArgs(input: CursorCliSpawnArgs): string[] {
  return [
    '-p',
    '--trust',
    '--force',
    '--workspace',
    input.workspace,
    '--resume',
    input.chatId,
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    input.message,
  ];
}

export function resolveCursorAgentBin(
  settingValue: string | undefined,
  pathEnv: string | undefined,
  homeDir: string,
): string | null {
  const candidates: string[] = [];
  if (settingValue?.trim()) candidates.push(settingValue.trim());
  candidates.push(`${homeDir}/.local/bin/agent`);
  if (pathEnv) {
    for (const dir of pathEnv.split(':')) {
      if (dir) candidates.push(`${dir}/agent`);
    }
  }
  return candidates[0] ?? null;
}
