import type { SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import { deriveStatusDotTone } from '../lib/derive-status-dot-tone';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<
  Exclude<ReturnType<typeof deriveStatusDotTone>, 'hidden'>,
  string
> = {
  neutral: 'bg-muted-foreground',
  running: 'bg-muted-foreground animate-pulse',
  warning: 'bg-warning animate-pulse shadow-[0_0_6px_var(--color-warning)]',
  error: 'bg-destructive',
  archived: 'bg-muted-foreground opacity-40',
};

export function ConnectionDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 rounded-full shrink-0 bg-muted-foreground', className)}
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
  const tone = deriveStatusDotTone(status, pending);
  if (tone === 'hidden') return null;

  const dotClass = TONE_CLASS[tone];
  return (
    <span
      className={cn('inline-block size-[7px] rounded-full shrink-0', dotClass, className)}
      title={pending ? 'Waiting for you' : statusLabel(status)}
    />
  );
}
