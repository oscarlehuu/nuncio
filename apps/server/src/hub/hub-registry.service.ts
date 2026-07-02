import { Injectable } from '@nestjs/common';
import { TailscaleService } from '../tailscale/tailscale.service';

export interface MachineEntry {
  /** Stable identifier used in /m/<name>/ URLs (MagicDNS first label). */
  name: string;
  dnsName: string;
  origin: string;
  os: string;
  self: boolean;
}

const NUNCIO_PORT = Number(process.env.NUNCIO_HUB_TARGET_PORT ?? 3000);
const PROBE_TIMEOUT_MS = 1_500;
const CACHE_TTL_MS = 15_000;

/** MagicDNS first label — a stable, human-recognizable machine id. */
export function machineName(dnsName: string): string {
  return dnsName ? dnsName.split('.')[0] : '';
}

async function defaultProbe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Auto-discovered registry of tailnet machines running nuncio. A machine is
 * eligible only if it is a same-account tailnet peer (or self), online, and
 * answers the nuncio health probe. This registry is the ONLY source of proxy
 * targets — the hub proxy resolves the untrusted /m/<machine> segment against
 * it, never against arbitrary input. Results are cached briefly.
 */
@Injectable()
export class HubRegistryService {
  /** Injectable health probe (overridden in tests). */
  probe: (url: string) => Promise<boolean> = defaultProbe;

  private cache: { at: number; machines: MachineEntry[] } | null = null;

  constructor(private readonly tailscale: TailscaleService) {}

  async discover(): Promise<MachineEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.machines;
    }

    const status = await this.tailscale.status();
    const machines: MachineEntry[] = [];

    if (status.self) {
      const dnsName = status.self.dnsName || status.self.hostName;
      machines.push({
        name: machineName(dnsName),
        dnsName,
        origin: originFor(dnsName),
        os: status.self.os,
        self: true,
      });
    }

    const candidates = status.peers.filter((peer) => peer.sameUser && peer.online);
    const probes = await Promise.all(
      candidates.map(async (peer) => {
        const dnsName = peer.dnsName || peer.hostName;
        const isNuncio = await this.probe(`${originFor(dnsName)}/api/health`);
        return isNuncio ? { peer, dnsName } : null;
      }),
    );

    for (const hit of probes) {
      if (!hit) continue;
      machines.push({
        name: machineName(hit.dnsName),
        dnsName: hit.dnsName,
        origin: originFor(hit.dnsName),
        os: hit.peer.os,
        self: false,
      });
    }

    this.cache = { at: now, machines };
    return machines;
  }

  async registryMap(): Promise<Map<string, string>> {
    const machines = await this.discover();
    return new Map(machines.map((m) => [m.name, m.origin]));
  }

  bustCache(): void {
    this.cache = null;
  }
}

function originFor(dnsName: string): string {
  return `http://${dnsName}:${NUNCIO_PORT}`;
}
