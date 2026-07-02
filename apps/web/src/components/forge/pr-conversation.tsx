import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  addForgePullComment,
  type ForgeCapabilitiesDto,
  type ForgePullRequestDetail,
  type ForgeReviewThread,
} from '../../lib/forge-api';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { MarkdownView } from '../markdown-view';
import { PrThread } from './pr-thread';

interface PrConversationProps {
  path: string;
  number: number;
  detail: ForgePullRequestDetail;
  threads: ForgeReviewThread[] | null;
  capabilities: ForgeCapabilitiesDto | null;
  onChanged: () => void;
}

export function PrConversation({
  path,
  number,
  detail,
  threads,
  capabilities,
  onChanged,
}: PrConversationProps) {
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  const handleComment = async () => {
    if (!comment.trim() || sending) return;
    try {
      setSending(true);
      await addForgePullComment(path, number, comment.trim());
      setComment('');
      toast.success('Comment posted');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to comment');
    } finally {
      setSending(false);
    }
  };

  const openThreads = (threads ?? []).filter((thread) => thread.resolved !== true);
  const resolvedThreads = (threads ?? []).filter((thread) => thread.resolved === true);

  return (
    <div className="flex flex-col gap-3">
      {detail.body.trim() && (
        <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
          <MarkdownView text={detail.body} className="text-sm" />
        </div>
      )}

      {threads === null ? (
        <div className="text-xs text-muted-foreground">Loading review threads…</div>
      ) : threads.length === 0 ? (
        <div className="text-xs text-muted-foreground">No review threads yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {[...openThreads, ...resolvedThreads].map((thread) => (
            <PrThread
              key={thread.id}
              path={path}
              number={number}
              thread={thread}
              canResolve={capabilities?.resolveThreads !== false}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Textarea
          placeholder="Add a comment to the conversation…"
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
