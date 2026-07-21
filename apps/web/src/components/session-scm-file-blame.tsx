import { useEffect, useState } from 'react';
import { fetchGitBlame, type GitBlameDto } from '../lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

interface SessionScmFileBlameProps {
  sessionId: string;
  path: string;
  open: boolean;
  onToggle: () => void;
}

export function SessionScmFileBlame({ sessionId, path, open, onToggle }: SessionScmFileBlameProps) {
  const [blame, setBlame] = useState<GitBlameDto | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (blame?.path === path) return;
    let cancelled = false;
    setLoading(true);
    void fetchGitBlame(sessionId, path)
      .then((result) => {
        if (!cancelled) setBlame(result);
      })
      .catch(() => {
        if (!cancelled) setBlame({ path, lines: [], truncated: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, path, blame?.path]);

  return (
    <div className="mt-2 border-t border-border/40 pt-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={onToggle}
      >
        {open ? 'Hide blame' : 'Blame'}
      </Button>
      {open && (
        <div className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted/30">
          {loading && <div className="px-2 py-2 text-xs text-muted-foreground">Loading blame…</div>}
          {!loading && blame && blame.lines.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">Blame unavailable.</div>
          )}
          {!loading && blame && blame.lines.length > 0 && (
            <>
              {blame.truncated && (
                <div className="border-b border-border/40 px-2 py-1 text-ui-xs text-muted-foreground">
                  Blame truncated.
                </div>
              )}
              <pre className="p-2 font-mono text-ui-xs leading-4">
                {blame.lines.map((line) => (
                  <div
                    key={`${line.line}-${line.sha}`}
                    className={cn('flex gap-2 whitespace-pre-wrap break-all')}
                    title={`${line.authorName} · ${line.authoredAt}`}
                  >
                    <span className="shrink-0 text-muted-foreground">{line.shortSha}</span>
                    <span className="shrink-0 w-8 text-right text-muted-foreground">{line.line}</span>
                    <span className="min-w-0 flex-1 text-foreground/90">{line.content}</span>
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
