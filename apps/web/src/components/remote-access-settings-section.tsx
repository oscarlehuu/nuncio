import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Eye, EyeOff, QrCode, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchAuthToken, type AuthTokenInfo } from '../lib/auth-api';
import {
  fetchTailscaleStatus,
  pushProvision,
  TAILSCALE_AUTO_TRUST_KEY,
  type TailscalePeer,
  type TailscaleStatus,
} from '../lib/tailscale-api';
import { updateSetting } from '../lib/settings-api';
import { listDevices, revokeDevice, startPairing, type Device } from '../lib/devices-api';
import { relativeTime } from '../lib/api';

// Keep the QR renderer (qrcode.react) out of the settings entry bundle.
const PairQr = lazy(() => import('./pair-qr'));

/** Poll the device list this often while the QR is visible so a claim shows live. */
const DEVICE_POLL_MS = 3_000;

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

/** mm:ss remaining until `expiresAt`, floored at 0. */
function countdownLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * "Pair mobile device": idle shows a Show-QR button; active shows the QR, a
 * live mm:ss countdown, hints, and a New-code button; expiry dims the QR and
 * offers a regenerate. The countdown is recomputed from `expiresAt - now` each
 * tick so it never drifts. `onVisibleChange` lets the parent poll the device
 * list only while the QR is on screen.
 */
function PairMobileBlock({ onVisibleChange }: { onVisibleChange: (visible: boolean) => void }) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; urls: string[]; hints: string[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Latest-wins guard: each mint invalidates the prior code server-side, so only the
  // newest request may commit — a slow older response resolving last must be ignored,
  // or the UI would show a dead code.
  const mintSeq = useRef(0);

  const expired = pairing !== null && now >= pairing.expiresAt;

  const showQr = useCallback(async () => {
    if (loading) return; // Single-flight: ignore double-clicks while a mint is in flight.
    const seq = ++mintSeq.current;
    setLoading(true);
    try {
      const started = await startPairing();
      if (seq !== mintSeq.current) return; // A newer mint superseded this one.
      setPairing(started);
      setNow(Date.now());
    } catch (err) {
      if (seq !== mintSeq.current) return;
      const message = err instanceof Error ? err.message : 'Could not start pairing';
      toast.error(message);
      // A partial result may still carry LAN URLs worth showing; startPairing throws on
      // non-2xx so there is nothing to render here, but the toast keeps the user informed.
    } finally {
      if (seq === mintSeq.current) setLoading(false);
    }
  }, [loading]);

  // Tick once a second only while a live (unexpired) code is on screen.
  useEffect(() => {
    if (!pairing || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing, expired]);

  // The QR "visible" signal drives the parent's device-list poll.
  useEffect(() => {
    onVisibleChange(pairing !== null && !expired);
  }, [pairing, expired, onVisibleChange]);

  const payload = pairing ? JSON.stringify({ v: 1, code: pairing.code, urls: pairing.urls }) : '';
  // A mint in flight over an existing code means that code is being invalidated: mark
  // it stale so it reads as non-scannable and copy is blocked until the new one lands.
  const stale = loading && pairing !== null;

  return (
    <div className="py-3 px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col min-w-0">
          <span className="text-ui-lg font-medium text-foreground">Pair mobile device</span>
          <span className="text-ui text-muted-foreground">
            Scan the code once in the nuncio phone app to stay connected at home and on the go.
          </span>
        </div>
        {!pairing && (
          <Button size="sm" className="h-8 flex-shrink-0" onClick={() => void showQr()} disabled={loading}>
            <QrCode className="size-3.5 mr-1.5" />
            {loading ? 'Generating…' : 'Show QR'}
          </Button>
        )}
      </div>

      {pairing && (
        <div className="mt-4 flex flex-col items-center gap-3">
          <Suspense
            fallback={
              <div className="size-[228px] rounded-lg bg-muted/40 animate-pulse" aria-hidden />
            }
          >
            <PairQr payload={payload} dimmed={expired || stale} copyDisabled={stale} />
          </Suspense>

          {stale ? (
            <span className="text-ui text-muted-foreground">Refreshing code…</span>
          ) : expired ? (
            <div className="flex flex-col items-center gap-2">
              <span className="text-ui text-muted-foreground">Code expired</span>
              <Button size="sm" variant="outline" className="h-8" onClick={() => void showQr()} disabled={loading}>
                Generate new code
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-ui text-muted-foreground tabular-nums">
                Expires in {countdownLabel(pairing.expiresAt, now)}
              </span>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => void showQr()} disabled={loading}>
                New code
              </Button>
            </div>
          )}

          {pairing.hints.length > 0 && !expired && !stale && (
            <ul className="w-full max-w-sm space-y-1 text-ui-sm text-muted-foreground text-center leading-relaxed">
              {pairing.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DeviceRow({ device, onRevoke }: { device: Device; onRevoke: (device: Device) => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-4">
      <div className="flex items-center gap-3 min-w-0">
        <Smartphone className="size-4 flex-shrink-0 text-muted-foreground" />
        <div className="flex flex-col min-w-0">
          <span className="text-ui-lg font-medium text-foreground truncate">{device.name}</span>
          <span className="text-ui-sm text-muted-foreground truncate">
            {device.platform ?? 'Unknown platform'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-ui-sm text-muted-foreground">
          {device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'Never seen'}
        </span>
        {device.revoked ? (
          <Badge variant="outline" className="text-ui-xs">
            Revoked
          </Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-ui"
            onClick={() => onRevoke(device)}
          >
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * "Paired devices": lists devices on mount, refreshes after a revoke, and — while
 * the QR is visible — polls so a fresh claim appears live. Revoke goes through a
 * Dialog confirm because it is a hard lockout, then a success toast.
 */
function PairedDevicesBlock({ qrVisible }: { qrVisible: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState(false);
  // Only the newest list response may commit. mount, the 3s poll, and the post-revoke
  // refresh all share load(); without this an older in-flight response (e.g. a poll
  // started before a revoke) could resolve last and resurrect a revoked device.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await listDevices();
      if (seq !== loadSeq.current) return; // A newer load superseded this response.
      setDevices(next);
      setLoadFailed(false);
    } catch {
      if (seq !== loadSeq.current) return;
      // Surface the failure instead of rendering an empty state — an unreached list
      // must never read as "no devices", which would hide live revoke controls.
      setLoadFailed(true);
    } finally {
      if (seq === loadSeq.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the QR is on screen so a successful claim surfaces without a refresh.
  useEffect(() => {
    if (!qrVisible) return;
    const timer = setInterval(() => void load(), DEVICE_POLL_MS);
    return () => clearInterval(timer);
  }, [qrVisible, load]);

  const confirmRevoke = async () => {
    if (!pending) return;
    setRevoking(true);
    try {
      await revokeDevice(pending.id);
      toast.success('Device revoked');
      setPending(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke device');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="py-3 px-4">
      <div className="flex flex-col min-w-0">
        <span className="text-ui-lg font-medium text-foreground">Paired devices</span>
        <span className="text-ui text-muted-foreground">
          Phones and tablets connected to this server. Revoke one to lock it out immediately.
        </span>
      </div>

      {devices.length > 0 && (
        <div className="mt-3 border border-border/60 rounded-md divide-y divide-border/40">
          {devices.map((device) => (
            <DeviceRow key={device.id} device={device} onRevoke={setPending} />
          ))}
        </div>
      )}

      {loadFailed ? (
        // Never collapse a failed load into the empty state — that would hide real
        // devices and their revoke controls.
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <span className="text-ui text-destructive">
            {devices.length > 0 ? "Couldn't refresh the device list." : "Couldn't load paired devices."}
          </span>
          <Button variant="outline" size="sm" className="h-7 px-2 text-ui" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        loaded &&
        devices.length === 0 && (
          <p className="mt-3 text-ui text-muted-foreground">No devices paired yet.</p>
        )
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke device</DialogTitle>
            <DialogDescription>
              {pending
                ? `Revoke “${pending.name}”? It will be signed out immediately and must scan a new code to reconnect.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRevoke()} disabled={revoking}>
              {revoking ? 'Revoking…' : 'Revoke device'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  // Drives the paired-devices poll: only poll while a live QR is on screen.
  const [qrVisible, setQrVisible] = useState(false);

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

        {/* Pair mobile device */}
        <PairMobileBlock onVisibleChange={setQrVisible} />

        {/* Paired devices */}
        <PairedDevicesBlock qrVisible={qrVisible} />
      </div>
    </section>
  );
}
