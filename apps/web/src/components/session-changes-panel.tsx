import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchSessionDiff,
  postDiffComment,
  type DiffFile,
  type DiffHunk,
  type SessionDiff,
  type SessionStatus,
} from '../lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { SessionChangeFileRow } from './session-change-file-row';
import { hunkRange, hunkText, type ComposerKey } from './session-changes-panel-format';

interface SessionChangesPanelProps {
  sessionId: string;
  sessionStatus: SessionStatus;
}

export function SessionChangesPanel({ sessionId, sessionStatus }: SessionChangesPanelProps) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [composerKey, setComposerKey] = useState<ComposerKey | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sentKey, setSentKey] = useState<ComposerKey | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setDiff(await fetchSessionDiff(sessionId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load changes');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return files.reduce(
      (sum, file) => ({
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  }, [diff]);

  const toggle = (file: DiffFile) => {
    if (file.collapsed || file.hunks.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  };

  const submitComment = async (file: DiffFile, hunk: DiffHunk, key: ComposerKey) => {
    const trimmed = comment.trim();
    if (!trimmed || sending) return;
    const range = hunkRange(hunk);
    try {
      setSending(true);
      await postDiffComment(sessionId, {
        path: file.path,
        startLine: range.startLine,
        endLine: range.endLine,
        hunk: hunkText(hunk),
        comment: trimmed,
      });
      setComment('');
      setComposerKey(null);
      setSentKey(key);
      toast.success(
        sessionStatus === 'RUNNING'
          ? 'Sent to agent — queued for the running session'
          : 'Sent to agent',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send diff comment');
    } finally {
      setSending(false);
    }
  };

  if (loading && !diff) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">Loading changes…</div>;
  }

  const files = diff?.files ?? [];
  if (files.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-3 py-3 text-sm text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span>No changes yet.</span>
          <Button size="icon" variant="ghost" aria-label="Refresh changes" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-card-foreground">
      <div className="flex min-h-11 items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{files.length} changed file{files.length === 1 ? '' : 's'}</span>
        <span className="shrink-0 font-mono text-xs">
          {totals.additions > 0 && <span className="text-success">+{totals.additions}</span>}{' '}
          {totals.deletions > 0 && <span className="text-destructive">-{totals.deletions}</span>}
        </span>
        <Button size="icon" variant="ghost" aria-label="Refresh changes" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      {diff?.truncated && (
        <div className="border-b border-border/50 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
          Diff truncated. {diff.omittedFiles} file{diff.omittedFiles === 1 ? '' : 's'} omitted.
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {files.map((file) => (
          <SessionChangeFileRow
            key={file.path}
            file={file}
            isOpen={expanded.has(file.path)}
            composerKey={composerKey}
            comment={comment}
            sending={sending}
            sentKey={sentKey}
            onToggle={toggle}
            onOpenComposer={(key) => {
              setComposerKey(key);
              setComment('');
            }}
            onCommentChange={setComment}
            onSubmitComment={(nextFile, hunk, key) => void submitComment(nextFile, hunk, key)}
          />
        ))}
      </ul>
    </div>
  );
}
