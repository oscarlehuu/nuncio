import { useMemo } from 'react';
import type { SessionEvent } from './api';

/** Rough chars-per-token estimate for English + code text. */
const CHARS_PER_TOKEN = 4;
/** Default context window when model metadata doesn't expose one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ContextBreakdownItem {
  label: string;
  tokens: number;
  color: string;
}

export interface ContextUsage {
  total: number;
  window: number;
  percentage: number;
  breakdown: ContextBreakdownItem[];
}

const COLORS = {
  conversation: '#60a5fa',
  tools: '#a78bfa',
  thinking: '#fbbf24',
  context: '#34d399',
  system: '#94a3b8',
};

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function payloadSize(payload: Record<string, unknown>): number {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return 0;
  }
}

/** Estimated overhead breakdown for system-level context. */
const SYSTEM_PROMPT_TOKENS = 5_000;
const TOOL_DEFINITIONS_TOKENS = 13_000;
const RULES_TOKENS = 27_000;
const SKILLS_TOKENS = 3_000;

export function calculateContextUsage(events: SessionEvent[], contextWindow?: number): ContextUsage {
    let conversation = 0;
    let tools = 0;
    let thinking = 0;
    let context = 0;

    for (const event of events) {
      const p = event.payload ?? {};
      switch (event.type) {
        case 'user_message':
          conversation += estimateTokens(String(p.text ?? ''));
          break;
        case 'assistant_delta':
          conversation += estimateTokens(String(p.delta ?? ''));
          break;
        case 'assistant_message':
          conversation += estimateTokens(String(p.text ?? ''));
          break;
        case 'tool_start':
        case 'tool_end':
          tools += Math.ceil(payloadSize(p) / CHARS_PER_TOKEN);
          break;
        case 'thinking_delta':
          thinking += estimateTokens(String(p.delta ?? ''));
          break;
        case 'thinking_message':
          thinking += estimateTokens(String(p.text ?? ''));
          break;
        case 'transcript_refreshed':
          context += Math.ceil(payloadSize(p) / CHARS_PER_TOKEN);
          break;
        default:
          break;
      }
    }

    const total = conversation + tools + thinking + context + SYSTEM_PROMPT_TOKENS + TOOL_DEFINITIONS_TOKENS + RULES_TOKENS + SKILLS_TOKENS;
    const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
    const percentage = Math.min(100, Math.round((total / window) * 100));

    const breakdown: ContextBreakdownItem[] = [
      { label: 'Conversation', tokens: conversation, color: COLORS.conversation },
      { label: 'Tool calls', tokens: tools, color: COLORS.tools },
      { label: 'Thinking', tokens: thinking, color: COLORS.thinking },
      { label: 'Context', tokens: context, color: COLORS.context },
      { label: 'System prompt', tokens: SYSTEM_PROMPT_TOKENS, color: COLORS.system },
      { label: 'Tool definitions', tokens: TOOL_DEFINITIONS_TOKENS, color: '#c084fc' },
      { label: 'Rules', tokens: RULES_TOKENS, color: '#34d399' },
      { label: 'Skills', tokens: SKILLS_TOKENS, color: '#fb923c' },
    ].filter((item) => item.tokens > 0);

    return { total, window, percentage, breakdown };
}

export function useContextUsage(events: SessionEvent[], contextWindow?: number): ContextUsage {
  return useMemo(() => calculateContextUsage(events, contextWindow), [events, contextWindow]);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export { formatTokens };
