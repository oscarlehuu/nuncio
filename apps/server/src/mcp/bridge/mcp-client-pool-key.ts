import { createHash } from 'node:crypto';
import type { McpTransport } from '../domain/mcp.types';
import type { McpClientConnectOptions } from './mcp-client.types';

/** Fingerprinted identity keeps raw credentials out of long-lived map keys. */
export function mcpClientPoolKey(
  transport: McpTransport,
  options?: McpClientConnectOptions,
): string {
  const principal = options?.principalId ?? (options?.authProvider ? 'oauth:unspecified' : 'transport');
  return `${mcpTransportFingerprint(transport)}:${fingerprint(principal)}`;
}

export function mcpTransportFingerprint(transport: McpTransport): string {
  if (transport.type === 'stdio') {
    return fingerprint([
      'stdio',
      transport.command,
      transport.args,
      transport.env ?? {},
      transport.cwd ?? null,
    ]);
  }
  return fingerprint([transport.type, transport.url, transport.headers ?? {}]);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
