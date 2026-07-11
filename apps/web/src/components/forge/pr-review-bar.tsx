import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, MessageSquarePlus, XCircle } from 'lucide-react';
import {
  submitForgeReview,
  type ForgeCapabilitiesDto,
  type ForgeReviewEvent,
} from '../../lib/forge-api';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface PrReviewBarProps {
  path: string;
  number: number;
  capabilities: ForgeCapabilitiesDto | null;
  onSubmitted: () => void;
}

const EVENT_LABELS: Record<ForgeReviewEvent, { title: string; confirm: string }> = {
  approve: { title: 'Approve pull request', confirm: 'Approve' },
  request_changes: { title: 'Request changes', confirm: 'Request changes' },
  comment: { title: 'Comment review', confirm: 'Submit comment' },
};

export function PrReviewBar({ path, number, capabilities, onSubmitted }: PrReviewBarProps) {
  const [pendingEvent, setPendingEvent] = useState<ForgeReviewEvent | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const needsBody = pendingEvent === 'request_changes' || pendingEvent === 'comment';
  const canRequestChanges = capabilities?.requestChanges !== false;

  const handleSubmit = async () => {
    if (!pendingEvent || submitting) return;
    if (needsBody && !body.trim()) return;
    try {
      setSubmitting(true);
      await submitForgeReview(path, number, pendingEvent, body.trim() || undefined);
      toast.success('Review submitted');
      setPendingEvent(null);
      setBody('');
      onSubmitted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPendingEvent('approve')}>
        <Check className="size-3.5 text-success" />
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={!canRequestChanges}
        title={canRequestChanges ? undefined : `${capabilities?.provider ?? 'This forge'} does not support request-changes reviews`}
        onClick={() => setPendingEvent('request_changes')}
      >
        <XCircle className="size-3.5 text-destructive" />
        Request changes
      </Button>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPendingEvent('comment')}>
        <MessageSquarePlus className="size-3.5" />
        Comment
      </Button>

      <Dialog open={pendingEvent !== null} onOpenChange={(open) => !open && setPendingEvent(null)}>
        <DialogContent preventOutsideDismiss>
          <DialogHeader>
            <DialogTitle>{pendingEvent ? EVENT_LABELS[pendingEvent].title : ''}</DialogTitle>
            <DialogDescription>
              {pendingEvent === 'approve'
                ? 'Optionally add a note with your approval.'
                : 'Your review comment is posted to the pull request.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder={needsBody ? 'Review comment (required)' : 'Optional note…'}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            disabled={submitting}
            className="resize-none text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingEvent(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || (needsBody && !body.trim())}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {pendingEvent ? EVENT_LABELS[pendingEvent].confirm : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
