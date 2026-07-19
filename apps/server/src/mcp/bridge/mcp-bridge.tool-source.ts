import { Inject, Injectable, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentToolRegistry } from '../../agents/tools/agent-tool-registry';
import type {
  AgentRuntimeTool,
  AgentRuntimeToolResult,
  AgentRuntimeToolScope,
  AgentRuntimeToolSource,
  AgentRuntimeTools,
} from '../../agents/tools/agent-runtime-tools.types';
import { resolveTransport } from '../domain/mcp-transport';
import type { McpServerDefinition } from '../domain/mcp.types';
import { McpService } from '../mcp.service';
import { McpClientPool } from './mcp-client-pool';
import { MCP_CLIENT_FACTORY } from './mcp-client.types';
import type { McpCallOutcome, McpClientFactory, McpToolDescriptor } from './mcp-client.types';

const FIND_TOOLS_NAME = 'nuncio_mcp_find_tools';
const CALL_TOOL_NAME = 'nuncio_mcp_call';

const DEFAULT_IDLE_MS = 5 * 60_000;

/**
 * The lazy MCP gateway: instead of advertising every tool schema of every
 * enabled server each turn, sessions get two constant-cost tools plus a
 * one-line inventory per server. Servers are only spawned/connected when a
 * session actually touches them, and idle clients are swept.
 *
 * Registered as an `AgentRuntimeToolSource`, so every engine (Pi, Claude,
 * Codex, Cursor) receives the gateway through its existing runtime-tools
 * adapter — no per-engine MCP plumbing.
 *
 * Servers with `advertise: 'full'` additionally expose their tools directly as
 * `<server>_<tool>` once the schema cache is warm (warmed lazily in the
 * background; the gateway covers the cold window).
 */
@Injectable()
export class McpBridgeToolSource implements AgentRuntimeToolSource, OnModuleInit, OnModuleDestroy {
  private readonly pool: McpClientPool;
  private readonly schemaCache = new Map<string, { updatedAt: number; tools: McpToolDescriptor[] }>();
  private readonly warming = new Map<string, Promise<void>>();
  private unregister?: () => void;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly mcp: McpService,
    @Inject(MCP_CLIENT_FACTORY) factory: McpClientFactory,
    @Optional() private readonly registry?: AgentToolRegistry,
  ) {
    this.pool = new McpClientPool(factory, { idleMs: DEFAULT_IDLE_MS });
  }

  onModuleInit(): void {
    this.unregister = this.registry?.registerSource(this);
    this.sweepTimer = setInterval(() => void this.pool.sweepIdle(), DEFAULT_IDLE_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.unregister?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.pool.disposeAll();
  }

  forSession(scope: AgentRuntimeToolScope): AgentRuntimeTools | undefined {
    // Defensive: a broken MCP store degrades to "no MCP tools" — it must never
    // take run-context construction (and with it every session) down.
    try {
      return this.buildForSession(scope);
    } catch {
      return undefined;
    }
  }

  private buildForSession(scope: AgentRuntimeToolScope): AgentRuntimeTools | undefined {
    const servers = this.mcp.resolveForSession({
      provider: scope.provider ?? '',
      projectPath: scope.projectPath,
    });
    if (servers.length === 0) return undefined;
    const workspace = scope.workspace ?? null;

    const gatewayTools = [this.buildFindTool(servers, workspace), this.buildCallTool(servers, workspace)];
    const takenNames = new Set(gatewayTools.map((tool) => tool.name));
    const directTools: AgentRuntimeTool[] = [];
    for (const server of servers) {
      if (server.advertise !== 'full') continue;
      const cached = this.schemaCache.get(server.id);
      if (!cached || cached.updatedAt !== server.updatedAt) {
        void this.ensureSchemas(server.id, workspace);
        continue;
      }
      for (const descriptor of cached.tools) {
        const tool = this.buildDirectTool(server, descriptor, workspace);
        // A sanitized name colliding with the gateway (or another server's
        // tool) is skipped — it stays reachable via nuncio_mcp_call.
        if (takenNames.has(tool.name)) continue;
        takenNames.add(tool.name);
        directTools.push(tool);
      }
    }

    return {
      systemPromptAppend: this.buildInventory(servers),
      tools: [...gatewayTools, ...directTools],
    };
  }

  /** Warm the full-advertise schema cache for one server (idempotent, failure-tolerant). */
  async ensureSchemas(serverId: string, workspace: string | null): Promise<void> {
    const inFlight = this.warming.get(serverId);
    if (inFlight) return inFlight;
    const definition = this.mcp.getDefinition(serverId);
    if (!definition) return;
    const promise = (async () => {
      try {
        const tools = await this.pool.call(
          resolveTransport(definition.transport, workspace),
          (client) => client.listTools(),
        );
        this.schemaCache.set(serverId, { updatedAt: definition.updatedAt, tools });
      } catch {
        // Cache stays cold; the lazy gateway still reaches the server and
        // surfaces the connect error to the model per-call.
      } finally {
        this.warming.delete(serverId);
      }
    })();
    this.warming.set(serverId, promise);
    return promise;
  }

  private buildInventory(servers: McpServerDefinition[]): string {
    const lines = servers.map((server) => {
      const description = server.description?.trim() || 'no description';
      const fullNote =
        server.advertise === 'full' && this.schemaCache.has(server.id)
          ? ' (tools advertised directly)'
          : '';
      return `- ${server.id} — ${description}${fullNote}`;
    });
    return [
      '## External MCP servers',
      '',
      `The following MCP servers are available. Discover their tools with \`${FIND_TOOLS_NAME}\`` +
        ' (returns tool names, descriptions and input schemas), then invoke one with' +
        ` \`${CALL_TOOL_NAME}({ server, tool, args })\`.`,
      '',
      ...lines,
    ].join('\n');
  }

  private buildFindTool(servers: McpServerDefinition[], workspace: string | null): AgentRuntimeTool {
    return {
      name: FIND_TOOLS_NAME,
      description:
        'List tools available on the external MCP servers, including their input schemas. ' +
        'Optionally filter by a search query and/or a specific server id.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive substring matched against tool names and descriptions.',
          },
          server: { type: 'string', description: 'Only list tools of this server id.' },
        },
      },
      security: SECURITY,
      execute: async (input) => {
        const query = typeof input.query === 'string' ? input.query.toLowerCase() : null;
        const serverFilter = typeof input.server === 'string' ? input.server : null;
        const targets = serverFilter
          ? servers.filter((server) => server.id === serverFilter || server.name === serverFilter)
          : servers;
        if (targets.length === 0) {
          return errorResult(
            `Unknown server "${serverFilter}". Available: ${servers.map((s) => s.id).join(', ')}`,
          );
        }
        const entries = await Promise.all(
          targets.map(async (server) => {
            try {
              const tools = await this.pool.call(
                resolveTransport(server.transport, workspace),
                (client) => client.listTools(),
              );
              this.schemaCache.set(server.id, { updatedAt: server.updatedAt, tools });
              const matching = query
                ? tools.filter(
                    (tool) =>
                      tool.name.toLowerCase().includes(query) ||
                      (tool.description ?? '').toLowerCase().includes(query),
                  )
                : tools;
              return {
                server: server.id,
                ...(server.description ? { description: server.description } : {}),
                tools: matching,
              };
            } catch (error) {
              return { server: server.id, error: message(error) };
            }
          }),
        );
        const structured = { servers: entries };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      },
    };
  }

  private buildCallTool(servers: McpServerDefinition[], workspace: string | null): AgentRuntimeTool {
    return {
      name: CALL_TOOL_NAME,
      description:
        'Invoke a tool on one of the external MCP servers. Use nuncio_mcp_find_tools first to ' +
        'discover tool names and input schemas.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Server id from the inventory.' },
          tool: { type: 'string', description: 'Tool name on that server.' },
          args: { type: 'object', description: 'Tool arguments matching its input schema.' },
        },
        required: ['server', 'tool'],
      },
      security: SECURITY,
      execute: async (input) => {
        const serverId = typeof input.server === 'string' ? input.server : '';
        const toolName = typeof input.tool === 'string' ? input.tool : '';
        const server = servers.find((entry) => entry.id === serverId || entry.name === serverId);
        if (!server) {
          return errorResult(
            `Unknown server "${serverId}". Available: ${servers.map((s) => s.id).join(', ')}`,
          );
        }
        if (!toolName) return errorResult('tool (string) is required');
        const args =
          input.args && typeof input.args === 'object' && !Array.isArray(input.args)
            ? (input.args as Record<string, unknown>)
            : {};
        return this.callServerTool(server, toolName, args, workspace);
      },
    };
  }

  private buildDirectTool(
    server: McpServerDefinition,
    descriptor: McpToolDescriptor,
    workspace: string | null,
  ): AgentRuntimeTool {
    return {
      name: directToolName(server.id, descriptor.name),
      description: `[${server.id}] ${descriptor.description ?? descriptor.name}`,
      inputSchema: descriptor.inputSchema,
      security: SECURITY,
      execute: async (input) => this.callServerTool(server, descriptor.name, input, workspace),
    };
  }

  private async callServerTool(
    server: McpServerDefinition,
    toolName: string,
    args: Record<string, unknown>,
    workspace: string | null,
  ): Promise<AgentRuntimeToolResult> {
    try {
      const outcome = await this.pool.call(
        resolveTransport(server.transport, workspace),
        (client) => client.callTool(toolName, args),
      );
      return outcomeToResult(outcome);
    } catch (error) {
      // The pool has already retired the failed client; the next call reconnects.
      return errorResult(`MCP call to ${server.id}.${toolName} failed: ${message(error)}`);
    }
  }
}

const SECURITY = {
  network: 'required',
  workspaceMutation: 'workspace',
  runtimePolicies: [],
  scope: 'session',
} as const;

function directToolName(serverId: string, toolName: string): string {
  return `${serverId}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function outcomeToResult(outcome: McpCallOutcome): AgentRuntimeToolResult {
  return {
    content: outcome.content.map((entry) =>
      entry.type === 'image'
        ? { type: 'image' as const, data: entry.data, mimeType: entry.mimeType }
        : { type: 'text' as const, text: entry.text },
    ),
    ...(outcome.structuredContent !== undefined
      ? { structuredContent: outcome.structuredContent }
      : {}),
    ...(outcome.isError ? { isError: true } : {}),
  };
}

function errorResult(text: string): AgentRuntimeToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
