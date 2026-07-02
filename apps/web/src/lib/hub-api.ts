import { API_BASE, isMachineSegment } from './api-base';

export interface HubMachine {
  name: string;
  dnsName: string;
  origin: string;
  os: string;
  self: boolean;
}

export interface HubMachines {
  hubMode: boolean;
  machines: HubMachine[];
}

export async function fetchHubMachines(): Promise<HubMachines> {
  // Always query the HUB itself (origin root), not the machine currently being
  // viewed through it — the origin-absolute URL bypasses the /api base rewrite,
  // so the switcher stays populated even at /m/<machine>/ (where the proxied
  // machine is not itself a hub).
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const res = await fetch(`${origin}/api/hub/machines`);
  if (!res.ok) throw new Error(`Failed to load hub machines (${res.status})`);
  return (await res.json()) as HubMachines;
}

/** The machine this page is currently viewing: the /m/<machine> segment of the
 * base path, or null when served at the hub root (the hub's own machine). */
export function currentMachine(base: string = API_BASE): string | null {
  const match = /^\/m\/(.+)$/.exec(base);
  return match ? match[1] : null;
}

/** Origin-absolute URL for a machine's app under the hub. */
export function machineHref(name: string): string {
  return `/m/${name}/`;
}

/**
 * Origin-absolute API base for a specific machine, for per-call routing (grid
 * tiles bound to another machine). Absolute URLs bypass the page-level fetch
 * rewrite, so requests built on this base reach the chosen machine no matter
 * which base path the page itself is served under. Empty string means "the
 * machine this page is already talking to" (page-relative, rewritten as usual).
 */
export function machineApiBase(machineId: string | null | undefined): string {
  if (!machineId || typeof window === 'undefined') return '';
  if (!isMachineSegment(machineId)) return '';
  return `${window.location.origin}/m/${machineId}`;
}
