export interface PublishedRelayStatus {
  serve: boolean;
  funnel: boolean;
}

/** Reads the CLI's serve-config JSON shape without mutating host configuration. */
export function publishedRelayStatusFromConfig(
  config: unknown,
  port: number,
): PublishedRelayStatus {
  if (!config || typeof config !== 'object') return { serve: false, funnel: false };
  const root = config as Record<string, unknown>;
  const web = asRecord(root.Web);
  const publishedHosts = Object.entries(web)
    .filter(([, handlers]) => containsProxyForPort(handlers, port))
    .map(([host]) => host);
  const allowFunnel = asRecord(root.AllowFunnel);
  return {
    serve: publishedHosts.length > 0,
    funnel: publishedHosts.some((host) => allowFunnel[host] === true),
  };
}

function containsProxyForPort(value: unknown, port: number): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'Proxy' && typeof child === 'string') {
      try {
        const target = new URL(child);
        if (Number(target.port || (target.protocol === 'https:' ? 443 : 80)) === port) return true;
      } catch {
        // Ignore malformed/non-URL handler values and keep walking the config.
      }
    }
    if (containsProxyForPort(child, port)) return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
