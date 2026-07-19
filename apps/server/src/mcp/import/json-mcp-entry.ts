import { looksLikeSecretKey } from '../domain/mcp-transport';
import type { McpTransport } from '../domain/mcp.types';

/**
 * Cursor `mcp.json` and Claude Code `mcpServers` entries share one JSON shape:
 * `{ command, args?, env? }` for stdio or `{ url, headers?, type? }` for
 * remotes. Returns null for entries that are neither (malformed rows are
 * skipped, never fatal — an import must survive one odd entry).
 */
export function jsonEntryToTransport(entry: unknown): McpTransport | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.command === 'string' && record.command.trim()) {
    return {
      type: 'stdio',
      command: record.command,
      args: toStringArray(record.args),
      ...(isStringRecord(record.env) ? { env: record.env } : {}),
    };
  }
  if (typeof record.url === 'string' && record.url.trim()) {
    return {
      type: record.type === 'sse' ? 'sse' : 'http',
      url: record.url,
      ...(isStringRecord(record.headers) ? { headers: record.headers } : {}),
    };
  }
  return null;
}

/** Env keys (stdio) or header keys (remote) whose values should be encrypted. */
export function detectSecretKeys(transport: McpTransport): string[] {
  const record = transport.type === 'stdio' ? transport.env : transport.headers;
  return Object.keys(record ?? {}).filter(looksLikeSecretKey);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}
