import { hasRemoteUrlUserinfo, looksLikeSecretKey } from '../domain/mcp-transport';
import type { McpTransport } from '../domain/mcp.types';

export interface DetectedTransportSecrets {
  secretKeys: string[];
  secretArgIndexes: number[];
  secretUrlQueryKeys: string[];
}

/**
 * Cursor `mcp.json` and Claude Code `mcpServers` entries share one JSON shape:
 * `{ command, args?, env? }` for stdio or `{ url, headers?, type? }` for
 * remotes. Malformed rows are skipped so one odd entry cannot break an import.
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
    if (!isValidRemoteUrl(record.url)) return null;
    return {
      type: record.type === 'sse' ? 'sse' : 'http',
      url: record.url,
      ...(isStringRecord(record.headers) ? { headers: record.headers } : {}),
    };
  }
  return null;
}

/** Detect every imported transport location that may carry credential material. */
export function detectTransportSecrets(transport: McpTransport): DetectedTransportSecrets {
  return {
    secretKeys: detectSecretKeys(transport),
    secretArgIndexes:
      transport.type === 'stdio' ? detectSecretArgIndexes(transport.args) : [],
    secretUrlQueryKeys:
      transport.type === 'stdio' ? [] : queryKeys(transport.url),
  };
}

/** Secret-like env names; every imported HTTP header value is sensitive. */
function detectSecretKeys(transport: McpTransport): string[] {
  if (transport.type !== 'stdio') return Object.keys(transport.headers ?? {});
  return Object.keys(transport.env ?? {}).filter(looksLikeSecretKey);
}

function detectSecretArgIndexes(args: string[]): number[] {
  const indexes = new Set<number>();
  let previousExpectsSecret = false;
  for (const [index, arg] of args.entries()) {
    if (previousExpectsSecret) {
      indexes.add(index);
      previousExpectsSecret = false;
      continue;
    }
    const equalsAt = arg.indexOf('=');
    if (equalsAt > 0) {
      const name = normalizedFlagName(arg.slice(0, equalsAt));
      const nested = arg.slice(equalsAt + 1);
      const nestedEqualsAt = nested.indexOf('=');
      const nestedName = nestedEqualsAt > 0 ? nested.slice(0, nestedEqualsAt) : '';
      if (
        isSecretFlag(name) ||
        looksLikeSecretKey(name) ||
        (nestedName && looksLikeSecretKey(nestedName))
      ) {
        indexes.add(index);
      }
    }
    if (queryKeys(arg).length > 0) indexes.add(index);
    if (arg.startsWith('-') && equalsAt < 0) {
      const name = normalizedFlagName(arg);
      previousExpectsSecret = isSecretFlag(name) || looksLikeSecretKey(name);
    }
  }
  return [...indexes];
}

function normalizedFlagName(value: string): string {
  return value.replace(/^-+/, '').replace(/-/g, '_');
}

function isSecretFlag(name: string): boolean {
  return ['header', 'headers'].includes(name.toLowerCase());
}

function queryKeys(value: string): string[] {
  try {
    const parsed = new URL(value);
    return [...new Set([...parsed.searchParams.keys()])];
  } catch {
    const query = looseQuery(value);
    return query ? [...new Set([...new URLSearchParams(query).keys()])] : [];
  }
}

function looseQuery(value: string): string | null {
  const question = value.indexOf('?');
  if (question < 0) return null;
  const fragment = value.indexOf('#', question + 1);
  return value.slice(question + 1, fragment < 0 ? undefined : fragment);
}

export function isValidRemoteUrl(value: string): boolean {
  try {
    new URL(value);
    return !hasRemoteUrlUserinfo(value);
  } catch {
    return false;
  }
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
