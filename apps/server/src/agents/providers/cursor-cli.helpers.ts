export type CursorCliStreamEvent =
  | { kind: 'assistant_delta'; delta: string }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'skip' };

interface StreamJsonLine {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  result?: string;
  message?: string;
  error?: string;
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
