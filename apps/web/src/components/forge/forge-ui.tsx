import { relativeTime } from '../../lib/api';
import type { ForgeCheckDto, ForgeComment } from '../../lib/forge-api';
import { MarkdownView } from '../markdown-view';
import { cn } from '@/lib/utils';

export function forgeTimeAgo(iso: string): string {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? '' : relativeTime(ts);
}

const STATE_CLASSES: Record<string, string> = {
  open: 'text-success border-success/40 bg-success/10',
  merged: 'text-info border-info/40 bg-info/10',
  closed: 'text-destructive border-destructive/40 bg-destructive/10',
  draft: 'text-muted-foreground border-border bg-muted',
};

export function ForgeStateBadge({ state, draft }: { state: string; draft?: boolean }) {
  const label = draft && state === 'open' ? 'draft' : state;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATE_CLASSES[label] ?? 'text-muted-foreground border-border bg-muted',
      )}
    >
      {label}
    </span>
  );
}

export function checkStatusClass(conclusion: string | null): string {
  switch (conclusion) {
    case 'success':
      return 'text-success border-success/40 bg-success/5';
    case 'failure':
    case 'failed':
    case 'action_required':
    case 'timed_out':
      return 'text-destructive border-destructive/40 bg-destructive/5';
    case 'cancelled':
    case 'canceled':
    case 'skipped':
      return 'text-muted-foreground bg-muted border-border';
    default:
      return 'text-warning border-warning/40 bg-warning/5';
  }
}

export function ChecksList({ checks }: { checks: ForgeCheckDto[] }) {
  if (checks.length === 0) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">No checks reported.</div>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {checks.map((check) => (
        <li
          key={check.name}
          className={cn(
            'flex items-center justify-between gap-3 rounded-md border p-2 font-mono text-xs',
            checkStatusClass(check.conclusion),
          )}
        >
          <span className="truncate font-semibold">{check.name}</span>
          <span className="shrink-0 text-[10px] uppercase">{check.conclusion || check.status}</span>
        </li>
      ))}
    </ul>
  );
}

export function ForgeCommentCard({ comment }: { comment: ForgeComment }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60">
      <div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-xs">
        <span className="font-semibold">{comment.author}</span>
        <span className="text-muted-foreground">{forgeTimeAgo(comment.createdAt)}</span>
      </div>
      <div className="px-2.5 py-2 text-sm">
        <MarkdownView text={comment.body} className="text-sm" />
      </div>
    </div>
  );
}
