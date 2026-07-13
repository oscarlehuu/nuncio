import { useEffect, useState } from 'react';
import { CircleDot } from 'lucide-react';
import { fetchForgeIssues, type ForgeIssueSummary } from '../lib/forge-api';

interface SessionScmIssuesProps {
  repoPath?: string;
}

export function SessionScmIssues({ repoPath }: SessionScmIssuesProps) {
  const [issues, setIssues] = useState<ForgeIssueSummary[] | null>(null);

  useEffect(() => {
    if (!repoPath) {
      setIssues(null);
      return;
    }
    let cancelled = false;
    void fetchForgeIssues(repoPath, 'open')
      .then((result) => {
        if (!cancelled) setIssues(result.slice(0, 5));
      })
      .catch(() => {
        if (!cancelled) setIssues(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  if (!issues || issues.length === 0) return null;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1.5 px-3 py-2 text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <CircleDot className="size-3.5 shrink-0" aria-hidden />
        <span>Open issues</span>
      </div>
      <ul className="flex flex-col pb-2">
        {issues.map((issue) => (
          <li key={issue.number} className="px-3 py-1">
            {issue.url ? (
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-baseline gap-2 text-xs hover:underline"
              >
                <span className="shrink-0 font-mono text-muted-foreground">#{issue.number}</span>
                <span className="min-w-0 truncate text-foreground">{issue.title}</span>
              </a>
            ) : (
              <div className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">#{issue.number}</span>
                <span className="min-w-0 truncate text-foreground">{issue.title}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
