import {
  asToolInput,
  normalizeAgentRuntimeToolResult,
  type AgentRuntimeTools,
} from './agent-runtime-tools.types';

export interface CursorRuntimeTool {
  description?: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown): Promise<ReturnType<typeof normalizeAgentRuntimeToolResult>>;
}

export function buildCursorCustomTools(runtimeTools?: AgentRuntimeTools): Record<string, CursorRuntimeTool> | undefined {
  const tools = runtimeTools?.tools ?? [];
  if (tools.length === 0) return undefined;

  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (args: unknown) =>
          normalizeAgentRuntimeToolResult(await tool.execute(asToolInput(args))),
      },
    ]),
  );
}
