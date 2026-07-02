import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, CircleDot, ExternalLink, Loader2, Play } from 'lucide-react';
import {
  addForgeIssueComment,
  fetchForgeIssue,
  setForgeIssueState,
} from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { issueSessionPrompt, saveComposerDraft } from '../../lib/composer-draft';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { MarkdownView } from '../markdown-view';
import { ForgeCommentCard, ForgeStateBadge } from './forge-ui';
import { cn } from '@/lib/utils';

interface IssueDetailProps {
  path: string;
  number: number;
  /** Repo path used when spawning a session from this issue (project root, not worktree). */
  projectPath?: string | null;
  onBack: () => void;
}

export function IssueDetail({ path, number, projectPath, onBack }: IssueDetailProps) {
  const navigate = useNavigate();
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [updatingState, setUpdatingState] = useState(false);

  const { data: issue, refresh } = useForgeQuery(
    `issue:${path}:${number}`,
    () => fetchForgeIssue(path, number),
    { pollMs: 30_000, onError: (err) => toast.error(err.message) },
  );

  const handleComment = async () => {
    if (!comment.trim() || sending) return;
    try {
      setSending(true);
      await addForgeIssueComment(path, number, comment.trim());
      setComment('');
      toast.success('Comment posted');
      void refresh().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to comment');
    } finally {
      setSending(false);
    }
  };

  const handleToggleState = async () => {
    if (!issue || updatingState) return;
    const next = issue.state === 'open' ? 'closed' : 'open';
    try {
      setUpdatingState(true);
      await setForgeIssueState(path, number, next);
      toast.success(next === 'closed' ? 'Issue closed' : 'Issue reopened');
      void refresh().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update issue');
    } finally {
      setUpdatingState(false);
    }
  };

  const handleStartSession = () => {
    if (!issue) return;
    saveComposerDraft({
      prompt: issueSessionPrompt(issue),
      projectPath: projectPath ?? undefined,
    });
    navigate('/');
  };

  if (!issue) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-3.5" />
        </Button>
        Loading issue…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back" className="shrink-0">
          <ArrowLeft className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CircleDot
              className={cn('size-3.5', issue.state === 'open' ? 'text-success' : 'text-muted-foreground')}
            />
            <ForgeStateBadge state={issue.state} />
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              #{issue.number}
              <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="mt-1 text-sm font-medium">{issue.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>by {issue.author}</span>
            {issue.labels.map((label) => (
              <span key={label} className="rounded-full border border-border px-1.5 text-[10px]">
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="gap-1.5" onClick={handleStartSession}>
          <Play className="size-3.5" />
          Start session
        </Button>
        <Button size="sm" variant="outline" onClick={handleToggleState} disabled={updatingState}>
          {updatingState && <Loader2 className="size-3.5 animate-spin" />}
          {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}
        </Button>
      </div>

      {issue.body.trim() && (
        <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
          <MarkdownView text={issue.body} className="text-sm" />
        </div>
      )}

      {issue.comments.length > 0 && (
        <div className="flex flex-col gap-2">
          {issue.comments.map((c) => (
            <ForgeCommentCard key={c.id} comment={c} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Textarea
          placeholder="Add a comment…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          disabled={sending}
          className="resize-none text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={handleComment} disabled={!comment.trim() || sending}>
            {sending && <Loader2 className="size-3.5 animate-spin" />}
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}
