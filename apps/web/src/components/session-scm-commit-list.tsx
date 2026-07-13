import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import type { GitCommitDto } from '../lib/api';
import { fetchCommitDiff } from '../lib/api';
import { cn } from '@/lib/utils';
import { DiffView } from './diff-view';

interface SessionScmCommitListProps {
  title: string;
  direction: 'up' | 'down';
  commits: GitCommitDto[];
  base: string | null;
  sessionId: string;
}

export function SessionScmCommitList({
  title,
  direction,
  commits,
  base,
  sessionId,
}: SessionScmCommitListProps) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [diffBySha, setDiffBySha] = useState<Record<string, { diff: string; truncated: boolean }>>({});
  const [loadingSha, setLoadingSha] = useState<string | null>(null);

  if (commits.length === 0) return null;

  const DirectionIcon = direction === 'up' ? ArrowUp : ArrowDown;

  const toggleCommit = async (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (diffBySha[sha]) return;
    try {
      setLoadingSha(sha);
      const result = await fetchCommitDiff(sessionId, sha);
      setDiffBySha((current) => ({ ...current, [sha]: result }));
    } catch {
      setDiffBySha((current) => ({ ...current, [sha]: { diff: '', truncated: false } }));
    } finally {
      setLoadingSha(null);
    }
  };

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1.5 px-3 py-2 text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <DirectionIcon className="size-3.5 shrink-0" aria-hidden />
        <span>{title}</span>
        {base && (
          <span className="ml-auto truncate font-mono text-xs font-normal normal-case tracking-normal">
            vs {base}
          </span>
        )}
      </div>
      <ul className="flex flex-col pb-1">
        {commits.map((commit) => {
          const isOpen = expandedSha === commit.sha;
          const diff = diffBySha[commit.sha];
          return (
            <li key={commit.sha} className="border-t border-border/30 first:border-t-0">
              <button
                type="button"
                title={`${commit.sha}\n${commit.authorName} · ${commit.authoredAt}`}
                onClick={() => void toggleCommit(commit.sha)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/40"
              >
                {isOpen ? (
                  <ChevronDown className="size-3 shrink-0 self-center" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 self-center" />
                )}
                <span className="shrink-0 text-muted-foreground">{commit.shortSha}</span>
                <span className="min-w-0 truncate text-foreground">{commit.subject}</span>
              </button>
              {isOpen && (
                <div className="px-3 pb-2">
                  {loadingSha === commit.sha && (
                    <div className="py-2 text-xs text-muted-foreground">Loading diff…</div>
                  )}
                  {diff && (
                    <>
                      {diff.truncated && (
                        <div className="mb-1 text-xs text-muted-foreground">Diff truncated.</div>
                      )}
                      <DiffView diff={diff.diff} className={cn(loadingSha === commit.sha && 'opacity-50')} />
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
