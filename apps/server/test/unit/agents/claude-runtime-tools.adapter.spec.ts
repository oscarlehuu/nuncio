import { describe, it, expect } from 'bun:test';
import {
  buildClaudeMcpServers,
  buildClaudeRuntimeToolDefinitions,
  jsonSchemaToZodShape,
  normalizeMcpToolName,
  CLAUDE_RUNTIME_MCP_SERVER,
  type ClaudeMcpToolDefinition,
} from '../../../src/agents/tools/claude-runtime-tools.adapter';
import type { AgentRuntimeTools } from '../../../src/agents/tools/agent-runtime-tools.types';

describe('claude runtime-tools adapter', () => {
  it('returns no definitions when there are no tools', () => {
    expect(buildClaudeRuntimeToolDefinitions(undefined)).toEqual([]);
    expect(buildClaudeRuntimeToolDefinitions({ tools: [] })).toEqual([]);
  });

  it('builds no mcpServers entry when there are no tools (undefined, like the cursor adapter)', () => {
    const create = () => {
      throw new Error('should not build a server for empty tools');
    };
    expect(buildClaudeMcpServers(create, undefined)).toBeUndefined();
    expect(buildClaudeMcpServers(create, { tools: [] })).toBeUndefined();
  });

  it('wraps each tool with name, description, a converted zod shape, and a handler', () => {
    const tools: AgentRuntimeTools = {
      tools: [
        {
          name: 'echo',
          description: 'Echo back',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          execute: () => 'ok',
        },
        { name: 'noop', inputSchema: { type: 'object' }, execute: () => 'x' },
      ],
    };
    const defs = buildClaudeRuntimeToolDefinitions(tools);
    expect(defs.map((d) => d.name)).toEqual(['echo', 'noop']);
    expect(defs[0].description).toBe('Echo back');
    // Missing description falls back to the tool name.
    expect(defs[1].description).toBe('noop');
    // A declared property becomes a zod field so the model sees the parameter.
    expect(Object.keys(defs[0].inputSchema)).toEqual(['message']);
    // No properties → empty shape.
    expect(Object.keys(defs[1].inputSchema)).toEqual([]);
  });

  describe('jsonSchemaToZodShape', () => {
    it('maps primitives, marks required vs optional, and parses valid input', () => {
      const shape = jsonSchemaToZodShape({
        type: 'object',
        properties: {
          url: { type: 'string' },
          x: { type: 'number' },
          flag: { type: 'boolean' },
        },
        required: ['url'],
      });
      expect(Object.keys(shape).sort()).toEqual(['flag', 'url', 'x']);
      expect(shape.url.safeParse('a').success).toBe(true);
      expect(shape.url.safeParse(undefined).success).toBe(false); // required
      expect(shape.x.safeParse(undefined).success).toBe(true); // optional
      expect(shape.x.safeParse(3).success).toBe(true);
    });

    it('maps an enum to a union of literals', () => {
      const shape = jsonSchemaToZodShape({
        type: 'object',
        properties: { target: { type: 'string', enum: ['auto', 'in_app', 'external'] } },
        required: ['target'],
      });
      expect(shape.target.safeParse('auto').success).toBe(true);
      expect(shape.target.safeParse('nope').success).toBe(false);
    });

    it('maps arrays element-wise', () => {
      const shape = jsonSchemaToZodShape({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags'],
      });
      expect(shape.tags.safeParse(['a', 'b']).success).toBe(true);
      expect(shape.tags.safeParse([1]).success).toBe(false);
    });

    it('yields an empty shape when there are no properties', () => {
      expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
      expect(jsonSchemaToZodShape({})).toEqual({});
    });
  });

  it('round-trips execute: args reach the tool and a string output becomes a text block', async () => {
    let seen: unknown;
    const tools: AgentRuntimeTools = {
      tools: [
        {
          name: 'echo',
          inputSchema: {},
          execute: (input) => {
            seen = input;
            return `echoed:${input.msg}`;
          },
        },
      ],
    };
    const def = buildClaudeRuntimeToolDefinitions(tools)[0];
    const result = await def.handler({ msg: 'hi' });
    expect(seen).toEqual({ msg: 'hi' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echoed:hi' }] });
  });

  it('passes a rich AgentRuntimeToolResult through unchanged', async () => {
    const tools: AgentRuntimeTools = {
      tools: [
        {
          name: 'rich',
          inputSchema: {},
          execute: () => ({ content: [{ type: 'text', text: 'done' }], isError: false, structuredContent: { a: 1 } }),
        },
      ],
    };
    const def = buildClaudeRuntimeToolDefinitions(tools)[0];
    const result = await def.handler({});
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false, structuredContent: { a: 1 } });
  });

  it('surfaces a throwing execute as an is-error result rather than crashing', async () => {
    const tools: AgentRuntimeTools = {
      tools: [{ name: 'boom', inputSchema: {}, execute: () => { throw new Error('kaboom'); } }],
    };
    const def = buildClaudeRuntimeToolDefinitions(tools)[0];
    const result = await def.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'kaboom' }]);
  });

  it('builds the mcpServers record via the injected createServer', () => {
    const captured: { name?: string; tools?: ClaudeMcpToolDefinition[] } = {};
    const create = (opts: { name: string; tools: ClaudeMcpToolDefinition[] }) => {
      captured.name = opts.name;
      captured.tools = opts.tools;
      return { type: 'sdk' as const, name: opts.name, instance: {} };
    };
    const servers = buildClaudeMcpServers(create, {
      tools: [{ name: 'echo', inputSchema: {}, execute: () => 'ok' }],
    });
    expect(captured.name).toBe(CLAUDE_RUNTIME_MCP_SERVER);
    expect(captured.tools?.[0].name).toBe('echo');
    expect(servers?.[CLAUDE_RUNTIME_MCP_SERVER]).toEqual({ type: 'sdk', name: CLAUDE_RUNTIME_MCP_SERVER, instance: {} });
  });

  describe('normalizeMcpToolName', () => {
    it('strips the mcp__<server>__ prefix', () => {
      expect(normalizeMcpToolName('mcp__nuncio-runtime__echo')).toBe('echo');
    });

    it('handles a tool name that itself contains underscores', () => {
      expect(normalizeMcpToolName('mcp__nuncio-runtime__verify_task')).toBe('verify_task');
    });

    it('passes built-in tool names through unchanged', () => {
      expect(normalizeMcpToolName('Bash')).toBe('Bash');
      expect(normalizeMcpToolName('Read')).toBe('Read');
    });
  });
});
