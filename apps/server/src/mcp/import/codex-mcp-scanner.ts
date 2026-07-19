import { detectSecretKeys } from './json-mcp-entry';
import { isStringRecord } from './json-mcp-entry';
import type { McpTransport } from '../domain/mcp.types';
import type { McpImportCandidate } from './mcp-import.types';

/**
 * Parse a Codex `config.toml` (`~/.codex/config.toml` globally, or a trusted
 * project's `.codex/config.toml` when `projectPath` is set) and extract the
 * `[mcp_servers.*]` tables.
 *
 * Codex-specific fields handled: `enabled` (default true), `http_headers`
 * (static header table), `env_http_headers` (headers resolved from the daemon
 * process env — unset vars are skipped), `bearer_token_env_var` (mapped to an
 * Authorization header when the var is set), and `oauth_resource`/`scopes`
 * (mark the candidate `auth: 'oauth'` — Nuncio-side OAuth lands in phase 2).
 */
export function parseCodexConfig(
  content: string,
  projectPath: string | null,
): McpImportCandidate[] {
  let parsed: { mcp_servers?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(content) as { mcp_servers?: Record<string, unknown> };
  } catch {
    return [];
  }
  const servers = parsed?.mcp_servers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).flatMap(([name, entry]) => {
    const candidate = entryToCandidate(name, entry, projectPath);
    return candidate ? [candidate] : [];
  });
}

function entryToCandidate(
  name: string,
  entry: unknown,
  projectPath: string | null,
): McpImportCandidate | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const transport = entryToTransport(record);
  if (!transport) return null;
  return {
    name,
    transport,
    source: 'import:codex',
    projectPath,
    enabled: record.enabled !== false,
    auth: record.oauth_resource || record.scopes ? 'oauth' : 'none',
    secretKeys: detectSecretKeys(transport),
  };
}

function entryToTransport(record: Record<string, unknown>): McpTransport | null {
  if (typeof record.command === 'string' && record.command.trim()) {
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      type: 'stdio',
      command: record.command,
      args,
      ...(isStringRecord(record.env) ? { env: record.env } : {}),
    };
  }
  if (typeof record.url === 'string' && record.url.trim()) {
    const headers: Record<string, string> = {};
    if (isStringRecord(record.http_headers)) Object.assign(headers, record.http_headers);
    if (isStringRecord(record.env_http_headers)) {
      for (const [header, envVar] of Object.entries(record.env_http_headers)) {
        const value = process.env[envVar];
        if (value) headers[header] = value;
      }
    }
    if (typeof record.bearer_token_env_var === 'string') {
      const token = process.env[record.bearer_token_env_var];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return {
      type: 'http',
      url: record.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  return null;
}
