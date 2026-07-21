import { useEffect, useState } from 'react';
import { ServerOff } from 'lucide-react';
import { toast } from 'sonner';
import { fetchSession, steerSession, SteerApiError, type Session } from '../lib/api';
import { machineApiBase, machineHref } from '../lib/hub-api';
import { SessionTile } from './session-tile';
import { cn } from '@/lib/utils';

/** Session metadata refresh cadence — mirrors App's own session-list polling. */
const REMOTE_POLL_MS = 5000;

interface RemoteSessionTileProps {
  machineId: string;
  sessionId: string;
  focused: boolean;
  onFocus: () => void;
  /** Called when the session no longer exists on its machine (slot degrades). */
  onGone: () => void;
}

/**
 * A grid tile bound to a session on ANOTHER hub machine. It owns its own data
 * path against that machine's origin-absolute base: metadata polling, the tile
 * stream (via SessionTile), and steer. An unreachable machine renders as a
 * reconnect state and keeps polling — founder-locked: never silently degrade
 * to an empty slot while the machine might come back. Maximize navigates to
 * the session on the machine's own base path (full-fidelity SessionDetail,
 * panels included), matching the machine switcher's plain-anchor philosophy.
 */
export function RemoteSessionTile({
  machineId,
  sessionId,
  focused,
  onFocus,
  onGone,
}: RemoteSessionTileProps) {
  const base = machineApiBase(machineId);
  const [session, setSession] = useState<Session | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [steering, setSteering] = useState(false);

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const next = await fetchSession(sessionId, base);
        if (cancelled) return;
        setSession(next);
        setUnreachable(false);
      } catch (error) {
        if (cancelled) return;
        // A 404 means the session is gone for good; anything else (network,
        // hub 502 while the machine is down) is a reconnectable outage.
        if (error instanceof Error && /404|not found/i.test(error.message)) {
          onGone();
          return;
        }
        setUnreachable(true);
      }
      timer = setTimeout(() => void poll(), REMOTE_POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // onGone is stable enough per slot; re-binding restarts the poll anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, base]);

  // Invalid machine segment persisted — nothing sane to render or retry.
  useEffect(() => {
    if (!base) onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  if (!base) return null;

  if (!session || unreachable) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onFocus}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onFocus();
          }
        }}
        aria-label={`Session on ${machineId}${unreachable ? ' (unreachable)' : ' (connecting)'}`}
        className={cn(
          'flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-xl border bg-card/60 p-4 text-center',
          unreachable ? 'border-destructive/40' : 'border-border',
          focused && 'ring-2 ring-ring',
        )}
      >
        <ServerOff
          className={cn('size-5', unreachable ? 'text-destructive/70' : 'text-muted-foreground animate-pulse')}
        />
        <div>
          <p className="text-ui-lg font-medium">{machineId}</p>
          <p className="text-[11.5px] text-muted-foreground">
            {unreachable ? 'Machine unreachable — retrying…' : 'Connecting…'}
          </p>
        </div>
      </div>
    );
  }

  const steer = async (message: string) => {
    setSteering(true);
    try {
      const next = await steerSession(session.id, message, undefined, base);
      setSession(next);
    } catch (error) {
      toast.error(error instanceof SteerApiError ? error.message : 'Failed to steer session');
    } finally {
      setSteering(false);
    }
  };

  return (
    <SessionTile
      session={session}
      focused={focused}
      onFocus={onFocus}
      onMaximize={() => {
        // Full-fidelity view lives on the machine's own base path.
        window.location.assign(`${machineHref(machineId)}session/${sessionId}`);
      }}
      onSteer={steer}
      steering={steering}
      apiBase={base}
    />
  );
}
