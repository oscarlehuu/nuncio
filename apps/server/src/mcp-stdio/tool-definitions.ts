import type { McpToolDefinition } from './types';

const stringField = (description: string) => ({ type: 'string', description });
const booleanField = (description: string) => ({ type: 'boolean', description });

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'nuncio_list_sessions',
    description: 'List Nuncio sessions so an agent can find active, idle, or archived work.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchived: booleanField('Include archived sessions when true.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nuncio_get_session',
    description: 'Read one session detail plus observability and verify summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: stringField('Session id.'),
        from: stringField('Optional metrics window start timestamp.'),
        to: stringField('Optional metrics window end timestamp.'),
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'nuncio_get_timeline',
    description: 'Read the global Nuncio timeline with pagination and project/provider filters.',
    inputSchema: {
      type: 'object',
      properties: {
        from: stringField('Optional timeline window start timestamp.'),
        to: stringField('Optional timeline window end timestamp.'),
        before: stringField('Exclusive timestamp cursor for pagination.'),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size.' },
        projectPath: stringField('Filter to one project path.'),
        provider: stringField('Filter to one provider id.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nuncio_get_attention',
    description: 'Read the ranked founder attention inbox and badge counts.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'nuncio_get_fleet',
    description: 'Read project fleet health rows, ordered with unhealthy projects first.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'nuncio_list_loops',
    description: 'List Autopilot loops with their current state and schedule.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'nuncio_enqueue_task',
    description: 'Enqueue a new Nuncio task through the existing durable task queue.',
    mutation: true,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: stringField('Task prompt to enqueue. Required.'),
        provider: stringField('Optional provider id, for example pi, codex, or cursor.'),
        model: stringField('Optional provider model id.'),
        modelOptions: { type: 'object', description: 'Optional provider model options.' },
        projectPath: stringField('Optional absolute project path.'),
        baseBranch: stringField('Optional base branch for worktree runs.'),
        useWorktree: booleanField('Create a new worktree when true.'),
        workspace: stringField('Optional explicit workspace path.'),
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'nuncio_pause_loop',
    description: 'Pause one Autopilot loop by id and return the paused loop.',
    mutation: true,
    inputSchema: {
      type: 'object',
      properties: {
        loopId: stringField('Loop id to pause.'),
      },
      required: ['loopId'],
      additionalProperties: false,
    },
  },
];

export const MUTATION_TOOL_NAMES = MCP_TOOLS.filter((tool) => tool.mutation).map(
  (tool) => tool.name,
);
