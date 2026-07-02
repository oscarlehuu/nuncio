/**
 * Pure routing helpers for hub mode. A hub serves `/m/<machine>/...` and
 * proxies the downstream path to that machine's own nuncio. The machine
 * segment is UNTRUSTED input from the URL, so it is (a) charset-validated
 * here and (b) resolved ONLY against the registry in resolveMachineTarget —
 * it is NEVER used to construct a target URL directly (SSRF guard).
 */

const MACHINE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export interface HubPath {
  machine: string;
  targetPath: string;
}

export function parseHubPath(url: string): HubPath | null {
  const match = /^\/m\/([^/]+)(\/[^]*)?$/.exec(url);
  if (!match) return null;
  const machine = decodeURIComponent(match[1]);
  if (!MACHINE_SEGMENT.test(machine)) return null;
  const rest = match[2];
  const targetPath = !rest || rest === '/' ? '/' : rest;
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
