export type AgentRuntimeToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AgentRuntimeToolResult {
  content: AgentRuntimeToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type AgentRuntimeToolOutput = string | AgentRuntimeToolResult;

export interface AgentRuntimeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): AgentRuntimeToolOutput | Promise<AgentRuntimeToolOutput>;
}

export interface AgentRuntimeTools {
  systemPromptAppend?: string;
  tools: AgentRuntimeTool[];
}

export function normalizeAgentRuntimeToolResult(output: AgentRuntimeToolOutput): AgentRuntimeToolResult {
  if (typeof output === 'string') {
    return { content: [{ type: 'text', text: output }] };
  }
  return output;
}

export function appendRuntimeToolInstructions(text: string, runtimeTools?: AgentRuntimeTools): string {
  const instructions = runtimeTools?.systemPromptAppend?.trim();
  if (!instructions) return text;
  return `${text}\n\n${instructions}`;
}

export function asToolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
