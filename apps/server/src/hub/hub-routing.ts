/**
 * Pure routing helpers for hub mode. A hub serves `/m/<machine>/...` and
 * proxies the downstream path to that machine's own nuncio. Both path parts
 * are untrusted URL input: the machine is charset-validated and registry-only,
 * while the downstream path is validated and canonicalized before auth or IO.
 */

const MACHINE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;
const HUB_PARSE_ORIGIN = 'http://nuncio-hub.invalid';

export interface HubPath {
  machine: string;
  targetPath: string;
}

function hasValidPercentEncoding(value: string): boolean {
  if (INVALID_PERCENT_ESCAPE.test(value)) return false;
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns one canonical downstream path (query preserved), or null when the
 * request target is malformed or structurally ambiguous. Encoded separators
 * are rejected because intermediaries disagree on whether they are path data
 * or segment boundaries.
 */
export function canonicalizeHubTargetPath(targetPath: string): string | null {
  if (!targetPath.startsWith('/') || targetPath.includes('#')) return null;
  if (!hasValidPercentEncoding(targetPath)) return null;

  const queryIndex = targetPath.indexOf('?');
  const rawPathname = queryIndex === -1 ? targetPath : targetPath.slice(0, queryIndex);
  if (rawPathname.includes('\\') || ENCODED_PATH_SEPARATOR.test(rawPathname)) return null;

  try {
    const parsed = new URL(targetPath, HUB_PARSE_ORIGIN);
    if (parsed.origin !== HUB_PARSE_ORIGIN || parsed.hash) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function parseHubPath(url: string): HubPath | null {
  if (!url.startsWith('/') || !hasValidPercentEncoding(url)) return null;
  const queryIndex = url.indexOf('?');
  const rawPathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (rawPathname.includes('\\')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url, HUB_PARSE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== HUB_PARSE_ORIGIN || parsed.hash) return null;

  const match = /^\/m\/([^/]+)(\/[^]*)?$/.exec(parsed.pathname);
  if (!match) return null;

  let machine: string;
  try {
    machine = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!MACHINE_SEGMENT.test(machine)) return null;

  const rest = match[2];
  const rawTargetPath = `${!rest || rest === '/' ? '/' : rest}${parsed.search}`;
  const targetPath = canonicalizeHubTargetPath(rawTargetPath);
  if (!targetPath) return null;
  return { machine, targetPath };
}

/**
 * Maps a machine name to its target origin, or null when the machine is not a
 * known registry entry. The registry is the ONLY source of target URLs; an
 * unknown machine name can never be turned into a request destination.
 */
export function resolveMachineTarget(
  machine: string,
  registry: ReadonlyMap<string, string>,
): string | null {
  if (!machine) return null;
  return registry.get(machine) ?? null;
}
