import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { actChip, dismissChip, fetchSessionChips, type ChipDto } from '../lib/api';

interface SessionChipRowProps {
  sessionId: string;
  /**
   * Bumped whenever a spawn-task event lands in the session stream, so the row
   * refetches the moment the agent proposes or withdraws a chip (no poll wait).
   */
  refreshKey?: number;
  /** Navigate to the child session the chip spun up. */
  onCreated: (childSessionId: string) => void;
}

/**
 * The spawn-task chip row: hairline mono pills for the follow-ups an agent
 * flagged mid-turn on THIS session. Tapping a chip's title spins it into its
 * own lineage-linked session; the × withdraws it. Renders nothing until a
 * proposed chip exists, so it never adds chrome to a clean session.
 */
export function SessionChipRow({ sessionId, refreshKey, onCreated }: SessionChipRowProps) {
  const [chips, setChips] = useState<ChipDto[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      setChips(await fetchSessionChips(sessionId));
    } catch {
      // Keep the last-known chips; the next refresh recovers.
    }
  }, [sessionId]);

  // Refetch on mount, on a spawn-task event, and on a slow safety poll.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (id: string, action: (id: string) => Promise<unknown>, after?: (result: unknown) => void) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setBusyId(id);
      try {
        const result = await action(id);
        after?.(result);
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed');
      } finally {
        inFlight.current.delete(id);
        setBusyId(null);
      }
    },
    [refresh],
  );

  if (chips.length === 0) return null;

  return (
    <div
      data-testid="session-chip-row"
      className="mx-auto flex max-w-[760px] flex-wrap gap-2 px-1 pb-2"
    >
      {chips.map((chip) => (
        <div
          key={chip.id}
          data-testid="session-chip"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-2.5 pr-1 shadow-e0"
        >
          <Sparkles className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <button
            type="button"
            data-testid="session-chip-create"
            title={chip.tldr}
            disabled={busyId === chip.id}
            onClick={() =>
              void run(chip.id, actChip, (result) => {
                const childId = (result as { session?: { id?: unknown } }).session?.id;
                if (typeof childId === 'string') onCreated(childId);
              })
            }
            aria-label={`Create a session for "${chip.title}"`}
            className="max-w-[240px] truncate text-ui-sm font-medium text-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm disabled:opacity-50"
          >
            {chip.title}
          </button>
          <button
            type="button"
            data-testid="session-chip-dismiss"
            disabled={busyId === chip.id}
            onClick={() => void run(chip.id, (id) => dismissChip(id))}
            aria-label={`Dismiss "${chip.title}"`}
            className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
