export interface TailscaleSelf {
  hostName: string;
  dnsName: string;
  ips: string[];
  os: string;
  loginName: string | null;
}

export interface TailscalePeer {
  hostName: string;
  dnsName: string;
  ips: string[];
  os: string;
  online: boolean;
  loginName: string | null;
  sameUser: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  autoTrust: boolean;
  tailnet: string | null;
  self: TailscaleSelf | null;
  peers: TailscalePeer[];
}

export const TAILSCALE_AUTO_TRUST_KEY = 'NUNCIO_TAILSCALE_AUTO_TRUST';

export async function fetchTailscaleStatus(): Promise<TailscaleStatus> {
  const res = await fetch('/api/tailscale/status');
  if (!res.ok) throw new Error(`Failed to load Tailscale status (${res.status})`);
  return (await res.json()) as TailscaleStatus;
}
