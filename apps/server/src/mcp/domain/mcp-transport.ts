import { createHash } from 'node:crypto';
import type { McpTransport } from './mcp.types';

/**
 * Stable import-dedupe identity. Environment, cwd, and headers remain excluded
 * so registrations of the same server merge across source stores. The identity
 * is hashed because CLI args and remote query values may contain credentials and
 * the result is persisted in a plaintext indexed column.
 */
export function transportIdentity(transport: McpTransport): string {
  const canonical =
    transport.type === 'stdio'
      ? ['stdio', transport.command, ...transport.args]
      : ['remote', normalizeUrl(transport.url)];
  return `v2:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/** URL userinfo is forbidden because transport URLs are persisted and returned by the API. */
export function hasRemoteUrlUserinfo(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

const WORKSPACE_PLACEHOLDER = '${workspace}';

/**
 * Resolve `${workspace}` placeholders against the session workspace (worktree
 * cwd for worktree sessions). A null workspace leaves placeholders untouched —
 * the server then runs exactly as configured.
 */
export function resolveTransport(transport: McpTransport, workspace: string | null): McpTransport {
  const sub = (value: string): string =>
    workspace ? value.split(WORKSPACE_PLACEHOLDER).join(workspace) : value;
  if (transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: sub(transport.command),
      args: transport.args.map(sub),
      ...(transport.env ? { env: mapValues(transport.env, sub) } : {}),
      ...(transport.cwd ? { cwd: sub(transport.cwd) } : {}),
    };
  }
  return {
    type: transport.type,
    url: sub(transport.url),
    ...(transport.headers ? { headers: mapValues(transport.headers, sub) } : {}),
  };
}

function mapValues(
  record: Record<string, string>,
  fn: (value: string) => string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));
}

const SECRET_KEY_PATTERN =
  /(token|secret|key|password|passwd|credential|authorization|auth|bearer|(^|_)pat($|_))/i;
const SECRET_KEY_EXCLUDES = /^(path|node_env|content-type)$/i;

/**
 * Heuristic used at import time to decide which env values must be encrypted at
 * rest. Header values are all treated as secret by the import scanners.
 */
export function looksLikeSecretKey(key: string): boolean {
  if (SECRET_KEY_EXCLUDES.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}
