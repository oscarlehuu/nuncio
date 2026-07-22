import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2 } from 'lucide-react';
import { replyForgeThread, resolveForgeThread, type ForgeReviewThread } from '../../lib/forge-api';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ForgeCommentCard } from './forge-ui';

interface PrThreadProps {
  path: string;
  number: number;
  thread: ForgeReviewThread;
  canResolve: boolean;
  onChanged: () => void;
}

export function PrThread({ path, number, thread, canResolve, onChanged }: PrThreadProps) {
  const [collapsed, setCollapsed] = useState(thread.resolved === true);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);

  const handleReply = async () => {
    if (!reply.trim() || sending || !thread.replyTargetId) return;
    try {
      setSending(true);
      await replyForgeThread(path, number, thread.replyTargetId, reply.trim());
      setReply('');
      toast.success('Reply posted');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reply');
    } finally {
      setSending(false);
    }
  };

  const handleResolve = async () => {
    if (resolving) return;
    const next = thread.resolved !== true;
    try {
      setResolving(true);
      await resolveForgeThread(path, number, thread.id, next);
      toast.success(next ? 'Thread resolved' : 'Thread reopened');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update thread');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-muted/40"
      >
        {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-mono">
          {thread.path ? `${thread.path}${thread.line != null ? `:${thread.line}` : ''}` : 'Conversation thread'}
        </span>
        {thread.outdated && <span className="shrink-0 text-ui-xs uppercase text-muted-foreground">outdated</span>}
        {thread.resolved === true && (
          <span className="flex shrink-0 items-center gap-1 text-ui-xs uppercase text-success">
            <CheckCircle2 className="size-3" /> resolved
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-2 border-t border-border/40 p-2.5">
          {thread.comments.map((comment) => (
            <ForgeCommentCard key={comment.id} comment={comment} />
          ))}

          {thread.replyTargetId && (
            <div className="flex flex-col gap-1.5">
              <Textarea
                placeholder="Reply…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                disabled={sending}
                className="resize-none text-sm"
              />
              <div className="flex items-center justify-end gap-2">
                {canResolve && thread.resolvable && (
                  <Button variant="outline" size="sm" onClick={handleResolve} disabled={resolving}>
                    {resolving && <Loader2 className="size-3.5 animate-spin" />}
                    {thread.resolved === true ? 'Reopen' : 'Resolve'}
                  </Button>
                )}
                <Button size="sm" onClick={handleReply} disabled={!reply.trim() || sending}>
                  {sending && <Loader2 className="size-3.5 animate-spin" />}
                  Reply
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
