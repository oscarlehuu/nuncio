import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { fetchLoopRunDetail, relativeTime, type LoopRunDetailDto } from '../lib/api';
import { VerifyDot } from './loop-status-chip';
import { verifyLabel } from '@nuncio/core/loop-schedule';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const OUTCOME_TONE: Record<string, string> = {
  ok: 'text-success',
  failed: 'text-destructive',
  pending: 'text-info',
};

function outcomeTitle(outcome: string): string {
  if (outcome === 'ok') return 'Succeeded';
  if (outcome === 'failed') return 'Failed';
  if (outcome === 'pending') return 'Running';
  return outcome.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * GitHub-Actions-style run drill-down: outcome + failure reason, the verify output
 * tail in a scrollable monospace block, timings, and a deep-link into the session
 * that executed the run.
 */
export function LoopRunDetailView() {
  const { loopId, runId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<LoopRunDetailDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!loopId || !runId) return;
    try {
      setDetail(await fetchLoopRunDetail(loopId, runId));
    } catch {
      toast.error('Run not found');
      navigate(`/autopilot/${loopId}`, { replace: true });
    } finally {
      setLoading(false);
    }
  }, [loopId, runId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(loopId ? `/autopilot/${loopId}` : '/autopilot')}
          aria-label="Back to loop"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Run detail</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[720px] space-y-5">
          {loading || !detail ? (
            <>
              <div className="h-16 rounded-xl border border-border bg-card animate-pulse" />
              <div className="h-48 rounded-xl border border-border bg-card animate-pulse" />
            </>
          ) : (
            <>
              <div className="surface-lit flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e1">
                <div className="flex items-center gap-2.5">
                  <VerifyDot verify={detail.verify} />
                  <div>
                    <div className={cn('text-ui-lg font-semibold', OUTCOME_TONE[detail.outcome] ?? 'text-foreground')}>
                      {outcomeTitle(detail.outcome)}
                    </div>
                    <div className="text-ui-sm text-muted-foreground">{verifyLabel(detail.verify)}</div>
                  </div>
                </div>
                {detail.sessionId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => navigate(`/session/${detail.sessionId}`)}
                  >
                    Open session
                    <ExternalLink className="size-3.5" />
                  </Button>
                )}
              </div>

              {detail.failureReason && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <div className="text-ui-sm font-medium text-destructive">Failure reason</div>
                  <p className="mt-0.5 text-ui text-foreground">{detail.failureReason}</p>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e0 sm:grid-cols-4">
                <Meta term="Duration" value={formatDuration(detail.durationMs)} />
                <Meta term="Started" value={detail.startedAt ? relativeTime(detail.startedAt) : '—'} />
                <Meta term="Settled" value={detail.settledAt ? relativeTime(detail.settledAt) : '—'} />
                <Meta term="Verify" value={verifyLabel(detail.verify)} />
              </dl>

              <div>
                <div className="mb-1.5 text-ui font-medium text-foreground">Verify output</div>
                {detail.verifyOutputTail ? (
                  <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/30 p-3 text-ui-sm leading-relaxed font-mono text-foreground">
                    {detail.verifyOutputTail}
                  </pre>
                ) : (
                  <p className="rounded-xl border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
                    No verify output for this run.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-ui-sm text-muted-foreground">{term}</dt>
      <dd className="text-ui text-foreground tabular-nums">{value}</dd>
    </div>
  );
}
