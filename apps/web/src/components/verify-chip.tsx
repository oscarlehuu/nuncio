import { Check, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VerifyStatus } from '../lib/derive-verify-status';

/** Post-turn check outcome, annotated next to the session identity. */
export function VerifyChip({ status }: { status: VerifyStatus | null }) {
  if (!status) return null;
  const label =
    status.state === 'running'
      ? 'Checks running'
      : status.state === 'passed'
        ? 'Checks passed'
        : status.timedOut
          ? 'Checks timed out'
          : 'Checks failed';
  return (
    <span
      aria-label={label}
      title={status.command ? `${label} · ${status.command}` : label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs font-medium leading-none',
        status.state === 'passed' && 'border-success/40 text-success',
        status.state === 'failed' && 'border-destructive/40 text-destructive',
        status.state === 'running' && 'border-border text-muted-foreground',
      )}
    >
      {status.state === 'running' ? (
        <Loader2 className="size-2.5 animate-spin" />
      ) : status.state === 'passed' ? (
        <Check className="size-2.5" />
      ) : (
        <X className="size-2.5" />
      )}
      Checks
    </span>
  );
}
