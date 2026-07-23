import type { LoopRunVerify, LoopStatus } from '../lib/api';
import { checkLabel } from '../lib/loop-check-label';
import { cn } from '@/lib/utils';

/**
 * Loop status chip. Calm for active, muted for paused, amber for broken (reusing
 * the rung-1 needs-attention idiom), success for completed. A hairline-tinted pill
 * rather than a solid fill so a wall of loops stays quiet until one needs the eye.
 */
const STATUS_META: Record<LoopStatus, { label: string; className: string; dot: string }> = {
  active: {
    label: 'Active',
    className: 'border-success/30 bg-success/10 text-success',
    dot: 'bg-success shadow-[0_0_5px_var(--color-success)]',
  },
  paused: {
    label: 'Paused',
    className: 'border-border/70 bg-muted/40 text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  broken: {
    label: 'Paused after failures',
    className: 'border-warning/40 bg-warning/10 text-warning',
    dot: 'bg-warning animate-pulse shadow-[0_0_5px_var(--color-warning)]',
  },
  completed: {
    label: 'Completed',
    className: 'border-info/30 bg-info/10 text-info',
    dot: 'bg-info',
  },
};

export function LoopStatusChip({ status, className }: { status: LoopStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-sm font-medium',
        meta.className,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full shrink-0', meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

const VERIFY_DOT: Record<LoopRunVerify, string> = {
  green: 'bg-success shadow-[0_0_4px_var(--color-success)]',
  red: 'bg-destructive',
  none: 'bg-muted-foreground/50',
};

/** Tri-state verify dot for a run — green/red/neutral. */
export function VerifyDot({ verify, className }: { verify: LoopRunVerify; className?: string }) {
  const label = checkLabel(verify);
  return (
    <span
      className={cn('inline-block size-[7px] rounded-full shrink-0', VERIFY_DOT[verify], className)}
      title={label}
      aria-label={label}
    />
  );
}
