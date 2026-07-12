import { useMemo, useState } from 'react';
import type { UsageHistoryDayDto, UsageProviderId } from '@/lib/usage-api';
import { USAGE_USD_PER_MTOK, type UsageUnit } from '@/lib/usage-unit-preference';
import { cn } from '@/lib/utils';

const PROVIDER_ORDER: UsageProviderId[] = ['claude', 'codex', 'cursor'];
const PROVIDER_COLOR: Record<UsageProviderId, string> = {
  claude: 'var(--chart-1)',
  codex: 'var(--chart-2)',
  cursor: 'var(--chart-3)',
};
const PROVIDER_LABEL: Record<UsageProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

function dayValue(day: UsageHistoryDayDto, provider: UsageProviderId, unit: UsageUnit): number {
  const tokens = day[provider];
  if (unit === 'tokens') return tokens;
  return (tokens / 1_000_000) * USAGE_USD_PER_MTOK[provider];
}

function formatAxisValue(value: number, unit: UsageUnit): string {
  if (unit === 'usd') {
    if (value < 0.01) return `$${value.toFixed(3)}`;
    if (value < 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(value < 10 ? 2 : 0)}`;
  }
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

interface UsageHistoryChartProps {
  days: ReadonlyArray<UsageHistoryDayDto>;
  unit: UsageUnit;
  className?: string;
}

export function UsageHistoryChart({ days, unit, className }: UsageHistoryChartProps) {
  const [filter, setFilter] = useState<UsageProviderId | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 560;
  const height = 140;
  const padX = 8;
  const padTop = 4;
  const padBottom = 18;
  const chartH = height - padTop - padBottom;
  const chartW = width - padX * 2;

  const periodTotals = useMemo(() => {
    const totals: Record<UsageProviderId, number> = { claude: 0, codex: 0, cursor: 0 };
    for (const day of days) {
      for (const provider of PROVIDER_ORDER) {
        totals[provider] += day[provider];
      }
    }
    return totals;
  }, [days]);

  const stackProviders = useMemo(
    () => (filter ? ([filter] as UsageProviderId[]) : PROVIDER_ORDER),
    [filter],
  );

  const dayTotals = days.map((day) =>
    stackProviders.reduce((sum, provider) => sum + dayValue(day, provider, unit), 0),
  );
  const max = Math.max(...dayTotals, 0);
  const anyData = days.some((day) =>
    PROVIDER_ORDER.some((provider) => dayValue(day, provider, unit) > 0),
  );
  const hasData = anyData && max > 0;
  const barGap = 2;
  const barWidth =
    days.length > 0 ? Math.max(2, (chartW - barGap * (days.length - 1)) / days.length) : 0;

  const hoverDay = hoverIndex != null ? (days[hoverIndex] ?? null) : null;

  const toggleFilter = (provider: UsageProviderId) => {
    setFilter((prev) => (prev === provider ? null : provider));
  };

  return (
    <div className={cn('space-y-2', className)} data-testid="usage-history-chart">
      {!anyData ? (
        <p className="text-ui-sm text-muted-foreground py-6 text-center">
          No local token activity in the last {days.length || 30} days.
        </p>
      ) : (
        <div>
          {/* Idle: provider totals (also the filter). Hover: same row swaps to that day. */}
          <div
            className="mb-1.5 flex min-h-5 items-baseline justify-between gap-3"
            aria-live="polite"
          >
            <div
              className="min-w-0 flex-1 text-ui-sm text-muted-foreground"
              data-testid="usage-history-readout"
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {hoverDay ? (
                  <span className="tabular-nums text-foreground">{hoverDay.date}</span>
                ) : null}
                {PROVIDER_ORDER.map((provider) => {
                  const active = filter === provider;
                  const dimmed = filter != null && !active;
                  const raw = hoverDay ? hoverDay[provider] : periodTotals[provider];
                  const value = unit === 'tokens' ? raw : (raw / 1_000_000) * USAGE_USD_PER_MTOK[provider];
                  return (
                    <button
                      key={provider}
                      type="button"
                      data-testid={`usage-legend-${provider}`}
                      aria-pressed={active}
                      title={
                        active
                          ? `Clear ${PROVIDER_LABEL[provider]} filter`
                          : `Filter to ${PROVIDER_LABEL[provider]}`
                      }
                      onClick={() => toggleFilter(provider)}
                      className={cn(
                        'inline-flex items-center gap-1 tabular-nums transition-opacity',
                        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                        dimmed && 'opacity-35',
                      )}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: PROVIDER_COLOR[provider] }}
                        aria-hidden
                      />
                      <span>{PROVIDER_LABEL[provider]}</span>
                      <span className="text-foreground/90">{formatAxisValue(value, unit)}</span>
                    </button>
                  );
                })}
                {hoverDay && !filter ? (
                  <span className="tabular-nums text-foreground/60">
                    ·{' '}
                    {formatAxisValue(
                      PROVIDER_ORDER.reduce(
                        (sum, provider) => sum + dayValue(hoverDay, provider, unit),
                        0,
                      ),
                      unit,
                    )}
                  </span>
                ) : null}
              </div>
            </div>
            <span
              className="shrink-0 text-ui-sm tabular-nums text-muted-foreground"
              data-testid="usage-history-max"
            >
              peak {formatAxisValue(max, unit)}
            </span>
          </div>

          {!hasData ? (
            <p
              className="text-ui-sm text-muted-foreground py-6 text-center"
              data-testid="usage-history-filter-empty"
            >
              No {filter ? PROVIDER_LABEL[filter] : ''} tokens in this window. Click again to clear
              the filter.
            </p>
          ) : (
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-36"
              role="img"
              aria-label="Local token usage over the last 30 days"
              onMouseLeave={() => setHoverIndex(null)}
            >
              {hoverIndex != null ? (
                <rect
                  x={padX + hoverIndex * (barWidth + barGap) - 1}
                  y={padTop}
                  width={barWidth + 2}
                  height={chartH}
                  className="fill-foreground/[0.06]"
                  rx={2}
                  pointerEvents="none"
                />
              ) : null}
              {days.map((day, index) => {
                const x = padX + index * (barWidth + barGap);
                let y = padTop + chartH;
                const stacks = stackProviders.map((provider) => {
                  const value = dayValue(day, provider, unit);
                  const h = max > 0 ? (value / max) * chartH : 0;
                  y -= h;
                  return { provider, y, h };
                });
                const dimmed = hoverIndex != null && hoverIndex !== index;
                return (
                  <g key={day.date}>
                    {stacks.map(({ provider, y: stackY, h }) =>
                      h > 0 ? (
                        <rect
                          key={provider}
                          x={x}
                          y={stackY}
                          width={barWidth}
                          height={h}
                          fill={PROVIDER_COLOR[provider]}
                          rx={1}
                          opacity={dimmed ? 0.35 : 1}
                          pointerEvents="none"
                        />
                      ) : null,
                    )}
                    <rect
                      x={x}
                      y={padTop}
                      width={Math.max(barWidth, 2)}
                      height={chartH}
                      fill="transparent"
                      data-testid={`usage-history-bar-${day.date}`}
                      onMouseEnter={() => setHoverIndex(index)}
                      className="cursor-default"
                    />
                  </g>
                );
              })}
              <text
                x={padX}
                y={height - 4}
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {days[0]?.date?.slice(5) ?? ''}
              </text>
              <text
                x={width - padX}
                y={height - 4}
                textAnchor="end"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {days[days.length - 1]?.date?.slice(5) ?? ''}
              </text>
            </svg>
          )}
        </div>
      )}
    </div>
  );
}
