import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FastLightningToggleProps {
  active: boolean;
  className?: string;
}

/** Non-interactive fast-mode indicator (green when on) shown on the model trigger. */
export function FastLightningToggle({ active, className }: FastLightningToggleProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        active ? 'text-success' : 'text-muted-foreground',
        className,
      )}
      aria-hidden={!active}
      aria-label={active ? 'Fast mode on' : undefined}
    >
      <Zap
        className={cn(
          'size-3.5',
          // Pin `stroke` on the paths so the menu trigger's focus:**:text-accent-foreground
          // (which only overrides `color`) can't wash the lit icon white on hover.
          active && 'fill-success/25 stroke-success [&_*]:stroke-success',
        )}
        strokeWidth={2}
      />
    </span>
  );
}
