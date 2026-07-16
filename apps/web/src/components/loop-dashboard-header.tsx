import { ArrowRight } from 'lucide-react';
import type { LoopStatsDto } from '../lib/api';
import { cn } from '@/lib/utils';

/**
 * Autopilot fleet dashboard: three at-a-glance counters and a 14-day success/fail
 * sparkline that doubles as the entry to the full run history. Quiet by default
 * (muted stat cards over the surface ladder); the sparkline reads runs stacked per
 * day — success below, failures above in warning. Renders even with zero loops so
 * the fleet frame is always present (Cursor-parity).
 */
interface LoopDashboardHeaderProps {
  stats: LoopStatsDto | null;
  loading?: boolean;
  /** Navigate to the full run history — the sparkline tile becomes this button. */
  onOpenRunHistory?: () => void;
}

export function LoopDashboardHeader({ stats, loading, onOpenRunHistory }: LoopDashboardHeaderProps) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-3 gap-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[72px] rounded-xl border border-border bg-card shadow-e0 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Loops" value={stats.total} hint={`${stats.active} active`} />
      <StatCard label="Successful · 7d" value={stats.successful7d} tone="success" />
      <StatCard label="Failed · 7d" value={stats.failed7d} tone={stats.failed7d > 0 ? 'warning' : undefined} />
      <button
        type="button"
        onClick={onOpenRunHistory}
        aria-label="View all run history"
        className="surface-lit group col-span-2 flex flex-col justify-between rounded-xl border border-border bg-card px-4 py-3 text-left shadow-e1 transition-shadow hover:shadow-e2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:col-span-1"
      >
        <span className="flex items-center justify-between text-ui-sm text-muted-foreground">
          <span>Last 14 days</span>
          <span className="inline-flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
            Run history
            <ArrowRight className="size-3" />
          </span>
        </span>
        <Sparkline days={stats.sparkline} />
      </button>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'success' | 'warning';
}) {
  return (
    <div className="surface-lit flex flex-col gap-0.5 rounded-xl border border-border bg-card px-4 py-3 shadow-e1">
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums leading-none',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </span>
      {hint && <span className="text-ui-sm text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Sparkline({ days }: { days: LoopStatsDto['sparkline'] }) {
  const max = Math.max(1, ...days.map((d) => d.ok + d.failed));
  return (
    <div className="mt-2 flex h-8 items-end gap-[3px]" role="img" aria-label="Runs per day over the last 14 days">
      {days.length === 0 ? (
        <span className="text-ui-sm text-muted-foreground">No runs yet</span>
      ) : (
        days.map((d) => {
          const okH = (d.ok / max) * 100;
          const failH = (d.failed / max) * 100;
          return (
            <div
              key={d.day}
              className="flex min-w-[4px] flex-1 flex-col justify-end"
              title={`${d.day}: ${d.ok} ok, ${d.failed} failed`}
            >
              {failH > 0 && <span className="rounded-t-sm bg-warning" style={{ height: `${failH}%` }} />}
              <span
                className={cn('bg-success', failH === 0 && 'rounded-t-sm')}
                style={{ height: `${Math.max(okH, d.ok > 0 ? 8 : 0)}%` }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
