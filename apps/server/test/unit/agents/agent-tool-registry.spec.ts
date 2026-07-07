import { describe, expect, it } from 'bun:test';
import { AgentToolRegistry } from '../../../src/agents/tools/agent-tool-registry';
import { BROWSER_TOOL_DEFINITIONS } from '../../../src/browser/browser-tool-contract';
import type { BrowserToolService } from '../../../src/browser/browser-tool.service';
import type { BrowserToolCallInput, BrowserToolResult } from '../../../src/browser/browser.types';

describe('AgentToolRegistry', () => {
  it('binds browser tools to the session and hides internal sessionId from agents', async () => {
    const calls: Array<{ toolName: string; input: BrowserToolCallInput }> = [];
    const browser = {
      toolDefinitions: BROWSER_TOOL_DEFINITIONS,
      execute: async (toolName: string, input: BrowserToolCallInput): Promise<BrowserToolResult> => {
        calls.push({ toolName, input });
        return {
          type: 'state',
          state: {
            target: 'in_app',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            connected: true,
            screenshotVersion: 1,
          },
        };
      },
    } as BrowserToolService;

    const registry = new AgentToolRegistry(browser);
    const runtime = registry.forSession('session-123');
    const open = runtime.tools.find((tool) => tool.name === 'browser_open');

    expect(open).toBeDefined();
    expect((open?.inputSchema.properties as Record<string, unknown>).sessionId).toBeUndefined();
    expect(open?.inputSchema.required).toEqual([]);

    const result = await open!.execute({ url: 'https://example.com' });

    expect(calls).toEqual([
      {
        toolName: 'browser_open',
        input: { url: 'https://example.com', sessionId: 'session-123' },
      },
    ]);
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('https://example.com') }],
      structuredContent: { target: 'in_app', url: 'https://example.com' },
    });
  });
});
