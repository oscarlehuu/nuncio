import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';
import { BrowserToolService } from '../../browser/browser-tool.service';
import type { BrowserToolCallInput, BrowserToolResult } from '../../browser/browser.types';
import { OrchestrationToolsService } from '../../orchestration/tools/orchestration-tools.service';
import type {
  AgentRuntimeTool,
  AgentRuntimeToolResult,
  AgentRuntimeTools,
} from './agent-runtime-tools.types';

const BROWSER_PROMPT_APPEND =
  'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';

export interface ToolScope {
  sessionId: string;
  projectPath: string | null;
  /** The session's engine — resolves the prompt profile's tools-preamble (D2). */
  provider?: string;
  model?: string | null;
}

@Injectable()
export class AgentToolRegistry {
  constructor(
    private readonly browser: BrowserToolService,
    @Optional()
    @Inject(forwardRef(() => OrchestrationToolsService))
    private readonly orchestration?: OrchestrationToolsService,
  ) {}

  forSession(scope: ToolScope): AgentRuntimeTools {
    const browserTools = this.browser.toolDefinitions.map((definition): AgentRuntimeTool => ({
      name: definition.name,
      description: definition.description,
      inputSchema: stripSessionId(definition.inputSchema),
      execute: async (input) =>
        browserResultToRuntimeResult(
          await this.browser.execute(definition.name, {
            ...input,
            sessionId: scope.sessionId,
          } as BrowserToolCallInput),
        ),
    }));

    // Merge orchestration tools (gated by NUNCIO_ORCHESTRATION_TOOLS; empty when off).
    const orchestration = this.orchestration?.forScope(scope) ?? { tools: [] };
    const appends = [BROWSER_PROMPT_APPEND, orchestration.systemPromptAppend].filter(Boolean);

    return {
      systemPromptAppend: appends.join('\n\n'),
      tools: [...browserTools, ...orchestration.tools],
    };
  }
}

function stripSessionId(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema) as Record<string, unknown>;
  const properties = clone.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    delete (properties as Record<string, unknown>).sessionId;
  }
  if (Array.isArray(clone.required)) {
    clone.required = clone.required.filter((field) => field !== 'sessionId');
  }
  return clone;
}

function browserResultToRuntimeResult(result: BrowserToolResult): AgentRuntimeToolResult {
  if (result.type === 'screenshot') {
    return {
      content: [{ type: 'image', data: result.data, mimeType: result.mimeType }],
      structuredContent: { target: result.target, mimeType: result.mimeType },
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.state, null, 2) }],
    structuredContent: result.state,
  };
}
