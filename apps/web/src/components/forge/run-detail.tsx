import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import {
  cancelForgeRun,
  fetchForgeCapabilities,
  fetchForgeJobLog,
  fetchForgeRunJobs,
  rerunForgeRun,
  type ForgeWorkflowRun,
} from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { Button } from '../ui/button';
import { formatRunDuration, runStatusIcon } from './run-list';
import { cn } from '@/lib/utils';

interface RunDetailProps {
  path: string;
  run: ForgeWorkflowRun;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 15_000;

export function RunDetail({ path, run, onBack }: RunDetailProps) {
  const [openJobs, setOpenJobs] = useState<Set<number>>(() => new Set());
  const [logs, setLogs] = useState<Record<number, { log: string; truncated: boolean }>>({});
  const [loadingLog, setLoadingLog] = useState<number | null>(null);
  const [acting, setActing] = useState(false);

  const { data: jobs, refresh } = useForgeQuery(
    `runjobs:${path}:${run.id}`,
    () => fetchForgeRunJobs(path, run.id),
    { pollMs: POLL_INTERVAL_MS, onError: (err) => toast.error(err.message) },
  );
  const { data: capabilities } = useForgeQuery(
    `caps:${path}`,
    () => fetchForgeCapabilities(path),
    { staleMs: 5 * 60_000 },
  );

  const act = async (action: () => Promise<unknown>, success: string) => {
    if (acting) return;
    try {
      setActing(true);
      await action();
      toast.success(success);
      void refresh().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActing(false);
    }
  };

  const toggleJob = (jobId: number) => {
    setOpenJobs((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const showLog = async (jobId: number) => {
    if (logs[jobId] || loadingLog === jobId) return;
    try {
      setLoadingLog(jobId);
      const log = await fetchForgeJobLog(path, jobId);
      setLogs((current) => ({ ...current, [jobId]: log }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load log');
    } finally {
      setLoadingLog(null);
    }
  };

  const running = run.status === 'running' || run.status === 'queued';
  const failed = run.conclusion === 'failure';

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back" className="shrink-0">
          <ArrowLeft className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {runStatusIcon(run)}
            <a
              href={run.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <span className="truncate">
                {run.name}
                {run.runNumber != null ? ` #${run.runNumber}` : ''}
              </span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{run.branch}</span>
            {run.actor && <span>by {run.actor}</span>}
            {run.durationSeconds != null && <span>{formatRunDuration(run.durationSeconds)}</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {running ? (
          <Button size="sm" variant="outline" disabled={acting} onClick={() => act(() => cancelForgeRun(path, run.id), 'Cancel requested')}>
            {acting && <Loader2 className="size-3.5 animate-spin" />}
            Cancel run
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={acting}
              onClick={() => act(() => rerunForgeRun(path, run.id), 'Re-run requested')}
            >
              <RotateCcw className="size-3.5" />
              Re-run
            </Button>
            {failed && capabilities?.rerunFailedOnly && (
              <Button
                size="sm"
                variant="outline"
                disabled={acting}
                onClick={() => act(() => rerunForgeRun(path, run.id, true), 'Re-run of failed jobs requested')}
              >
                Re-run failed jobs
              </Button>
            )}
          </>
        )}
      </div>

      {jobs === null ? (
        <div className="text-xs text-muted-foreground">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="text-xs text-muted-foreground">No jobs reported for this run.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {jobs.map((job) => {
            const open = openJobs.has(job.id);
            const log = logs[job.id];
            return (
              <li key={job.id} className="rounded-md border border-border/50">
                <button
                  type="button"
                  onClick={() => toggleJob(job.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40"
                >
                  {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                  {runStatusIcon(job)}
                  <span className="min-w-0 flex-1 truncate text-ui-lg">{job.name}</span>
                  <span className="shrink-0 text-ui-xs uppercase text-muted-foreground">
                    {job.conclusion ?? job.status}
                  </span>
                </button>
                {open && (
                  <div className="flex flex-col gap-1.5 border-t border-border/40 p-2.5">
                    {job.steps.length > 0 && (
                      <ul className="flex flex-col gap-0.5">
                        {job.steps.map((step, index) => (
                          <li key={index} className="flex items-center gap-2 text-xs">
                            {runStatusIcon(step)}
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate',
                                step.conclusion === 'failure' ? 'text-destructive' : 'text-foreground/80',
                              )}
                            >
                              {step.name}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {log ? (
                      <div className="flex flex-col gap-1">
                        {log.truncated && (
                          <span className="text-ui-xs uppercase text-muted-foreground">
                            log tail (truncated)
                          </span>
                        )}
                        <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-ui-sm leading-4 whitespace-pre-wrap break-all">
                          {log.log || 'Log is empty.'}
                        </pre>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="self-start"
                        disabled={loadingLog === job.id}
                        onClick={() => void showLog(job.id)}
                      >
                        {loadingLog === job.id && <Loader2 className="size-3.5 animate-spin" />}
                        View log
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
