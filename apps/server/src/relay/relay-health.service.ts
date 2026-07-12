import { Injectable } from '@nestjs/common';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { TailscaleService } from '../tailscale/tailscale.service';
import type { RelayHealthDto, RelayPathHealth, RelayProbeResult } from './relay.types';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class RelayHealthService {
  fetchFn: typeof fetch = fetch;
  now: () => number = () => Date.now();
  networkInterfacesFn: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces;

  constructor(private readonly tailscale: TailscaleService) {}

  async probeAll(): Promise<RelayHealthDto> {
    const [lan, tailnet, funnel] = await Promise.all([
      this.measure(() => this.probeLan()),
      this.measure(() => this.probeTailnet()),
      this.measure(() => this.tailscale.probeFunnel()),
    ]);
    return { lan, tailnet, funnel };
  }

  private async probeLan(): Promise<RelayProbeResult> {
    const port = Number(process.env.PORT ?? 3000);
    const address = this.lanAddress();
    if (!address) return { status: 'down', reason: 'no LAN address available' };
    return this.probeUrl(`http://${address}:${port}/api/health`);
  }

  private async probeTailnet(): Promise<RelayProbeResult> {
    const status = await this.tailscale.status();
    if (!status.installed) return { status: 'down', reason: 'tailscale CLI unavailable' };
    if (!status.running) return { status: 'down', reason: 'tailscale is not running' };
    if (!status.self?.dnsName) return { status: 'down', reason: 'MagicDNS name unavailable' };
    return this.probeUrl(`https://${status.self.dnsName.replace(/\.$/, '')}/api/health`);
  }

  private async probeUrl(url: string): Promise<RelayProbeResult> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok
      ? { status: 'up' }
      : { status: 'down', reason: `health returned ${response.status}` };
  }

  private lanAddress(): string | null {
    for (const entries of Object.values(this.networkInterfacesFn())) {
      for (const entry of entries ?? []) {
        const ipv4 = entry.family === 'IPv4' || entry.family === 4;
        if (!ipv4 || entry.internal || entry.address.startsWith('169.254.')) continue;
        const match = /^100\.(\d{1,3})\./.exec(entry.address);
        if (match && Number(match[1]) >= 64 && Number(match[1]) <= 127) continue;
        return entry.address;
      }
    }
    return null;
  }

  private async measure(probe: () => Promise<RelayProbeResult>): Promise<RelayPathHealth> {
    const started = this.now();
    try {
      const result = await probe();
      return { ...result, latencyMs: Math.max(0, this.now() - started), probedAt: this.now() };
    } catch (error) {
      return {
        status: 'unknown',
        latencyMs: Math.max(0, this.now() - started),
        probedAt: this.now(),
        reason: error instanceof Error ? error.message : 'probe failed',
      };
    }
  }
}
