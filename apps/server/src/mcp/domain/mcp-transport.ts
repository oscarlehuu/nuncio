import type { McpTransport } from './mcp.types';

/**
 * Stable identity of a transport, used to dedupe imports across source stores
 * (the same `bridgememory` command registered in Cursor, Claude and Codex must
 * collapse into one row). Identity deliberately ignores env/cwd/headers — those
 * are configuration of the same server, not a different server. Remote urls
 * are compared without a trailing slash and case-insensitively on the host.
 */
export function transportIdentity(transport: McpTransport): string {
  if (transport.type === 'stdio') {
    return `stdio:${JSON.stringify([transport.command, ...transport.args])}`;
  }
  return `remote:${normalizeUrl(transport.url)}`;
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

const SECRET_KEY_PATTERN = /(token|secret|key|password|passwd|credential|authorization|auth)/i;
const SECRET_KEY_EXCLUDES = /^(path|node_env|content-type)$/i;

/**
 * Heuristic used at import time to decide which env/header values must be
 * encrypted at rest. Users can adjust the flagged set per server afterwards.
 */
export function looksLikeSecretKey(key: string): boolean {
  if (SECRET_KEY_EXCLUDES.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}
