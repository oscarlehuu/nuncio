import { describe, expect, it } from 'bun:test';
import {
  buildExternalMemoryTool,
  EXTERNAL_MEMORY_READ_MAX_BYTES,
  EXTERNAL_MEMORY_TOOL_NAME,
} from '../../../src/agents/pi-engine/external-memory-tool';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ExternalMemoryTool = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

describe('read_external_memory', () => {
  const deps = {
    availableIds: () => ['safe-one', 'safe-two'],
    read: async (_source: string, id: string) => id === 'safe-one' ? 'memory body' : null,
  };

  it('rejects traversal-shaped ids before reading', async () => {
    const tool = buildExternalMemoryTool(deps as never) as ExternalMemoryTool;
    for (const id of ['../x', '/absolute', 'a/b', 'a\\b']) {
      const result = await tool.execute('call', { source: 'claude-code', id });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('invalid memory id');
    }
  });

  it('returns the complete session-bound id list for an unknown id', async () => {
    const ids = Array.from({ length: 400 }, (_, index) => `memory-${index}`);
    const tool = buildExternalMemoryTool({
      availableIds: () => ids,
      read: async () => null,
    }) as ExternalMemoryTool;
    const result = await tool.execute('call', { source: 'claude-code', id: 'missing' });

    expect(tool.name).toBe(EXTERNAL_MEMORY_TOOL_NAME);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `Unknown claude-code memory id "missing". Available ids: ${ids.join(', ')}`,
    );
  });

  it('wraps with defineTool and truncates full reads without breaking UTF-8', async () => {
    const seen: unknown[] = [];
    const tool = buildExternalMemoryTool({
      availableIds: () => ['safe-one'],
      read: async () => '🌌'.repeat(EXTERNAL_MEMORY_READ_MAX_BYTES),
    }, (definition) => {
      seen.push(definition);
      return definition;
    }) as ExternalMemoryTool;

    const result = await tool.execute('call', { source: 'codex', id: 'safe-one' });
    expect(seen).toHaveLength(1);
    expect(new TextEncoder().encode(result.content[0]?.text).byteLength)
      .toBeLessThanOrEqual(EXTERNAL_MEMORY_READ_MAX_BYTES);
    expect(result.content[0]?.text).toEndWith('_(external memory truncated)_');
    expect(result.content[0]?.text).not.toContain('�');
  });
});
