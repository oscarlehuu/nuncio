import { relativeTime, type LoopRunDto } from '../lib/api';
import { VerifyDot } from './loop-status-chip';
import { cn } from '@/lib/utils';

/**
 * A loop's recent runs, newest-first: outcome label + verify tri-state dot +
 * relative timestamp. `resume` and `budget-exhausted` rows are bookkeeping the
 * founder should still see (they explain a gap or a manual fix), rendered muted.
 */

const OUTCOME_META: Record<string, { label: string; className: string }> = {
  pending: { label: 'Running…', className: 'text-foreground' },
  ok: { label: 'Succeeded', className: 'text-foreground' },
  failed: { label: 'Failed', className: 'text-destructive' },
  'budget-exhausted': { label: 'Skipped — daily budget spent', className: 'text-muted-foreground' },
  resume: { label: 'Resumed by you', className: 'text-muted-foreground italic' },
};

/**
 * Tolerant lookup: a run outcome the client hasn't seen yet (a future server-side
 * bookkeeping marker like 'skipped-overlap') renders as a transparent muted row —
 * humanized from its raw string — rather than crashing on an undefined meta.
 */
function outcomeMeta(outcome: string): { label: string; className: string } {
  return (
    OUTCOME_META[outcome] ?? {
      label: outcome.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      className: 'text-muted-foreground',
    }
  );
}

interface LoopRunHistoryProps {
  runs: LoopRunDto[];
  loading?: boolean;
}

export function LoopRunHistory({ runs, loading }: LoopRunHistoryProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1.5 py-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-6 rounded bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="py-2 text-ui text-muted-foreground">
        No runs yet — the first will fire at the next scheduled time.
      </p>
    );
  }

  const ordered = [...runs].reverse();

  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {ordered.map((run) => {
        const meta = outcomeMeta(run.outcome);
        const settled = run.outcome === 'ok' || run.outcome === 'failed';
        return (
          <li key={run.id} className="flex items-center gap-2.5 py-1.5">
            {settled ? (
              <VerifyDot verify={run.verify} />
            ) : run.outcome === 'pending' ? (
              <span
                className="inline-block size-[7px] shrink-0 rounded-full bg-info shadow-[0_0_5px_var(--color-info)] animate-pulse"
                title="In flight"
                aria-label="In flight"
              />
            ) : (
              <span className="inline-block size-[7px] shrink-0" aria-hidden />
            )}
            <span className={cn('text-ui-lg', meta.className)}>{meta.label}</span>
            <span className="ml-auto shrink-0 text-ui-sm tabular-nums text-muted-foreground">
              {relativeTime(run.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
