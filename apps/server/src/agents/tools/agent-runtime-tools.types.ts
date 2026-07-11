export type AgentRuntimeToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AgentRuntimeToolResult {
  content: AgentRuntimeToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type AgentRuntimeToolOutput = string | AgentRuntimeToolResult;

export interface AgentRuntimeToolPolicySupport {
  filesystem: 'read-only' | 'workspace-write';
  network: 'disabled';
}

/**
 * Declarative security facts used by the explicit-policy tool gate. Metadata is
 * necessary but not sufficient: Crew tools must also be created through the
 * trusted constructor so a lookalike object cannot opt itself into the gate.
 */
export interface AgentRuntimeToolSecurity {
  network: 'disabled' | 'required';
  workspaceMutation: 'none' | 'workspace';
  runtimePolicies: readonly AgentRuntimeToolPolicySupport[];
  scope: 'session' | 'crew-internal';
}

export interface AgentRuntimeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  security?: AgentRuntimeToolSecurity;
  /** Deterministic input for the forced-Mock smoke adapter; never advertised to real providers. */
  testInput?: () => Record<string, unknown>;
  execute(input: Record<string, unknown>): AgentRuntimeToolOutput | Promise<AgentRuntimeToolOutput>;
}

export interface AgentRuntimeTools {
  systemPromptAppend?: string;
  tools: AgentRuntimeTool[];
}

export interface AgentRuntimeToolScope {
  sessionId: string;
  projectPath: string | null;
  provider?: string;
  model?: string | null;
}

export interface AgentRuntimeToolSource {
  forSession(scope: AgentRuntimeToolScope): AgentRuntimeTools | undefined;
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
