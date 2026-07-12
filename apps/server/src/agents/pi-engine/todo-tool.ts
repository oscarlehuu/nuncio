import { normalizePlanItems } from '../../sessions/domain/plan.types';

export const TODO_TOOL_NAME = 'todo_write';

const TODO_PARAMETERS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'The full task list. Every call replaces the previous list entirely.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id; keep it across updates.' },
          text: { type: 'string', description: 'Short imperative description of the step.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
        required: ['text', 'status'],
      },
    },
  },
  required: ['items'],
};

/**
 * Session task list the user can watch live. The tool itself only
 * acknowledges — the provider turns the call into a shared `plan_updated`
 * session event, so the UI stays provider-neutral.
 */
export function buildTodoTool(defineTool?: (tool: unknown) => unknown): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: TODO_TOOL_NAME,
    label: 'Todo list',
    description:
      'Maintain the visible task list for this session. Pass the FULL list on every call — it replaces the previous one. Keep ids stable across updates.',
    promptSnippet:
      'todo_write: keep a visible task list for multi-step work (replace-all on every call).',
    promptGuidelines: [
      'For any task with 3+ steps, call todo_write first and keep it updated as you work.',
      'Keep exactly one item in_progress at a time; mark items done as soon as they are finished.',
    ],
    parameters: TODO_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const items = normalizePlanItems((params as { items?: unknown })?.items);
      if (!items) {
        return {
          content: [{ type: 'text', text: 'todo_write ignored: no usable items.' }],
          isError: true,
          details: {},
        };
      }
      const done = items.filter((item) => item.status === 'done').length;
      return {
        content: [
          { type: 'text', text: `Todo list updated: ${done}/${items.length} done.` },
        ],
        details: {},
      };
    },
  });
}
