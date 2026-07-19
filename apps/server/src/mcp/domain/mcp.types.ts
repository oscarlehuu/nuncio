/**
 * MCP Store domain types.
 *
 * The store is the INBOUND direction: external MCP servers (stdio commands or
 * http/sse remotes) registered with Nuncio and exposed to engine sessions via
 * the runtime-tools bridge. The OUTBOUND direction (Nuncio *as* an MCP server
 * for external hosts) lives in `src/mcp-stdio/` — keep them separate.
 */

export type McpEngineId = 'pi' | 'claude' | 'cursor' | 'codex';

export type McpStdioTransport = {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type McpRemoteTransport = {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpTransport = McpStdioTransport | McpRemoteTransport;

export type McpServerSource = 'nuncio' | 'import:cursor' | 'import:claude' | 'import:codex';

type McpAdvertiseMode = 'lazy' | 'full';

export type McpAuthMode = 'none' | 'oauth';

export type McpOAuthStatus = 'none' | 'required' | 'connected';

/**
 * Canonical server definition. `projectPath` null means global scope; a set
 * path scopes the server to sessions of that project (worktree sessions match
 * on the session's projectPath, not the worktree cwd).
 */
export interface McpServerDefinition {
  id: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  enabled: boolean;
  advertise: McpAdvertiseMode;
  projectPath: string | null;
  /** Engines allowed to see this server; null = all engines. */
  engines: McpEngineId[] | null;
  auth: McpAuthMode;
  /** Provenance — grows when imports from multiple stores dedupe into one row. */
  sources: McpServerSource[];
  /** Env-var names (stdio) or header names (http/sse) whose values are encrypted at rest. */
  secretKeys: string[];
  createdAt: number;
  updatedAt: number;
}

/** Fields callers may set when creating a server. */
export interface CreateMcpServerInput {
  name: string;
  description?: string | null;
  transport: McpTransport;
  enabled?: boolean;
  advertise?: McpAdvertiseMode;
  projectPath?: string | null;
  engines?: McpEngineId[] | null;
  auth?: McpAuthMode;
  sources?: McpServerSource[];
  secretKeys?: string[];
}

/** Fields callers may patch on an existing server. */
export interface UpdateMcpServerInput {
  name?: string;
  description?: string | null;
  transport?: McpTransport;
  enabled?: boolean;
  advertise?: McpAdvertiseMode;
  projectPath?: string | null;
  engines?: McpEngineId[] | null;
  auth?: McpAuthMode;
  secretKeys?: string[];
}

/** API shape: identical to the definition but secret values are masked. */
export interface McpServerDto extends Omit<McpServerDefinition, 'transport'> {
  transport: McpTransport;
  scope: 'global' | 'project';
  oauthStatus: McpOAuthStatus;
}

const MCP_ENGINE_IDS: readonly McpEngineId[] = ['pi', 'claude', 'cursor', 'codex'];

export function isMcpEngineId(value: string): value is McpEngineId {
  return (MCP_ENGINE_IDS as readonly string[]).includes(value);
}
