import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronDown, GitBranch, Slash, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskDigest } from '@/lib/transcript-build-blocks';
import { VerifyChip } from '../verify-chip';
import { cn } from '@/lib/utils';

const STATUS: Record<
  TaskDigest['status'],
  { label: string; icon: LucideIcon; pill: string; icclass: string }
> = {
  DONE: {
    label: 'Done',
    icon: CheckCircle2,
    pill: 'border-success/40 text-success bg-success/5',
    icclass: 'text-success',
  },
  FAILED: {
    label: 'Failed',
    icon: XCircle,
    pill: 'border-destructive/40 text-destructive bg-destructive/5',
    icclass: 'text-destructive',
  },
  CANCELLED: {
    label: 'Cancelled',
    icon: Slash,
    pill: 'border-border text-muted-foreground bg-muted/20',
    icclass: 'text-muted-foreground',
  },
};

function digestVerifyStatus(verify: TaskDigest['verify']) {
  if (!verify) return null;
  return { state: verify.passed ? ('passed' as const) : ('failed' as const) };
}

interface TaskDigestCardProps {
  digest: TaskDigest;
  onOpenSession?: (sessionId: string) => void;
}

export function TaskDigestCard({ digest, onOpenSession }: TaskDigestCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS[digest.status];
  const StatusIcon = meta.icon;
  const verify = digestVerifyStatus(digest.verify);
  const hasSummary = !!digest.outcomeSummary;
  const childHref = digest.childSessionId ? `/session/${digest.childSessionId}` : null;

  return (
    <div
      data-testid="task-digest-card"
      className="max-w-[88%] overflow-hidden rounded-lg border border-border/60 bg-card text-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-2.5">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs font-semibold uppercase leading-none',
            meta.pill,
          )}
        >
          <StatusIcon className={cn('size-3', meta.icclass)} aria-hidden />
          {meta.label}
        </span>
        <span className="text-ui-sm font-medium text-foreground/70">Subagent</span>
        {verify && <VerifyChip status={verify} />}
        {digest.childBranch && (
          <span
            className="inline-flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground"
            title={`Branch ${digest.childBranch}`}
          >
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{digest.childBranch}</span>
          </span>
        )}
        {childHref && (
          <a
            href={childHref}
            data-testid="task-digest-open"
            onClick={(event) => {
              if (!digest.childSessionId || !onOpenSession) return;
              event.preventDefault();
              onOpenSession(digest.childSessionId);
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-ui-sm font-medium text-primary transition-colors hover:bg-primary/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open session
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        )}
      </div>

      {hasSummary && (
        <div className="border-t border-border/40">
          <button
            type="button"
            data-testid="task-digest-summary-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="group flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="font-medium">{expanded ? 'Hide outcome' : 'Show outcome'}</span>
            <ChevronDown
              className={cn(
                'ml-auto size-3.5 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground',
                expanded && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
          {expanded && (
            <pre className="mx-3.5 mb-3 whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-ui font-mono leading-relaxed text-foreground/85 max-h-[40vh] overflow-y-auto">
              {digest.outcomeSummary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
