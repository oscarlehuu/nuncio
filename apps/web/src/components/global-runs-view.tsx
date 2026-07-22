import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { fetchLoopRuns, fetchLoops, relativeTime, type LoopDto, type LoopRunDto } from '../lib/api';
import { localDayBucket, loopDisplayName } from '@nuncio/core/loop-schedule';
import { VerifyDot } from './loop-status-chip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FlatRun extends LoopRunDto {
  loopGoal: string;
}

const OUTCOME_LABEL: Record<string, { text: string; tone: string }> = {
  ok: { text: 'Succeeded', tone: 'text-success' },
  failed: { text: 'Failed', tone: 'text-destructive' },
  pending: { text: 'Running', tone: 'text-info' },
  'budget-exhausted': { text: 'Skipped', tone: 'text-muted-foreground' },
  'skipped-overlap': { text: 'Skipped', tone: 'text-muted-foreground' },
  resume: { text: 'Resumed', tone: 'text-muted-foreground' },
};

function outcomeMeta(outcome: string): { text: string; tone: string } {
  return (
    OUTCOME_LABEL[outcome] ?? {
      text: outcome.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      tone: 'text-muted-foreground',
    }
  );
}

/**
 * Every run across every loop, newest-first — the fleet's activity log. Aggregated
 * client-side from each loop's run history (personal scale), so counters and rows
 * stay consistent with the per-loop history. Rows deep-link into the run detail.
 */
export function GlobalRunsView() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<FlatRun[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const loops = await fetchLoops();
      const perLoop = await Promise.all(
        loops.map(async (loop: LoopDto) => {
          try {
            const rs = await fetchLoopRuns(loop.id);
            return rs.map((r) => ({ ...r, loopGoal: loopDisplayName(loop) }));
          } catch {
            return [];
          }
        }),
      );
      setRuns(perLoop.flat().sort((a, b) => b.createdAt - a.createdAt));
    } catch {
      toast.error('Failed to load run history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { count24h, count7d } = useMemo(() => {
    const today = localDayBucket();
    const weekAgo = Date.now() - 7 * 86_400_000;
    const executed = runs.filter((r) => r.outcome === 'ok' || r.outcome === 'failed');
    return {
      count24h: executed.filter((r) => r.dayBucket === today).length,
      count7d: executed.filter((r) => r.createdAt >= weekAgo).length,
    };
  }, [runs]);

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={() => navigate('/autopilot')} aria-label="Back to Autopilot">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Run history</h1>
        {!loading && (
          <span className="ml-auto text-ui-sm text-muted-foreground tabular-nums">
            {count24h} in 24h · {count7d} in 7d
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[840px]">
          {loading ? (
            <div className="space-y-2" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 rounded-lg border border-border bg-card animate-pulse" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center text-ui text-muted-foreground">
              No runs yet. Loops record a row here each time they fire.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-ui">
                <thead>
                  <tr className="border-b border-border text-left text-ui-sm text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Loop</th>
                    <th className="px-4 py-2 font-medium">Triggered</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {runs.map((run) => {
                    const meta = outcomeMeta(run.outcome);
                    const clickable = run.outcome === 'ok' || run.outcome === 'failed' || run.outcome === 'pending';
                    return (
                      <tr
                        key={run.id}
                        className={cn(clickable && 'cursor-pointer hover:bg-muted/40 transition-colors')}
                        onClick={clickable ? () => navigate(`/autopilot/${run.loopId}/runs/${run.id}`) : undefined}
                      >
                        <td className="max-w-0 truncate px-4 py-2.5 text-foreground">{run.loopGoal}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground tabular-nums">
                          {relativeTime(run.createdAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            {clickable && <VerifyDot verify={run.verify} />}
                            <span className={meta.tone}>{meta.text}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
