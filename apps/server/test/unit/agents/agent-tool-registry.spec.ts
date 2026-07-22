import { describe, expect, it } from 'bun:test';
import { AgentToolRegistry } from '../../../src/agents/tools/agent-tool-registry';
import { defineTrustedRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools-policy';
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
    const runtime = registry.forSession({ sessionId: 'session-123', projectPath: null });
    const open = runtime.tools.find((tool) => tool.name === 'browser_open');

    expect(open).toBeDefined();
    expect(open?.security).toEqual({
      network: 'required',
      workspaceMutation: 'none',
      runtimePolicies: [],
      scope: 'session',
    });
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

  it('merges and unregisters session-scoped runtime tool sources without cloning trusted tools', () => {
    const browser = { toolDefinitions: [], execute: async () => ({ type: 'state', state: {} }) } as unknown as BrowserToolService;
    const registry = new AgentToolRegistry(browser);
    const tool = defineTrustedRuntimeTool({
      name: 'submit_plan',
      inputSchema: {},
      execute: async () => 'ok',
      security: {
        network: 'disabled',
        workspaceMutation: 'none',
        runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }],
        scope: 'policy-internal',
      },
    });
    const unregister = registry.registerSource({
      forSession: (scope) => scope.sessionId === 'policy-session' ? { tools: [tool] } : undefined,
    });

    expect(registry.forSession({ sessionId: 'policy-session', projectPath: null }).tools).toContain(tool);
    expect(registry.forSession({ sessionId: 'solo-session', projectPath: null }).tools).not.toContain(tool);
    unregister();
    expect(registry.forSession({ sessionId: 'policy-session', projectPath: null }).tools).not.toContain(tool);
  });
});
