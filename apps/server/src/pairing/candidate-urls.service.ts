import { Injectable } from '@nestjs/common';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { TailscaleService } from '../tailscale/tailscale.service';

type NetworkInterfacesFn = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface CandidateUrls {
  urls: string[];
  hints: string[];
  endpoints: RelayEndpoints;
}

export interface RelayEndpoints {
  lan: string[];
  tailnet?: string;
  funnel?: string;
}

// A QR encodes 2-4 URLs + a code (~200-350 bytes for a comfortable scan); cap LAN
// IPs so multi-homed hosts (Wi-Fi + Ethernet + VM bridges) don't blow the QR up.
const MAX_LAN_URLS = 4;

const HINT_TAILSCALE_OFFLINE = 'Tailscale offline — pairing works on this Wi-Fi only';
const HINT_FUNNEL_UNAVAILABLE =
  'Tailscale Funnel unavailable — remote access needs Tailscale on the phone';
const HINT_SERVE_FAILED = 'Tailscale Serve setup failed — pairing works on this Wi-Fi only';

/**
 * Builds the reachable URLs a phone should try, in priority order:
 *   1. LAN IPv4 (works on the same Wi-Fi with nothing installed)
 *   2. MagicDNS HTTPS (self.dnsName) once `tailscale serve` is configured
 * Funnel adds no new URL — it rides the same serve hostname — so it only affects
 * hints: with Funnel the phone reaches the desktop from anywhere; without it the
 * phone still needs Tailscale itself.
 *
 * Every degraded mode produces a URL set + hints rather than an error: serve/funnel
 * automation is best-effort and never throws out of the pairing flow.
 */
@Injectable()
export class CandidateUrlsService {
  /** Overridable seam for tests; defaults to the real os.networkInterfaces(). */
  networkInterfacesFn: NetworkInterfacesFn = networkInterfaces;

  constructor(private readonly tailscale: TailscaleService) {}

  async build(): Promise<CandidateUrls> {
    const port = Number(process.env.PORT ?? 3000);
    const lan = this.lanUrls(port);
    const urls = [...lan];
    const hints: string[] = [];
    const endpoints: RelayEndpoints = { lan };

    await this.appendMagicDns(port, urls, hints, endpoints);

    return { urls, hints, endpoints };
  }

  /** Reads the current published ladder without enabling or changing Serve/Funnel. */
  async discover(): Promise<RelayEndpoints> {
    const port = Number(process.env.PORT ?? 3000);
    const endpoints: RelayEndpoints = { lan: this.lanUrls(port) };
    try {
      const [status, published] = await Promise.all([
        this.tailscale.status(),
        this.tailscale.publishedRelayStatus(port),
      ]);
      if (!status.running || !status.self?.dnsName || !published.serve) return endpoints;
      const url = `https://${stripTrailingDot(status.self.dnsName)}`;
      endpoints.tailnet = url;
      if (published.funnel) endpoints.funnel = url;
    } catch {
      // LAN remains usable when Tailscale status/config discovery fails.
    }
    return endpoints;
  }

  private lanUrls(port: number): string[] {
    return lanIpv4Addresses(this.networkInterfacesFn())
      .slice(0, MAX_LAN_URLS)
      .map((address) => `http://${address}:${port}`);
  }

  /**
   * MagicDNS + Funnel: mutates urls/hints in place. Any tailscale-layer failure
   * (error, rejection, or a hung CLI that hit its deadline) degrades to LAN-only
   * with the offline hint — pairing/start must never throw or hang on this.
   */
  private async appendMagicDns(
    port: number,
    urls: string[],
    hints: string[],
    endpoints: RelayEndpoints,
  ): Promise<void> {
    let status: Awaited<ReturnType<TailscaleService['status']>>;
    try {
      status = await this.tailscale.status();
    } catch {
      hints.push(HINT_TAILSCALE_OFFLINE);
      return;
    }
    if (!status.running) {
      hints.push(HINT_TAILSCALE_OFFLINE);
      return;
    }
    // Running but no MagicDNS name (rare): tailnet is up, so no "offline" hint;
    // just skip the HTTPS candidate and leave LAN to carry the pairing.
    if (!status.self?.dnsName) {
      return;
    }

    // MagicDNS is only reachable once serve maps tailnet HTTPS to this port. A
    // rejection here (unexpected) is treated the same as a serve failure: LAN only.
    let served: boolean;
    try {
      served = await this.tailscale.enableServe(port);
    } catch {
      served = false;
    }
    if (!served) {
      // Tailnet is up but we couldn't publish the mapping; LAN still works, and the
      // user must hear why the HTTPS path is missing. No Funnel attempt (nothing to ride).
      hints.push(HINT_SERVE_FAILED);
      return;
    }

    const tailnetUrl = `https://${stripTrailingDot(status.self.dnsName)}`;
    urls.push(tailnetUrl);
    endpoints.tailnet = tailnetUrl;

    // Funnel makes the same URL reachable from outside the tailnet. On denial (or a
    // rejection) the URL stays (works over Tailscale) but we warn the phone needs it.
    let funnelOk: boolean;
    try {
      funnelOk = (await this.tailscale.enableFunnel(port)).ok;
    } catch {
      funnelOk = false;
    }
    if (!funnelOk) {
      hints.push(HINT_FUNNEL_UNAVAILABLE);
      return;
    }
    endpoints.funnel = tailnetUrl;
  }
}

function isIpv4(family: string | number): boolean {
  // Node <18 reports the string 'IPv4'; Node >=18 reports the number 4.
  return family === 'IPv4' || family === 4;
}

/** LAN IPv4s only: drop loopback/internal, link-local (169.254/16) and CGNAT/tailnet (100.64/10). */
function lanIpv4Addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.internal || !isIpv4(entry.family)) {
        continue;
      }
      if (entry.address.startsWith('169.254.') || isCarrierGradeNat(entry.address)) {
        continue;
      }
      found.push(entry.address);
    }
  }
  return found;
}

/** 100.64.0.0/10 — CGNAT range Tailscale draws from; not a LAN address a phone should dial directly. */
function isCarrierGradeNat(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4 || octets[0] !== '100') {
    return false;
  }
  const second = Number(octets[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}

function stripTrailingDot(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}
