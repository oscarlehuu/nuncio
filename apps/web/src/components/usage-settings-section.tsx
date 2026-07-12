import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProviderIcon } from './provider-icon';
import { UsageHistoryChart } from './usage-history-chart';
import { UsageHeatmap } from './usage-heatmap';
import type { UsageProviderId, UsageSnapshotDto } from '@/lib/usage-api';
import {
  formatPercentLabel,
  formatResetCountdown,
  formatUpdatedAgo,
  freshestUpdatedAt,
  isNotStartedLimit,
  paceForLimit,
  primaryUsageLimit,
  usageNeedsAuthHint,
  usageSignInCommand,
} from '@/lib/usage-display';
import {
  loadUsagePercentMode,
  saveUsagePercentMode,
  type UsagePercentMode,
} from '@/lib/usage-percent-preference';
import {
  loadUsageUnit,
  saveUsageUnit,
  type UsageUnit,
} from '@/lib/usage-unit-preference';
import { useUsageSettingsData } from '@/lib/use-provider-usage';
import { cn } from '@/lib/utils';

const PROVIDER_ORDER: UsageProviderId[] = ['claude', 'codex', 'cursor'];
const PROVIDER_LABEL: Record<UsageProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

function statusSubtitle(snapshot: UsageSnapshotDto | undefined, mode: UsagePercentMode): string {
  if (!snapshot) return 'Loading…';
  switch (snapshot.status) {
    case 'ok': {
      const primary = primaryUsageLimit(snapshot);
      if (primary && typeof primary.usedPercent === 'number') {
        const notStarted = isNotStartedLimit(primary);
        const label = formatPercentLabel(primary.usedPercent, mode, { notStarted });
        const reset =
          primary.resetsAt && !notStarted ? formatResetCountdown(primary.resetsAt) : null;
        return `${primary.window} ${label}${reset ? ` · resets in ${reset}` : ''}`;
      }
      return snapshot.planName ? `Signed in · ${snapshot.planName}` : 'Signed in';
    }
    case 'needs-auth':
      return snapshot.detail ?? usageNeedsAuthHint(snapshot.provider);
    case 'unsupported':
      return snapshot.detail ?? 'Subscription meters unavailable for this auth.';
    case 'error':
      return snapshot.detail ?? 'Could not load usage.';
    default: {
      const _exhaustive: never = snapshot.status;
      return _exhaustive;
    }
  }
}

export function UsageSettingsSection() {
  const { snapshots, history, loading, refreshing, error, reload } = useUsageSettingsData();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<UsagePercentMode>(() => loadUsagePercentMode());
  const [unit, setUnit] = useState<UsageUnit>(() => loadUsageUnit());
  const [activityView, setActivityView] = useState<'bars' | 'heatmap'>('heatmap');

  const last30Days = useMemo(
    () => (history?.days ?? []).slice(-30),
    [history?.days],
  );

  const byId = new Map(snapshots.map((s) => [s.provider, s]));
  const sharedUpdated = freshestUpdatedAt(snapshots) ?? history?.updatedAt ?? null;

  const onModeChange = (next: UsagePercentMode) => {
    setMode(next);
    saveUsagePercentMode(next);
  };

  const onUnitChange = (next: UsageUnit) => {
    setUnit(next);
    saveUsageUnit(next);
  };

  return (
    <section data-testid="usage-settings-section">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Usage</h2>
          <p className="text-ui-sm text-muted-foreground mt-0.5">
            Live subscription quotas plus local Today / Last 30 Days token totals (and a 30-day
            chart) estimated from on-disk Claude, Codex, and Cursor logs — not invoice charges.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <div
            className="inline-flex rounded-md border border-border p-0.5 text-ui-sm"
            role="group"
            aria-label="Show used or remaining"
            data-testid="usage-settings-percent-mode"
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
                onClick={() => onModeChange(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div
            className="inline-flex rounded-md border border-border p-0.5 text-ui-sm"
            role="group"
            aria-label="Show tokens or estimated dollars"
            data-testid="usage-settings-unit-mode"
          >
            {(
              [
                { id: 'tokens' as const, label: 'tokens' },
                { id: 'usd' as const, label: '$' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded px-2 py-0.5 transition-colors',
                  unit === option.id
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={unit === option.id}
                onClick={() => onUnitChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void reload(true)}
            disabled={refreshing || loading}
            aria-label="Refresh usage"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {error ? <p className="text-ui text-destructive mb-3">{error}</p> : null}

      <div className="rounded-lg border border-border p-3 mb-3" data-testid="usage-analytics-panel">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div>
            <h3 className="text-ui font-medium text-foreground">
              {activityView === 'heatmap' ? 'Last 90 days' : 'Last 30 days'}
            </h3>
            <p className="text-ui-sm text-muted-foreground">Estimated from local logs</p>
          </div>
          <div
            className="inline-flex rounded-md border border-border p-0.5 text-ui-sm"
            role="group"
            aria-label="Activity view"
            data-testid="usage-activity-view"
          >
            {(
              [
                { id: 'heatmap' as const, label: 'Heatmap' },
                { id: 'bars' as const, label: 'Bars' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded px-2 py-0.5 transition-colors',
                  activityView === option.id
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={activityView === option.id}
                onClick={() => setActivityView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {activityView === 'heatmap' ? (
          <UsageHeatmap days={history?.days ?? []} unit={unit} />
        ) : (
          <UsageHistoryChart days={last30Days} unit={unit} />
        )}
      </div>

      <div className="rounded-lg border border-border divide-y divide-border">
        {PROVIDER_ORDER.map((providerId) => {
          const snapshot = byId.get(providerId);
          const isOpen = expanded[providerId] === true;
          const needsAuth = snapshot?.status === 'needs-auth';
          return (
            <div key={providerId} data-testid={`usage-settings-row-${providerId}`}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 transition-colors"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [providerId]: !prev[providerId] }))
                }
                aria-expanded={isOpen}
              >
                <ProviderIcon providerId={providerId} className="size-5 text-foreground/80 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ui font-medium text-foreground">
                      {PROVIDER_LABEL[providerId]}
                    </span>
                    {snapshot?.planName ? (
                      <span className="text-ui-sm text-muted-foreground truncate">
                        {snapshot.planName}
                      </span>
                    ) : null}
                    {needsAuth ? (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-ui-sm text-amber-700 dark:text-amber-400">
                        Not signed in
                      </span>
                    ) : null}
                  </div>
                  <p className="text-ui-sm text-muted-foreground truncate">
                    {loading && !snapshot ? 'Loading…' : statusSubtitle(snapshot, mode)}
                  </p>
                </div>
              </button>
              {isOpen && snapshot ? (
                <div className="px-3 pb-3 space-y-2 border-t border-border/50 bg-muted/20">
                  {snapshot.status === 'ok' && snapshot.limits.length > 0 ? (
                    snapshot.limits.map((limit) => {
                      const notStarted = isNotStartedLimit(limit);
                      const pace = !notStarted ? paceForLimit(limit) : null;
                      return (
                        <div key={limit.window} className="space-y-0.5 pt-2">
                          <div className="flex justify-between gap-2 text-ui">
                            <span className="text-foreground/80">{limit.window}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {typeof limit.usedPercent === 'number'
                                ? formatPercentLabel(limit.usedPercent, mode, { notStarted })
                                : '—'}
                              {limit.resetsAt && !notStarted
                                ? ` · ${formatResetCountdown(limit.resetsAt)}`
                                : ''}
                            </span>
                          </div>
                          {pace?.amountText || pace?.etaText ? (
                            <p
                              className={cn(
                                'text-ui-sm',
                                pace.status === 'behind'
                                  ? 'text-destructive'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {[pace.amountText, pace.etaText].filter(Boolean).join(' · ')}
                            </p>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="pt-2 space-y-1">
                      <p className="text-ui text-muted-foreground">
                        {snapshot.detail ?? usageNeedsAuthHint(providerId)}
                      </p>
                      {needsAuth ? (
                        <p className="text-ui-sm text-muted-foreground" data-testid={`usage-auth-cta-${providerId}`}>
                          Run{' '}
                          <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                            {usageSignInCommand(providerId)}
                          </code>{' '}
                          on this Mac, then Refresh.
                        </p>
                      ) : null}
                    </div>
                  )}
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
            </div>
          );
        })}
      </div>

      {sharedUpdated ? (
        <p className="text-ui-sm text-muted-foreground mt-3" data-testid="usage-settings-updated">
          Updated {formatUpdatedAgo(sharedUpdated)}
        </p>
      ) : null}
    </section>
  );
}
