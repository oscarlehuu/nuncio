import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { TailscalePeerDto, TailscaleStatusDto } from './tailscale.types';

export const TAILSCALE_AUTO_TRUST_KEY = 'NUNCIO_TAILSCALE_AUTO_TRUST';

const CLI_TIMEOUT_MS = 3_000;
const WHOIS_TTL_MS = 60_000;

const BIN_CANDIDATES = [
  'tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

export function normalizeRemoteAddress(addr: unknown): string | null {
  if (typeof addr !== 'string' || !addr) return null;
  return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

/** Tailscale addresses: IPv4 CGNAT 100.64.0.0/10 or the tailnet ULA fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(addr: string): boolean {
  const v4 = /^100\.(\d{1,3})\./.exec(addr);
  if (v4) {
    const second = Number(v4[1]);
    return second >= 64 && second <= 127;
  }
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0');
}

export type ExecResult = { ok: boolean; stdout: string };
export type ExecFn = (argv: string[]) => Promise<ExecResult>;

async function defaultExec(argv: string[]): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

interface RawNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  UserID?: number;
  Online?: boolean;
}

interface RawStatus {
  BackendState?: string;
  Self?: RawNode;
  User?: Record<string, { LoginName?: string }>;
  Peer?: Record<string, RawNode>;
  CurrentTailnet?: { Name?: string };
}

/**
 * Wraps the local Tailscale CLI. Two consumers: the settings UI
 * (GET /api/tailscale/status → device list) and the auth layer
 * (isTrustedRemote → auto-trust tailnet peers owned by the same account,
 * identity verified by `tailscale whois`). Everything degrades to
 * "not trusted / not installed" when the CLI is absent or errors.
 */
@Injectable()
export class TailscaleService {
  /** Injectable CLI runner (overridden in unit tests). */
  exec: ExecFn = defaultExec;

  private binPromise: Promise<string | null> | null = null;
  private whoisCache = new Map<string, { userId: number | null; expires: number }>();
  private selfCache: { userId: number | null; expires: number } | null = null;

  constructor(private readonly settings: SettingsService) {}

  autoTrustEnabled(): boolean {
    return this.settings.resolve(TAILSCALE_AUTO_TRUST_KEY) !== '0';
  }

  async status(): Promise<TailscaleStatusDto> {
    const autoTrust = this.autoTrustEnabled();
    const base: TailscaleStatusDto = {
      installed: false,
      running: false,
      autoTrust,
      tailnet: null,
      self: null,
      peers: [],
    };

    const bin = await this.resolveBin();
    if (!bin) return base;

    const raw = await this.rawStatus(bin);
    if (!raw) return { ...base, installed: true };

    const running = raw.BackendState === 'Running';
    const users = raw.User ?? {};
    const loginOf = (userId: number | undefined): string | null =>
      userId !== undefined ? (users[String(userId)]?.LoginName ?? null) : null;
    const selfUserId = typeof raw.Self?.UserID === 'number' ? raw.Self.UserID : null;

    const self = raw.Self
      ? {
          hostName: raw.Self.HostName ?? '',
          dnsName: trimTrailingDot(raw.Self.DNSName),
          ips: raw.Self.TailscaleIPs ?? [],
          os: raw.Self.OS ?? '',
          loginName: loginOf(raw.Self.UserID),
        }
      : null;

    const peers: TailscalePeerDto[] = Object.values(raw.Peer ?? {})
      .map((peer) => ({
        hostName: peer.HostName ?? '',
        dnsName: trimTrailingDot(peer.DNSName),
        ips: peer.TailscaleIPs ?? [],
        os: peer.OS ?? '',
        online: peer.Online === true,
        loginName: loginOf(peer.UserID),
        sameUser: selfUserId !== null && peer.UserID === selfUserId,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));

    return {
      installed: true,
      running,
      autoTrust,
      tailnet: raw.CurrentTailnet?.Name ?? null,
      self,
      peers,
    };
  }

  /**
   * True only when the auto-trust toggle is on, the address is a tailnet
   * address, and `tailscale whois` proves the peer belongs to the same
   * Tailscale account as this server. Cheap early-outs keep non-tailnet
   * requests from ever spawning a subprocess; whois results are cached.
   */
  async isTrustedRemote(remoteAddress: unknown): Promise<boolean> {
    if (!this.autoTrustEnabled()) return false;
    const addr = normalizeRemoteAddress(remoteAddress);
    if (!addr || !isTailscaleAddress(addr)) return false;

    const bin = await this.resolveBin();
    if (!bin) return false;

    const selfUserId = await this.selfUserId(bin);
    if (selfUserId === null) return false;

    const peerUserId = await this.whoisUserId(bin, addr);
    return peerUserId !== null && peerUserId === selfUserId;
  }

  private resolveBin(): Promise<string | null> {
    if (!this.binPromise) {
      this.binPromise = (async () => {
        const candidates = [process.env.NUNCIO_TAILSCALE_BIN, ...BIN_CANDIDATES];
        for (const candidate of candidates) {
          if (!candidate) continue;
          const result = await this.exec([candidate, 'version']);
          if (result.ok) return candidate;
        }
        return null;
      })();
    }
    return this.binPromise;
  }

  private async rawStatus(bin: string): Promise<RawStatus | null> {
    const result = await this.exec([bin, 'status', '--json']);
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout) as RawStatus;
    } catch {
      return null;
    }
  }

  private async selfUserId(bin: string): Promise<number | null> {
    const now = Date.now();
    if (this.selfCache && this.selfCache.expires > now) return this.selfCache.userId;
    const raw = await this.rawStatus(bin);
    const userId = typeof raw?.Self?.UserID === 'number' ? raw.Self.UserID : null;
    this.selfCache = { userId, expires: now + WHOIS_TTL_MS };
    return userId;
  }

  private async whoisUserId(bin: string, addr: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.whoisCache.get(addr);
    if (cached && cached.expires > now) return cached.userId;

    let userId: number | null = null;
    const result = await this.exec([bin, 'whois', '--json', addr]);
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout) as { UserProfile?: { ID?: number } };
        userId = typeof parsed.UserProfile?.ID === 'number' ? parsed.UserProfile.ID : null;
      } catch {
        userId = null;
      }
    }
    this.whoisCache.set(addr, { userId, expires: now + WHOIS_TTL_MS });
    return userId;
  }
}

function trimTrailingDot(value: string | undefined): string {
  if (!value) return '';
  return value.endsWith('.') ? value.slice(0, -1) : value;
}
