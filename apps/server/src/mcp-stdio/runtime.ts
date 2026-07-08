import { DaemonApiClient, DaemonApiError } from './http-client';
import { MCP_TOOLS } from './tool-definitions';
import type { McpToolDefinition, ToolCallResult } from './types';

export interface McpRuntimeOptions {
  apiOrigin: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export interface McpRuntime {
  listTools(): McpToolDefinition[];
  callTool(name: string, input: unknown): Promise<ToolCallResult>;
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntime {
  const client = new DaemonApiClient(options);
  const redact = (message: string) => sanitizeErrorMessage(message, options.authToken);
  return {
    listTools: () => MCP_TOOLS,
    callTool: async (name, input) => {
      try {
        return success(await callTool(client, name, asObject(input)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(redact(message));
      }
    },
  };
}

async function callTool(
  client: DaemonApiClient,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'nuncio_list_sessions':
      return {
        sessions: await client.get('/api/sessions', {
          includeArchived: input.includeArchived === true ? '1' : undefined,
        }),
      };
    case 'nuncio_get_session':
      return getSession(client, input);
    case 'nuncio_get_timeline':
      return client.get('/api/timeline', input);
    case 'nuncio_get_attention':
      return client.get('/api/attention');
    case 'nuncio_get_fleet':
      return client.get('/api/fleet');
    case 'nuncio_list_loops':
      return client.get('/api/loops');
    case 'nuncio_enqueue_task':
      return enqueueTask(client, input);
    case 'nuncio_pause_loop':
      return pauseLoop(client, input);
    default:
      throw new DaemonApiError(`Unknown tool: ${name}`);
  }
}

async function getSession(client: DaemonApiClient, input: Record<string, unknown>) {
  const id = requireString(input, 'id');
  const [session, observability] = await Promise.all([
    client.get(`/api/sessions/${encodeURIComponent(id)}`),
    client.get(`/api/observability/sessions/${encodeURIComponent(id)}`, {
      from: input.from,
      to: input.to,
    }),
  ]);
  return { session, observability };
}

async function enqueueTask(client: DaemonApiClient, input: Record<string, unknown>) {
  const prompt = requireString(input, 'prompt').trim();
  if (!prompt) throw new DaemonApiError('prompt is required');
  const task = await client.post(
    '/api/tasks',
    compact({
      prompt,
      provider: input.provider,
      model: input.model,
      modelOptions: input.modelOptions,
      projectPath: input.projectPath,
      baseBranch: input.baseBranch,
      useWorktree: input.useWorktree,
      workspace: input.workspace,
    }),
  );
  return { action: 'enqueued', task };
}

async function pauseLoop(client: DaemonApiClient, input: Record<string, unknown>) {
  const loopId = requireString(input, 'loopId');
  const loop = await client.post(`/api/loops/${encodeURIComponent(loopId)}/pause`);
  return { action: 'paused', loop };
}

function success(value: unknown): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(message: string): ToolCallResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new DaemonApiError(`${key} is required`);
  return value;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

export function sanitizeErrorMessage(message: string, authToken?: string): string {
  let sanitized = message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
  sanitized = sanitized.replace(/(NUNCIO_AUTH_TOKEN|NUNCIO_API_TOKEN)=\S+/g, '$1=[redacted]');
  if (authToken) sanitized = sanitized.split(authToken).join('[redacted]');
  return sanitized;
}
