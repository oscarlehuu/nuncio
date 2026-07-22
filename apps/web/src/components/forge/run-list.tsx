import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import { fetchForgeRuns, type ForgeWorkflowRun } from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { forgeTimeAgo } from './forge-ui';
import { cn } from '@/lib/utils';

interface RunListProps {
  path: string;
  /** Session branch — offered as a filter chip next to "all". */
  branch?: string | null;
  onOpen: (run: ForgeWorkflowRun) => void;
}

const POLL_INTERVAL_MS = 30_000;

export function runStatusIcon(run: Pick<ForgeWorkflowRun, 'status' | 'conclusion'>) {
  if (run.status === 'running') return <Loader2 className="size-3.5 animate-spin text-warning" />;
  if (run.status === 'queued') return <CircleDashed className="size-3.5 text-muted-foreground" />;
  if (run.conclusion === 'success') return <CheckCircle2 className="size-3.5 text-success" />;
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
    return <XCircle className="size-3.5 text-muted-foreground" />;
  }
  return <XCircle className="size-3.5 text-destructive" />;
}

export function formatRunDuration(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function RunList({ path, branch, onOpen }: RunListProps) {
  const [scope, setScope] = useState<'all' | 'branch'>('all');
  const scopedBranch = scope === 'branch' ? (branch ?? undefined) : undefined;
  const { data: runs } = useForgeQuery(
    `runs:${path}:${scopedBranch ?? 'all'}`,
    () => fetchForgeRuns(path, scopedBranch),
    { pollMs: POLL_INTERVAL_MS, onError: (err) => toast.error(err.message) },
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() => setScope('all')}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-ui-sm font-medium',
            scope === 'all'
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          all
        </button>
        {branch && (
          <button
            type="button"
            onClick={() => setScope('branch')}
            title={branch}
            className={cn(
              'max-w-40 truncate rounded-full border px-2.5 py-0.5 font-mono text-ui-sm font-medium',
              scope === 'branch'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {branch}
          </button>
        )}
      </div>

      {runs === null ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Loading workflow runs…</div>
      ) : runs.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No workflow runs found.</div>
      ) : (
        <ul className="flex flex-col">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onOpen(run)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/40"
              >
                <span className="flex items-center gap-2">
                  {runStatusIcon(run)}
                  <span className="min-w-0 flex-1 truncate text-ui-lg font-medium">
                    {run.name}
                    {run.runNumber != null && (
                      <span className="ml-1 text-muted-foreground">#{run.runNumber}</span>
                    )}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-5.5 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate font-mono">{run.branch}</span>
                  {run.event && <span>{run.event}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <span>{formatRunDuration(run.durationSeconds)}</span>
                    <span>{forgeTimeAgo(run.createdAt)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
