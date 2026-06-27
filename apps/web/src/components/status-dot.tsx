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

export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block size-[7px] rounded-full shrink-0',
        STATUS_CLASS[status],
        className,
      )}
      title={statusLabel(status)}
    />
  );
}
