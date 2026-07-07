import {
  asToolInput,
  normalizeAgentRuntimeToolResult,
  type AgentRuntimeToolContent,
  type AgentRuntimeTools,
} from './agent-runtime-tools.types';

export interface CodexDynamicToolSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodexDynamicToolResponse {
  contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>;
  success: boolean;
}

export function buildCodexDynamicTools(runtimeTools?: AgentRuntimeTools): CodexDynamicToolSpec[] | undefined {
  const tools = runtimeTools?.tools ?? [];
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: tool.inputSchema,
  }));
}

export async function executeCodexRuntimeTool(
  runtimeTools: AgentRuntimeTools | undefined,
  toolName: string,
  args: unknown,
): Promise<CodexDynamicToolResponse | null> {
  const tool = runtimeTools?.tools.find((candidate) => candidate.name === toolName);
  if (!tool) return null;
  try {
    const result = normalizeAgentRuntimeToolResult(await tool.execute(asToolInput(args)));
    return {
      contentItems: result.content.map(toCodexContentItem),
      success: result.isError !== true,
    };
  } catch (error) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      success: false,
    };
  }
}

function toCodexContentItem(content: AgentRuntimeToolContent): CodexDynamicToolResponse['contentItems'][number] {
  if (content.type === 'image') {
    return { type: 'inputImage', imageUrl: `data:${content.mimeType};base64,${content.data}` };
  }
  return { type: 'inputText', text: content.text };
}
