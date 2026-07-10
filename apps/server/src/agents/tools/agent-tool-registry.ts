import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';
import { BrowserToolService } from '../../browser/browser-tool.service';
import type { BrowserToolCallInput, BrowserToolResult } from '../../browser/browser.types';
import { OrchestrationToolsService } from '../../orchestration/tools/orchestration-tools.service';
import type {
  AgentRuntimeTool,
  AgentRuntimeToolResult,
  AgentRuntimeToolScope,
  AgentRuntimeToolSource,
  AgentRuntimeTools,
} from './agent-runtime-tools.types';

const BROWSER_PROMPT_APPEND =
  'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';

export type ToolScope = AgentRuntimeToolScope;

@Injectable()
export class AgentToolRegistry {
  private readonly sources = new Set<AgentRuntimeToolSource>();

  constructor(
    private readonly browser: BrowserToolService,
    @Optional()
    @Inject(forwardRef(() => OrchestrationToolsService))
    private readonly orchestration?: OrchestrationToolsService,
  ) {}

  /** Register an independently-scoped source; the disposer prevents stale closures. */
  registerSource(source: AgentRuntimeToolSource): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }

  forSession(scope: ToolScope): AgentRuntimeTools {
    const browserTools = this.browser.toolDefinitions.map((definition): AgentRuntimeTool => ({
      name: definition.name,
      description: definition.description,
      inputSchema: stripSessionId(definition.inputSchema),
      security: {
        network: 'required',
        workspaceMutation: 'none',
        runtimePolicies: [],
        scope: 'session',
      },
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
    const orchestrationTools = orchestration.tools.map((tool): AgentRuntimeTool => ({
      ...tool,
      security: {
        network: 'disabled',
        workspaceMutation: 'none',
        runtimePolicies: [],
        scope: 'session',
      },
    }));
    const sourced = [...this.sources]
      .map((source) => source.forSession(scope))
      .filter((tools): tools is AgentRuntimeTools => tools !== undefined);
    const appends = [
      BROWSER_PROMPT_APPEND,
      orchestration.systemPromptAppend,
      ...sourced.map((tools) => tools.systemPromptAppend),
    ].filter(Boolean);

    return {
      systemPromptAppend: appends.join('\n\n'),
      tools: [...browserTools, ...orchestrationTools, ...sourced.flatMap((tools) => tools.tools)],
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
