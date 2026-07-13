import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type {
  TailscaleFunnelProbe,
  TailscalePeerDto,
  TailscaleStatusDto,
} from './tailscale.types';
import {
  publishedRelayStatusFromConfig,
  type PublishedRelayStatus,
} from './tailscale-serve-config';

export { publishedRelayStatusFromConfig, type PublishedRelayStatus } from './tailscale-serve-config';

export const TAILSCALE_AUTO_TRUST_KEY = 'NUNCIO_TAILSCALE_AUTO_TRUST';

const CLI_TIMEOUT_MS = 3_000;
// First `serve` may provision an HTTPS cert; give serve/funnel a longer budget.
const SERVE_TIMEOUT_MS = 10_000;
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

export type ExecResult = { ok: boolean; stdout: string; stderr?: string };
export type ExecFn = (argv: string[], timeoutMs?: number) => Promise<ExecResult>;

// A hung CLI must never pin an HTTP request: the deadline resolves regardless of
// process state, so no read/exit await can dangle. On timeout we escalate SIGTERM
// then SIGKILL rather than leaking the subprocess.
const KILL_GRACE_MS = 500;

export async function defaultExec(argv: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<ExecResult> {
  let spawned: ReturnType<typeof spawnPipe>;
  try {
    spawned = spawnPipe(argv);
  } catch {
    // spawn itself failed (missing binary, permission) — treat as a failed run.
    return { ok: false, stdout: '', stderr: '' };
  }

  try {
    const work: Promise<ExecResult> = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
      ]);
      const code = await spawned.exited;
      return { ok: code === 0, stdout, stderr };
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ExecResult>((resolve) => {
      timer = setTimeout(() => {
        // SIGTERM, brief grace, then SIGKILL — do not await the process; resolve now.
        // The grace timer is unref'd so an already-doomed child never keeps the
        // process alive after the caller has its result.
        killQuietly(spawned);
        const killTimer = setTimeout(() => killQuietly(spawned, 'SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
        resolve({ ok: false, stdout: '', stderr: '' });
      }, timeoutMs);
    });

    const result = await Promise.race([work, deadline]);
    clearTimeout(timer);
    return result;
  } catch {
    killQuietly(spawned, 'SIGKILL');
    return { ok: false, stdout: '', stderr: '' };
  }
}

/** Spawn with piped stdout/stderr; kept separate so its return type narrows the streams. */
function spawnPipe(argv: string[]) {
  return Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
}

function killQuietly(proc: ReturnType<typeof spawnPipe>, signal?: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {
    // process may already have exited
  }
}

export type ServeResult = boolean;
export type FunnelResult = { ok: true } | { ok: false; reason: 'acl' | 'error' };

/** Tailscale prints an ACL/permission denial when Funnel isn't enabled for the node. */
function isFunnelAclDenial(stderr: string): boolean {
  const text = stderr.toLowerCase();
  if (!text.includes('funnel')) return false;
  return (
    text.includes('not allowed') ||
    text.includes('not permitted') ||
    text.includes('denied') ||
    text.includes('acl') ||
    text.includes('not enabled') ||
    text.includes('does not have') ||
    text.includes('requires the following')
  );
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

  /** Current Serve/Funnel publication for the daemon port; never changes host config. */
  async publishedRelayStatus(port: number): Promise<PublishedRelayStatus> {
    const bin = await this.resolveBin();
    if (!bin) return { serve: false, funnel: false };
    const result = await this.exec([bin, 'serve', 'status', '--json']);
    if (!result.ok) return { serve: false, funnel: false };
    try {
      return publishedRelayStatusFromConfig(JSON.parse(result.stdout), port);
    } catch {
      return { serve: false, funnel: false };
    }
  }

  /**
   * `tailscale serve --bg <port>` — maps tailnet HTTPS (443) to the local port so
   * the MagicDNS name reaches this server. Idempotent (the CLI upserts the config).
   * Only ever called from an explicit pairing action, never at boot. Degrades to
   * false when the CLI is missing or the command fails; never throws.
   */
  async enableServe(port: number): Promise<ServeResult> {
    const bin = await this.resolveBin();
    if (!bin) return false;
    const result = await this.exec([bin, 'serve', '--bg', String(port)], SERVE_TIMEOUT_MS);
    if (!result.ok) {
      this.logCliFailure('serve', result.stderr);
    }
    return result.ok;
  }

  /**
   * `tailscale funnel --bg <port>` — exposes the serve mapping to the public
   * internet over HTTPS. Rides the serve config (same hostname, no new URL).
   * Idempotent. Distinguishes an ACL denial (Funnel disabled for this node/tailnet)
   * from any other failure — an older CLI without the `funnel` subcommand is a
   * generic error. Only called from an explicit pairing action, never at boot.
   */
  async enableFunnel(port: number): Promise<FunnelResult> {
    const bin = await this.resolveBin();
    if (!bin) return { ok: false, reason: 'error' };
    const result = await this.exec([bin, 'funnel', '--bg', String(port)], SERVE_TIMEOUT_MS);
    if (result.ok) return { ok: true };
    const stderr = result.stderr ?? '';
    this.logCliFailure('funnel', stderr);
    return { ok: false, reason: isFunnelAclDenial(stderr) ? 'acl' : 'error' };
  }

  /** Read-only Funnel configuration probe. Errors are unknown, never evidence of down. */
  async probeFunnel(): Promise<TailscaleFunnelProbe> {
    const bin = await this.resolveBin();
    if (!bin) return { status: 'unknown', reason: 'tailscale CLI unavailable' };
    const result = await this.exec([bin, 'funnel', 'status', '--json']);
    if (!result.ok) return { status: 'unknown', reason: 'funnel status probe failed' };
    try {
      const parsed = JSON.parse(result.stdout) as { AllowFunnel?: unknown };
      if (!parsed.AllowFunnel || typeof parsed.AllowFunnel !== 'object') {
        return { status: 'unknown', reason: 'unrecognized funnel status' };
      }
      const enabled = Object.values(parsed.AllowFunnel as Record<string, unknown>)
        .some((value) => value === true);
      return enabled
        ? { status: 'up' }
        : { status: 'down', reason: 'funnel is not configured' };
    } catch {
      return { status: 'unknown', reason: 'invalid funnel status response' };
    }
  }

  private logCliFailure(command: string, stderr: string | undefined): void {
    const detail = (stderr ?? '').trim();
    console.warn(`[tailscale] ${command} failed${detail ? `: ${detail.split('\n')[0]}` : ''}`);
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
