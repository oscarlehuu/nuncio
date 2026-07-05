import type { SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import { cn } from '@/lib/utils';

const STATUS_CLASS: Record<SessionStatus, string> = {
  CREATED: 'bg-muted-foreground',
  RUNNING: 'bg-success animate-pulse shadow-[0_0_6px_var(--color-success)]',
  IDLE: 'bg-info',
  PAUSED: 'bg-muted-foreground',
  ARCHIVED: 'bg-muted-foreground opacity-40',
  ERROR: 'bg-destructive',
};

export function ConnectionDot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 rounded-full shrink-0 bg-success shadow-[0_0_5px_var(--color-success)]',
        className,
      )}
      aria-hidden
    />
  );
}

export function StatusDot({
  status,
  pending = false,
  className,
}: {
  status: SessionStatus;
  /** Blocked awaiting user input — overrides the run-state color with amber. */
  pending?: boolean;
  className?: string;
}) {
  const dotClass = pending
    ? 'bg-warning animate-pulse shadow-[0_0_6px_var(--color-warning)]'
    : STATUS_CLASS[status];
  return (
    <span
      className={cn('inline-block size-[7px] rounded-full shrink-0', dotClass, className)}
      title={pending ? 'Waiting for you' : statusLabel(status)}
    />
  );
}
