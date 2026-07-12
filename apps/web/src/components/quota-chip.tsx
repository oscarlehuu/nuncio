import { memo, useCallback, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { UsageLimitDto, UsageProviderId, UsageSnapshotDto } from '@/lib/usage-api';
import {
  formatPercentLabel,
  formatResetCountdown,
  formatUpdatedAgo,
  freshestUpdatedAt,
  isNotStartedLimit,
  paceForLimit,
  pinActiveProvider,
  primaryUsageLimit,
  ringFillPercent,
  usageNeedsAuthHint,
} from '@/lib/usage-display';
import {
  loadUsagePercentMode,
  saveUsagePercentMode,
  type UsagePercentMode,
} from '@/lib/usage-percent-preference';
import { cn } from '@/lib/utils';
import { ProviderIcon } from './provider-icon';

function CircularProgress({ percentage, size = 20 }: { percentage: number; size?: number }) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const color =
    percentage > 90
      ? 'var(--color-error)'
      : percentage > 70
        ? 'var(--color-warning)'
        : 'var(--color-neutral)';

  return (
    <svg width={size} height={size} className="shrink-0" viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-muted-foreground/30"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function PercentModeToggle({
  mode,
  onChange,
}: {
  mode: UsagePercentMode;
  onChange: (mode: UsagePercentMode) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border border-border p-0.5 text-ui-sm"
      role="group"
      aria-label="Show used or remaining"
      data-testid="quota-percent-mode"
    >
      {(['used', 'left'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={cn(
            'rounded px-2 py-0.5 capitalize transition-colors',
            mode === option
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={mode === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function LimitRow({ limit, mode }: { limit: UsageLimitDto; mode: UsagePercentMode }) {
  const notStarted = isNotStartedLimit(limit);
  const used = limit.usedPercent ?? 0;
  const fill = ringFillPercent(used);
  const reset =
    limit.resetsAt && limit.resetsAt.length > 0 ? formatResetCountdown(limit.resetsAt) : null;
  const pace = !notStarted ? paceForLimit(limit) : null;
  const label =
    typeof limit.usedPercent === 'number'
      ? formatPercentLabel(limit.usedPercent, mode, { notStarted })
      : '—';

  return (
    <div className="space-y-1" data-testid="quota-limit-row">
      <div className="flex items-center justify-between text-ui gap-2">
        <span className="text-foreground/80">{limit.window}</span>
        <span className="text-muted-foreground tabular-nums shrink-0">
          {label}
          {reset && !notStarted ? ` · ${reset}` : ''}
        </span>
      </div>
      {typeof limit.usedPercent === 'number' && !notStarted ? (
        <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              fill > 90 ? 'bg-destructive' : fill > 70 ? 'bg-warning' : 'bg-primary/70',
            )}
            style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
          />
        </div>
      ) : null}
      {pace?.amountText || pace?.etaText ? (
        <p
          className={cn(
            'text-ui-sm',
            pace.status === 'behind' ? 'text-destructive' : 'text-muted-foreground',
          )}
          data-testid="quota-pace"
        >
          {[pace.amountText, pace.etaText].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

function SnapshotCard({
  snapshot,
  emphasized,
  mode,
}: {
  snapshot: UsageSnapshotDto;
  emphasized?: boolean;
  mode: UsagePercentMode;
}) {
  const title =
    snapshot.provider === 'claude'
      ? 'Claude'
      : snapshot.provider === 'codex'
        ? 'Codex'
        : 'Cursor';

  return (
    <div
      className={cn('space-y-2', emphasized && 'pb-2 border-b border-border/60')}
      data-testid={`quota-card-${snapshot.provider}`}
    >
      <div className="flex items-center gap-2">
        <ProviderIcon providerId={snapshot.provider} className="size-4" />
        <span className="text-ui-lg font-medium text-foreground">{title}</span>
        {snapshot.planName ? (
          <span className="text-ui-sm text-muted-foreground truncate">{snapshot.planName}</span>
        ) : null}
      </div>
      {snapshot.status === 'ok' ? (
        <>
          <div className="space-y-2">
            {snapshot.limits.map((limit) => (
              <LimitRow key={limit.window} limit={limit} mode={mode} />
            ))}
          </div>
          {snapshot.usageLines.length > 0 ? (
            <div className="space-y-1 pt-1">
              {snapshot.usageLines.map((line) => (
                <div key={line.label} className="space-y-0.5">
                  <div className="flex justify-between gap-2 text-ui">
                    <span className="text-muted-foreground">{line.label}</span>
                    <span className="text-foreground/80 tabular-nums text-right">{line.value}</span>
                  </div>
                  {line.subtitle ? (
                    <p className="text-ui-sm text-muted-foreground/80">{line.subtitle}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-ui text-muted-foreground">
          {snapshot.detail ?? usageNeedsAuthHint(snapshot.provider)}
        </p>
      )}
    </div>
  );
}

interface QuotaChipProps {
  activeProvider?: string | null;
  snapshots: UsageSnapshotDto[];
  /** Called when the popover opens (e.g. force-refresh). */
  onOpen?: () => void;
}

export const QuotaChip = memo(function QuotaChip({
  activeProvider,
  snapshots,
  onOpen,
}: QuotaChipProps) {
  const [mode, setMode] = useState<UsagePercentMode>(() => loadUsagePercentMode());
  const onModeChange = useCallback((next: UsagePercentMode) => {
    setMode(next);
    saveUsagePercentMode(next);
  }, []);

  if (!isActive(activeProvider)) {
    return null;
  }
  const ordered = pinActiveProvider(snapshots, activeProvider);
  const active = ordered.find((s) => s.provider === activeProvider) ?? null;
  const primary = primaryUsageLimit(active);
  if (!active || active.status !== 'ok' || !primary || typeof primary.usedPercent !== 'number') {
    return null;
  }

  const notStarted = isNotStartedLimit(primary);
  const fill = ringFillPercent(primary.usedPercent);
  const reset = primary.resetsAt && !notStarted ? formatResetCountdown(primary.resetsAt) : null;
  const percentLabel = formatPercentLabel(primary.usedPercent, mode, { notStarted });
  const chipLabel = notStarted
    ? 'Not started'
    : reset
      ? `${percentLabel.replace(/ (used|left)$/, '')} · ${reset}`
      : percentLabel.replace(/ (used|left)$/, '');

  const sharedUpdated = freshestUpdatedAt(snapshots);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-ui-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label={`${active.provider} quota`}
          data-testid="quota-chip"
        >
          <CircularProgress percentage={fill} />
          <span className="tabular-nums">{chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3" data-testid="quota-panel">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui-sm text-muted-foreground">Quota</span>
          <PercentModeToggle mode={mode} onChange={onModeChange} />
        </div>
        {ordered.map((snapshot, index) => (
          <SnapshotCard
            key={snapshot.provider}
            snapshot={snapshot}
            emphasized={index === 0}
            mode={mode}
          />
        ))}
        {sharedUpdated ? (
          <p className="text-ui-sm text-muted-foreground" data-testid="quota-updated">
            Updated {formatUpdatedAgo(sharedUpdated)}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});

function isActive(value: string | null | undefined): value is UsageProviderId {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}
