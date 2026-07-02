import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { fetchAuthToken, type AuthTokenInfo } from '../lib/auth-api';
import {
  fetchTailscaleStatus,
  pushProvision,
  TAILSCALE_AUTO_TRUST_KEY,
  type TailscalePeer,
  type TailscaleStatus,
} from '../lib/tailscale-api';
import { updateSetting } from '../lib/settings-api';

const PROBE_TIMEOUT_MS = 1_500;

/** Probes a peer for a reachable nuncio server (public /api/health, CORS-open). */
async function probeNuncio(dnsName: string): Promise<boolean> {
  if (!dnsName) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${dnsName}:3000/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function PeerRow({ peer, autoTrust }: { peer: TailscalePeer; autoTrust: boolean }) {
  const [hasNuncio, setHasNuncio] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'failed'>('idle');
  const desktopServers = window.nuncioDesktop?.servers;

  const handleSyncConfig = async () => {
    if (syncState === 'syncing') return;
    const confirmed = window.confirm(
      `Push this server's Pi credentials and settings to ${peer.hostName}? ` +
        'Existing files there are backed up first. Note: OAuth/subscription ' +
        'credentials shared across machines can occasionally require a re-login.',
    );
    if (!confirmed) return;
    setSyncState('syncing');
    try {
      await pushProvision(`http://${peer.dnsName}:3000`);
      setSyncState('done');
    } catch {
      setSyncState('failed');
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (peer.online) {
      probeNuncio(peer.dnsName).then((ok) => {
        if (!cancelled) setHasNuncio(ok);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [peer.online, peer.dnsName]);

  const trusted = peer.sameUser && autoTrust;

  return (
    <div className="flex items-center justify-between py-2.5 px-4">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`size-2 rounded-full flex-shrink-0 ${peer.online ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
          aria-label={peer.online ? 'online' : 'offline'}
        />
        <div className="flex flex-col min-w-0">
          <span className="text-ui-lg font-medium text-foreground truncate">{peer.hostName}</span>
          <span className="text-ui-sm text-muted-foreground truncate">
            {peer.os}
            {peer.loginName ? ` · ${peer.loginName}` : ''}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Badge variant={trusted ? 'default' : 'outline'} className="text-ui-xs">
          {trusted ? 'Trusted' : 'Token required'}
        </Badge>
        {hasNuncio && peer.sameUser && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-ui"
            onClick={() => void handleSyncConfig()}
            disabled={syncState === 'syncing'}
          >
            {syncState === 'syncing'
              ? 'Syncing…'
              : syncState === 'done'
                ? 'Synced ✓'
                : syncState === 'failed'
                  ? 'Sync failed — retry'
                  : 'Sync config'}
          </Button>
        )}
        {hasNuncio &&
          (desktopServers ? (
            // Desktop shell: switch the whole app to that server in place.
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-ui"
              onClick={() => void desktopServers.connect(`http://${peer.dnsName}:3000`)}
            >
              Connect
            </Button>
          ) : (
            <Button asChild variant="outline" size="sm" className="h-7 px-2 text-ui">
              <a href={`http://${peer.dnsName}:3000`} target="_blank" rel="noreferrer">
                Open
                <ExternalLink className="size-3 ml-1" />
              </a>
            </Button>
          ))}
      </div>
    </div>
  );
}

/**
 * Settings section for reaching this server from other machines: shows the
 * access token (for manual client setup) and the Tailscale integration —
 * tailnet devices, per-device trust, and the auto-trust toggle.
 */
export function RemoteAccessSettingsSection() {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<AuthTokenInfo | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(() => {
    fetchTailscaleStatus()
      .then((next) => {
        setStatus(next);
        setStatusFailed(false);
      })
      .catch(() => setStatusFailed(true));
  }, []);

  useEffect(() => {
    loadStatus();
    fetchAuthToken()
      .then(setTokenInfo)
      .catch(() => {
        // Token stays hidden when the server is unreachable.
      });
  }, [loadStatus]);

  const handleToggleTrust = async () => {
    if (!status || saving) return;
    setSaving(true);
    try {
      await updateSetting(TAILSCALE_AUTO_TRUST_KEY, status.autoTrust ? '0' : '1');
      loadStatus();
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!tokenInfo) return;
    try {
      await navigator.clipboard.writeText(tokenInfo.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); the reveal button still works.
    }
  };

  return (
    <section>
      <h2 className="text-ui-lg font-medium text-muted-foreground mb-2">Remote access</h2>
      <div className="border border-border rounded-xl overflow-hidden bg-card divide-y divide-border/60">
        {/* Access token */}
        <div className="py-3 px-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col min-w-0">
              <span className="text-ui-lg font-medium text-foreground">Access token</span>
              <span className="text-ui text-muted-foreground">
                Paste this once on devices outside your tailnet to connect to this server.
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-ui"
                onClick={() => setRevealed((prev) => !prev)}
                disabled={!tokenInfo}
                aria-label={revealed ? 'Hide access token' : 'Reveal access token'}
              >
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-ui"
                onClick={handleCopy}
                disabled={!tokenInfo}
                aria-label="Copy access token"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          </div>
          {revealed && tokenInfo && (
            <code className="mt-2 block text-ui font-mono bg-muted/40 rounded px-2 py-1.5 break-all">
              {tokenInfo.token}
            </code>
          )}
        </div>

        {/* Tailscale */}
        <div className="py-3 px-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col min-w-0">
              <span className="text-ui-lg font-medium text-foreground">Tailscale</span>
              <span className="text-ui text-muted-foreground">
                {statusFailed || !status
                  ? 'Checking Tailscale…'
                  : !status.installed
                    ? 'Not detected on this machine.'
                    : !status.running
                      ? 'Installed, but not running or not logged in.'
                      : `${status.self?.hostName ?? 'This machine'} · ${status.self?.loginName ?? ''}${status.tailnet ? ` · ${status.tailnet}` : ''}`}
              </span>
            </div>
            {status?.installed && status.running && (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-ui text-muted-foreground">Trust my devices</span>
                <Switch
                  checked={status.autoTrust}
                  onCheckedChange={() => void handleToggleTrust()}
                  disabled={saving}
                  aria-label="Trust my Tailscale devices"
                />
              </div>
            )}
          </div>

          {status && !status.installed && (
            <p className="mt-2 text-ui text-muted-foreground">
              Install Tailscale on this machine and your other devices to connect without tokens,
              port-forwarding, or TLS setup:{' '}
              <a
                href="https://tailscale.com/download"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                tailscale.com/download
              </a>
            </p>
          )}

          {status?.installed && status.running && status.peers.length > 0 && (
            <div className="mt-3 border border-border/60 rounded-md divide-y divide-border/40">
              {status.peers.map((peer) => (
                <PeerRow key={peer.dnsName || peer.hostName} peer={peer} autoTrust={status.autoTrust} />
              ))}
            </div>
          )}

          {status?.installed && status.running && (
            <p className="mt-2 text-ui-sm text-muted-foreground leading-relaxed">
              Devices marked Trusted belong to your Tailscale account and connect without the
              access token — identity is verified per connection via <code>tailscale whois</code>.
              Devices of other tailnet members always need the token.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
