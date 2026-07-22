import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { truncatePayload } from '../sessions/domain/events.types';
import { decodeNuncioTransportUserText } from '../agents/runtime-user-prompt';

type SessionEventInput = { type: string; payload: unknown };

type LooseMessageEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
};

type TextBlock = { type?: string; text?: unknown };
type ToolCallBlock = { type?: string; id?: unknown; name?: unknown; arguments?: unknown; input?: unknown };

type PendingToolCall = { callId?: string; tool: string };

export function piEntriesToSessionEvents(entries: SessionEntry[]): SessionEventInput[] {
  const events: SessionEventInput[] = [];
  const pendingTools: PendingToolCall[] = [];

  for (const entry of entries as LooseMessageEntry[]) {
    if (entry.type !== 'message') continue;
    const role = entry.message?.role;
    const content = asContentArray(entry.message?.content);

    if (role === 'user') {
      const text = textFromContent(content);
      if (text) {
        events.push({
          type: 'user_message',
          payload: { text: decodeNuncioTransportUserText(text) },
        });
      }
      continue;
    }

    if (role === 'assistant') {
      for (const block of content) {
        if (!isRecord(block)) continue;
        const type = block.type;
        if (type === 'thinking') continue;
        if (type === 'toolCall') {
          const tool = typeof block.name === 'string' && block.name.trim() ? block.name : 'tool';
          const callId = typeof block.id === 'string' && block.id.trim() ? block.id : undefined;
          const rawInput = (block as ToolCallBlock).arguments ?? (block as ToolCallBlock).input;
          const input = parseToolInput(rawInput);
          const payload: Record<string, unknown> = {
            ...(callId ? { callId } : {}),
            tool,
            ...(input !== undefined ? { input: truncatePayload(input).value } : {}),
          };
          events.push({ type: 'tool_start', payload });
          pendingTools.push({ ...(callId ? { callId } : {}), tool });
          continue;
        }
        const blockText = (block as TextBlock).text;
        if (type === 'text' && typeof blockText === 'string') {
          const text = blockText.trim();
          if (text) events.push({ type: 'assistant_message', payload: { text } });
        }
      }
      continue;
    }

    if (role === 'toolResult') {
      const output = textFromContent(content);
      const resultCallId = nonEmptyString(entry.message?.toolCallId);
      const resultTool = nonEmptyString(entry.message?.toolName);
      let pending: PendingToolCall | undefined;
      if (resultCallId) {
        const pendingIndex = pendingTools.findIndex((candidate) => candidate.callId === resultCallId);
        if (pendingIndex >= 0) [pending] = pendingTools.splice(pendingIndex, 1);
      } else {
        pending = pendingTools.shift();
      }
      events.push({
        type: 'tool_end',
        payload: {
          ...(resultCallId || pending?.callId ? { callId: resultCallId ?? pending?.callId } : {}),
          tool: resultTool ?? pending?.tool ?? 'toolResult',
          ...(typeof entry.message?.isError === 'boolean' ? { isError: entry.message.isError } : {}),
          ...(output ? { output: truncatePayload(output).value } : {}),
        },
      });
    }
  }

  return events;
}

function asContentArray(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function textFromContent(content: unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
