export interface ParsedTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  toolNames: string[];
}

interface JsonlMessage {
  role?: string;
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string }>;
  };
}

/** Strip Cursor prompt scaffolding from user-visible text. */
export function stripPromptWrappers(text: string): string {
  let out = text.trim();
  const userQueryMatch = out.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (userQueryMatch?.[1]) out = userQueryMatch[1].trim();
  return out;
}

export function parseTranscriptLine(line: string): ParsedTranscriptTurn | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: JsonlMessage;
  try {
    parsed = JSON.parse(trimmed) as JsonlMessage;
  } catch {
    return null;
  }
  if (parsed.role !== 'user' && parsed.role !== 'assistant') return null;

  const content = parsed.message?.content ?? [];
  const textParts: string[] = [];
  const toolNames: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) textParts.push(block.text);
    if (block.type === 'tool_use' && block.name) toolNames.push(block.name);
  }
  const rawText = textParts.join('\n').trim();
  if (!rawText && toolNames.length === 0) return null;

  const text =
    parsed.role === 'user' ? stripPromptWrappers(rawText) : rawText;
  if (!text && toolNames.length === 0) return null;

  return {
    role: parsed.role,
    text,
    toolNames,
  };
}

export function titleFromTurn(turn: ParsedTranscriptTurn): string {
  const line = turn.text.split('\n')[0] ?? 'Imported Cursor chat';
  const cleaned = line.trim() || 'Imported Cursor chat';
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}
