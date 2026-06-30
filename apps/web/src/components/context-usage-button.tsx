import { memo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatTokens, type ContextUsage } from '@/lib/use-context-usage';
import { cn } from '@/lib/utils';

interface ContextUsageButtonProps {
  usage: ContextUsage;
}

function CircularProgress({ percentage, size = 20 }: { percentage: number; size?: number }) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const color = percentage > 80 ? '#ef4444' : percentage > 50 ? '#f59e0b' : '#64748b';

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

export const ContextUsageButton = memo(function ContextUsageButton({ usage }: ContextUsageButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Context usage"
          data-testid="context-usage-button"
        >
          <CircularProgress percentage={usage.percentage} />
          <span>{usage.percentage}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3" data-testid="context-usage-panel">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-medium text-foreground">Context Usage</span>
          <span className="text-[11px] text-muted-foreground">
            {formatTokens(usage.total)} / {formatTokens(usage.window)}
          </span>
        </div>
        <div className="flex h-1.5 rounded-full overflow-hidden mb-3 bg-muted/30">
          {usage.breakdown.map((item, i) => (
            <div
              key={item.label}
              className={cn(i > 0 && 'border-l border-background/50')}
              style={{ width: `${(item.tokens / usage.total) * 100}%`, backgroundColor: item.color }}
            />
          ))}
        </div>
        <div className="space-y-1.5">
          {usage.breakdown.map((item) => (
            <div key={item.label} className="flex items-center gap-2 text-[12px]">
              <span
                className="size-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-foreground/80 flex-1">{item.label}</span>
              <span className="text-muted-foreground tabular-nums">{formatTokens(item.tokens)}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
