import { ArrowUpRight, GitPullRequest, Radar, Repeat, Terminal } from 'lucide-react';
import { relativeTime, type FleetRow as FleetRowDto } from '../lib/api';
import { cn } from '@/lib/utils';

const HEALTH_ACCENT: Record<FleetRowDto['health'], string> = {
  red: 'bg-warning', // needs-you idiom (amber), the established danger-attention tone
  yellow: 'bg-info',
  green: 'bg-success',
};

const HEALTH_DOT: Record<FleetRowDto['health'], string> = {
  red: 'bg-warning shadow-[0_0_6px_var(--color-warning)] animate-pulse',
  yellow: 'bg-info',
  green: 'bg-success',
};

/** The single most useful line for the row: the top item's title, else the reasons, else calm. */
function summaryLine(row: FleetRowDto): string {
  if (row.topItem?.title) return row.topItem.title;
  if (row.reasons.length > 0) return row.reasons.join(' · ');
  return 'All clear';
}

interface FleetRowProps {
  row: FleetRowDto;
  onOpen: () => void;
  /** Red rows may surface the top item's quick action; navigates to the item's subject. */
  onOpenTopItem?: () => void;
}

export function FleetRow({ row, onOpen, onOpenTopItem }: FleetRowProps) {
  const { counts } = row;
  const showTopAction = row.health === 'red' && row.topItem !== null && onOpenTopItem;

  return (
    <li className="surface-lit relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-card pl-4 pr-3 py-3 shadow-e1">
      {/* Health-tinted left accent — the two-second glance. */}
      <span className={cn('absolute inset-y-0 left-0 w-1', HEALTH_ACCENT[row.health])} aria-hidden />

      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${row.name}`}
        className="flex min-w-0 flex-1 flex-col gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[row.health])} aria-hidden />
          <span className="truncate text-ui-lg font-semibold text-foreground">{row.name}</span>
          {row.weight > 1 && (
            <span
              className="shrink-0 rounded-full bg-muted/60 px-1.5 text-ui-xs font-medium text-muted-foreground tabular-nums"
              title={`Importance weight ${row.weight}`}
            >
              ×{row.weight}
            </span>
          )}
        </div>

        <p
          className={cn(
            'truncate text-ui',
            row.health === 'red' ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {summaryLine(row)}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-sm text-muted-foreground">
          {counts.runningSessions > 0 && (
            <Stat icon={Terminal} value={counts.runningSessions} label="running" />
          )}
          {counts.activeLoops > 0 && <Stat icon={Repeat} value={counts.activeLoops} label="loops" />}
          {counts.openPRs > 0 && <Stat icon={GitPullRequest} value={counts.openPRs} label="PRs" />}
          {counts.openAttention > 0 && (
            <Stat icon={Radar} value={counts.openAttention} label="open" />
          )}
          {row.lastActivityAt && (
            <span className="tabular-nums">{relativeTime(row.lastActivityAt)}</span>
          )}
        </div>
      </button>

      {showTopAction && (
        <button
          type="button"
          onClick={onOpenTopItem}
          aria-label={`Open ${row.topItem!.title}`}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-sm font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
        >
          Open
          <ArrowUpRight className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function Stat({ icon: Icon, value, label }: { icon: typeof Terminal; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <Icon className="size-3 shrink-0" />
      {value}
      <span className="text-muted-foreground/80">{label}</span>
    </span>
  );
}
