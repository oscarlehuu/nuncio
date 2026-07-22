import { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import {
  appendReproduceLogs,
  fetchSessionReproduceGates,
  markReproduceFixed,
  proceedReproduceGate,
  type ReproduceGateDto,
} from '../lib/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

interface SessionReproduceGateProps {
  sessionId: string;
  /**
   * Bumped whenever a reproduce event lands in the session stream, so the gate
   * refetches the moment the agent requests reproduction (no poll wait).
   */
  refreshKey?: number;
  /** Called after Proceed / Mark Fixed resumes the run (parent may refocus). */
  onResumed?: () => void;
}

/**
 * The debug reproduction gate: a first-class "Reproduction Steps" panel for the
 * open gate an agent raised on THIS session. Numbered, copy-pasteable steps, a
 * live "Logs, N entries" counter fed by a paste box, and exactly two actions —
 * Mark Fixed / Proceed. Renders nothing until a gate is open, so it never adds
 * chrome to a normal session. Mono styling matches the transcript's tool rows.
 */
export function SessionReproduceGate({ sessionId, refreshKey, onResumed }: SessionReproduceGateProps) {
  const [gate, setGate] = useState<ReproduceGateDto | null>(null);
  const [logDraft, setLogDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const gates = await fetchSessionReproduceGates(sessionId);
      // A debug run pauses on one gate at a time; show the most recent open one.
      setGate(gates.length > 0 ? gates[gates.length - 1]! : null);
    } catch {
      // Keep the last-known gate; the next refresh recovers.
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const captureLogs = useCallback(async () => {
    const text = logDraft.trim();
    if (!gate || !text || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const updated = await appendReproduceLogs(gate.id, { text });
      setGate(updated);
      setLogDraft('');
      if (updated.logCount === gate.logCount) {
        toast.warning('Log buffer is full — capture stopped.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to capture logs');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [gate, logDraft]);

  const resolve = useCallback(
    async (action: (id: string) => Promise<ReproduceGateDto>) => {
      if (!gate || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        await action(gate.id);
        setGate(null);
        setLogDraft('');
        onResumed?.();
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed');
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [gate, onResumed, refresh],
  );

  if (!gate) return null;

  return (
    <div
      data-testid="reproduce-gate"
      className="mx-auto flex max-w-[760px] flex-col gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <Bug className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="text-ui-sm font-semibold uppercase tracking-wide text-foreground">
          Reproduction Steps
        </span>
      </div>

      <ol className="flex flex-col gap-1.5">
        {gate.steps.map((step, index) => (
          <li
            key={index}
            data-testid="reproduce-gate-step"
            className="flex gap-2 text-ui-lg leading-snug text-foreground/90"
          >
            <span className="shrink-0 font-mono text-muted-foreground">{index + 1}.</span>
            <span className="min-w-0 whitespace-pre-wrap break-words font-mono">{step}</span>
          </li>
        ))}
      </ol>

      {gate.logsHint && (
        <p className="text-ui text-muted-foreground">{gate.logsHint}</p>
      )}

      <div className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
        <ScrollText className="size-3.5 shrink-0" aria-hidden />
        <span data-testid="reproduce-gate-log-count" className="font-mono">
          Logs, {gate.logCount} {gate.logCount === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <Textarea
        data-testid="reproduce-gate-logs-input"
        placeholder="Paste the logs your reproduction produced…"
        value={logDraft}
        onChange={(e) => setLogDraft(e.target.value)}
        disabled={busy}
        rows={2}
        className="resize-none font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="reproduce-gate-capture"
          size="sm"
          variant="secondary"
          disabled={busy || logDraft.trim().length === 0}
          onClick={() => void captureLogs()}
        >
          Capture logs
        </Button>
        <span className="flex-1" />
        <Button
          data-testid="reproduce-gate-mark-fixed"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void resolve(markReproduceFixed)}
        >
          Mark Fixed
        </Button>
        <Button
          data-testid="reproduce-gate-proceed"
          size="sm"
          disabled={busy}
          onClick={() => void resolve(proceedReproduceGate)}
        >
          Proceed
        </Button>
      </div>
    </div>
  );
}
