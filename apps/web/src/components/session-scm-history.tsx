import type { GitHistoryDto } from '../lib/api';
import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SessionScmHistoryProps {
  history: GitHistoryDto | null;
}

function graphGlyph(parentCount: number, isLast: boolean): string {
  if (parentCount > 1) return '◎';
  return isLast ? '●' : '●';
}

export function SessionScmHistory({ history }: SessionScmHistoryProps) {
  if (!history || history.commits.length === 0) return null;

  const commits = history.commits;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1.5 px-3 py-2 text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" aria-hidden />
        <span>Recent history</span>
        <span className="ml-auto truncate font-mono text-xs font-normal normal-case tracking-normal">
          {history.branch}
        </span>
      </div>
      <ul className="flex flex-col pb-2">
        {commits.map((commit, index) => {
          const isLast = index === commits.length - 1;
          const isMerge = commit.parents.length > 1;
          return (
            <li key={commit.sha} className="flex gap-2 px-3 py-0.5 font-mono text-xs">
              <div className="flex w-4 shrink-0 flex-col items-center">
                <span
                  className={cn(
                    'leading-none',
                    isMerge ? 'text-info' : 'text-muted-foreground',
                  )}
                  aria-hidden
                >
                  {graphGlyph(commit.parents.length, isLast)}
                </span>
                {!isLast && (
                  <span className="text-muted-foreground/50" aria-hidden>
                    │
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-muted-foreground">{commit.shortSha}</span>
                  <span className="min-w-0 truncate text-foreground" title={commit.subject}>
                    {commit.subject}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
