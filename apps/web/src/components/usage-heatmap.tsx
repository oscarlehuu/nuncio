import { useMemo, useState } from 'react';
import type { UsageHistoryDayDto, UsageProviderId } from '@/lib/usage-api';
import { buildHeatmapWeeks, heatmapLevel } from '@/lib/usage-heatmap-utils';
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

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''] as const;

function dayTokens(day: UsageHistoryDayDto, filter: UsageProviderId | null): number {
  if (filter) return day[filter];
  return day.claude + day.codex + day.cursor;
}

function displayValue(tokens: number, provider: UsageProviderId, unit: UsageUnit): number {
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

const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-muted/40',
  1: 'bg-foreground/15',
  2: 'bg-foreground/30',
  3: 'bg-foreground/50',
  4: 'bg-foreground/80',
};

interface UsageHeatmapProps {
  days: ReadonlyArray<UsageHistoryDayDto>;
  unit: UsageUnit;
  className?: string;
}

export function UsageHeatmap({ days, unit, className }: UsageHeatmapProps) {
  const [filter, setFilter] = useState<UsageProviderId | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const weeks = useMemo(() => buildHeatmapWeeks(days), [days]);
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);

  const periodTotals = useMemo(() => {
    const totals: Record<UsageProviderId, number> = { claude: 0, codex: 0, cursor: 0 };
    for (const day of days) {
      for (const provider of PROVIDER_ORDER) totals[provider] += day[provider];
    }
    return totals;
  }, [days]);

  const maxDay = useMemo(() => {
    let max = 0;
    for (const day of days) {
      max = Math.max(max, dayTokens(day, filter));
    }
    return max;
  }, [days, filter]);

  const hoverDay = hoverDate ? byDate.get(hoverDate) ?? null : null;
  const anyData = days.some((day) => day.claude + day.codex + day.cursor > 0);

  const toggleFilter = (provider: UsageProviderId) => {
    setFilter((prev) => (prev === provider ? null : provider));
  };

  if (!anyData) {
    return (
      <div className={cn('space-y-2', className)} data-testid="usage-heatmap">
        <p className="text-ui-sm text-muted-foreground py-6 text-center">
          No local token activity in this window.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)} data-testid="usage-heatmap">
      <div className="mb-1.5 flex min-h-5 items-baseline justify-between gap-3" aria-live="polite">
        <div
          className="min-w-0 flex-1 text-ui-sm text-muted-foreground"
          data-testid="usage-heatmap-readout"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {hoverDay ? (
              <span className="tabular-nums text-foreground">{hoverDay.date}</span>
            ) : null}
            {PROVIDER_ORDER.map((provider) => {
              const active = filter === provider;
              const dimmed = filter != null && !active;
              const raw = hoverDay ? hoverDay[provider] : periodTotals[provider];
              const value = displayValue(raw, provider, unit);
              return (
                <button
                  key={provider}
                  type="button"
                  data-testid={`usage-heatmap-legend-${provider}`}
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
                    (sum, provider) => sum + displayValue(hoverDay[provider], provider, unit),
                    0,
                  ),
                  unit,
                )}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
          <span>Less</span>
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <span
              key={level}
              className={cn('size-2.5 rounded-[3px]', LEVEL_CLASS[level])}
              aria-hidden
            />
          ))}
          <span>More</span>
        </div>
      </div>

      <div
        className="w-full"
        onMouseLeave={() => setHoverDate(null)}
        data-testid="usage-heatmap-grid"
      >
        <div className="flex w-full gap-1.5">
          <div className="flex w-6 shrink-0 flex-col justify-between py-px text-[10px] leading-none text-muted-foreground/70">
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={index} className="flex flex-1 items-center">
                {label}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 gap-[3px]">
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="flex min-w-0 flex-1 flex-col gap-[3px]">
                {week.map((cell, dayIndex) => {
                  if (!cell) {
                    return (
                      <span
                        key={`pad-${weekIndex}-${dayIndex}`}
                        className="aspect-square w-full rounded-[3px] bg-transparent"
                      />
                    );
                  }
                  const value = dayTokens(cell, filter);
                  const level = heatmapLevel(value, maxDay);
                  const hot = hoverDate === cell.date;
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      data-testid={`usage-heatmap-cell-${cell.date}`}
                      data-level={level}
                      aria-label={`${cell.date}: ${formatAxisValue(
                        filter
                          ? displayValue(cell[filter], filter, unit)
                          : PROVIDER_ORDER.reduce(
                              (sum, provider) =>
                                sum + displayValue(cell[provider], provider, unit),
                              0,
                            ),
                        unit,
                      )}`}
                      onMouseEnter={() => setHoverDate(cell.date)}
                      onFocus={() => setHoverDate(cell.date)}
                      className={cn(
                        'aspect-square w-full rounded-[3px] transition-opacity',
                        LEVEL_CLASS[level],
                        hot && 'ring-1 ring-foreground/70 ring-offset-0',
                      )}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
