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

export interface ProvisionPushResult {
  target: string;
  sent: { piFiles: string[]; settings: string[] };
  applied: {
    piFilesWritten: string[];
    piFilesBackedUp: string[];
    settingsApplied: string[];
    settingsSkipped: string[];
  };
}

/** Pushes this server's Pi credentials + settings to another nuncio server. */
export async function pushProvision(target: string): Promise<ProvisionPushResult> {
  const res = await fetch('/api/provision/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    let message = `Sync failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
  return (await res.json()) as ProvisionPushResult;
}
