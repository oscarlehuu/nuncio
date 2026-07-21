import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { QrCode, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { listDevices, revokeDevice, startPairing, type Device } from '../lib/devices-api';
import { relativeTime } from '../lib/api';

// Keep the QR renderer (qrcode.react) out of the settings entry bundle.
const PairQr = lazy(() => import('./pair-qr'));

/** Poll the device list this often while the QR is visible so a claim shows live. */
const DEVICE_POLL_MS = 3_000;

/** Guided "how to connect" shown beside the QR so first-time pairing is obvious. */
const CONNECT_STEPS = [
  'Open the nuncio app on your phone',
  'Tap Connect a device',
  'Point the camera at this code',
];

/** mm:ss remaining until `expiresAt`, floored at 0. */
function countdownLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * "Connect your phone": idle shows a welcoming hero with a Show-QR button; active
 * reveals the QR, a live mm:ss countdown, a numbered how-to, reachability hints,
 * and a New-code button; expiry dims the QR and offers a regenerate. The countdown
 * is recomputed from `expiresAt - now` each tick so it never drifts.
 * `onVisibleChange` lets the parent poll the device list only while the QR is up.
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
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Smartphone className="size-5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-ui-lg font-medium text-foreground">Connect your phone</span>
            <span className="text-ui text-muted-foreground">
              Start and steer tasks from anywhere — on your home network, or over a secure tunnel on
              the go.
            </span>
          </div>
        </div>
        {!pairing && (
          <Button size="sm" className="h-8 flex-shrink-0" onClick={() => void showQr()} disabled={loading}>
            <QrCode className="size-3.5 mr-1.5" />
            {loading ? 'Generating…' : 'Show QR'}
          </Button>
        )}
      </div>

      {pairing && (
        <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:justify-center sm:gap-7">
          {/* QR + countdown */}
          <div className="flex flex-col items-center gap-3">
            <Suspense
              fallback={<div className="size-[228px] rounded-lg bg-muted/40 animate-pulse" aria-hidden />}
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
          </div>

          {/* Guided steps + reachability hints */}
          {!expired && !stale && (
            <div className="flex w-full flex-col gap-3 sm:max-w-[15rem] sm:pt-1">
              <span className="text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
                How to connect
              </span>
              <ol className="flex flex-col gap-2.5">
                {CONNECT_STEPS.map((step, index) => (
                  <li key={step} className="flex items-start gap-2.5">
                    <span className="flex size-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-ui-xs font-medium tabular-nums text-foreground">
                      {index + 1}
                    </span>
                    <span className="text-ui leading-snug text-muted-foreground">{step}</span>
                  </li>
                ))}
              </ol>

              {pairing.hints.length > 0 && (
                <ul className="mt-1 space-y-1 border-t border-border/60 pt-3 text-ui-sm leading-relaxed text-muted-foreground">
                  {pairing.hints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
            </div>
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
 * Settings section for connecting a phone or tablet to this server: a welcoming
 * QR pairing flow plus management of the devices already paired. The device list
 * polls only while a live QR is on screen so a fresh claim appears without a refresh.
 */
export function MobileSettingsSection() {
  // Drives the paired-devices poll: only poll while a live QR is on screen.
  const [qrVisible, setQrVisible] = useState(false);

  return (
    <section>
      <h2 className="text-ui-lg font-medium text-muted-foreground mb-2">Mobile</h2>
      <div className="border border-border rounded-xl overflow-hidden bg-card divide-y divide-border/60">
        <PairMobileBlock onVisibleChange={setQrVisible} />
        <PairedDevicesBlock qrVisible={qrVisible} />
      </div>
    </section>
  );
}
