import { describe, expect, it } from 'bun:test';
import { buildTodoTool, TODO_TOOL_NAME } from '../../../src/agents/pi-engine/todo-tool';
import { normalizePlanItems } from '../../../src/sessions/domain/plan.types';

type TodoTool = {
  name: string;
  parameters: { required: string[] };
  promptGuidelines: string[];
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

describe('pi-engine todo tool', () => {
  it('acknowledges with progress and requires usable items', async () => {
    const tool = buildTodoTool() as TodoTool;
    expect(tool.name).toBe(TODO_TOOL_NAME);

    const ok = await tool.execute('t1', {
      items: [
        { text: 'one', status: 'done' },
        { text: 'two', status: 'pending' },
      ],
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]?.text).toBe('Todo list updated: 1/2 done.');

    const bad = await tool.execute('t2', { items: [] });
    expect(bad.isError).toBe(true);
  });

  it('wraps with defineTool when provided', () => {
    const seen: unknown[] = [];
    const defineTool = (tool: unknown) => {
      seen.push(tool);
      return tool;
    };
    buildTodoTool(defineTool);
    expect(seen).toHaveLength(1);
  });
});

describe('server normalizePlanItems', () => {
  it('mirrors the shared normalization contract', () => {
    expect(
      normalizePlanItems([{ text: 'a', status: 'in_progress' }, { text: '' }]),
    ).toEqual([{ id: 'item-1', text: 'a', status: 'in_progress' }]);
    expect(normalizePlanItems([])).toBeUndefined();
  });
});
