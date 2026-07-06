import { Injectable } from '@nestjs/common';
import { BrowserToolService } from '../../browser/browser-tool.service';
import type { BrowserToolCallInput, BrowserToolResult } from '../../browser/browser.types';
import type {
  AgentRuntimeTool,
  AgentRuntimeToolResult,
  AgentRuntimeTools,
} from './agent-runtime-tools.types';

@Injectable()
export class AgentToolRegistry {
  constructor(private readonly browser: BrowserToolService) {}

  forSession(sessionId: string): AgentRuntimeTools {
    return {
      systemPromptAppend:
        'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.',
      tools: this.browser.toolDefinitions.map((definition): AgentRuntimeTool => ({
        name: definition.name,
        description: definition.description,
        inputSchema: stripSessionId(definition.inputSchema),
        execute: async (input) =>
          browserResultToRuntimeResult(
            await this.browser.execute(definition.name, {
              ...input,
              sessionId,
            } as BrowserToolCallInput),
          ),
      })),
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
