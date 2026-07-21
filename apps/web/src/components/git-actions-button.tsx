import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import type { SessionStatus } from '../lib/api';
import { commitSession, openPullRequest, pushSession } from '../lib/api';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Textarea } from './ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

type StackedAction = 'commit' | 'push' | 'commit_push' | 'create_pr' | 'commit_push_pr';

const ACTION_LABELS: Record<StackedAction, string> = {
  commit: 'Commit…',
  push: 'Push',
  commit_push: 'Commit & push',
  create_pr: 'Open PR',
  commit_push_pr: 'Commit, push & PR',
};

const needsMessage = (action: StackedAction) =>
  action === 'commit' || action === 'commit_push' || action === 'commit_push_pr';

interface GitActionsButtonProps {
  sessionId: string;
  sessionStatus: SessionStatus;
  branch?: string | null;
}

/**
 * Header split-menu for stacked git actions (commit → push → open PR),
 * client-orchestrated over the existing session git/forge endpoints with a
 * staged progress toast. PR stages additionally require an IDLE session
 * (mirrors the PR panel's eligibility).
 */
export function GitActionsButton({ sessionId, sessionStatus, branch }: GitActionsButtonProps) {
  const [pendingAction, setPendingAction] = useState<StackedAction | null>(null);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);

  const hasBranch = !!branch?.trim();
  const prEligible = sessionStatus === 'IDLE';

  const run = async (action: StackedAction, commitMessage?: string) => {
    if (running) return;
    setRunning(true);
    const toastId = toast.loading('Working…');
    try {
      if (needsMessage(action)) {
        toast.loading('Committing…', { id: toastId });
        const result = await commitSession(sessionId, commitMessage!.trim());
        toast.loading(`Committed ${result.sha ? result.sha.slice(0, 7) : ''} — pushing…`, {
          id: toastId,
        });
      }
      if (action === 'push' || action === 'commit_push' || action === 'commit_push_pr') {
        toast.loading('Pushing…', { id: toastId });
        await pushSession(sessionId);
      }
      if (action === 'create_pr' || action === 'commit_push_pr') {
        toast.loading('Opening pull request…', { id: toastId });
        const pr = await openPullRequest(sessionId);
        toast.success(pr.number ? `Pull request #${pr.number} opened` : 'Pull request opened', {
          id: toastId,
        });
      } else {
        toast.success('Done', { id: toastId });
      }
      setPendingAction(null);
      setMessage('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Git action failed', { id: toastId });
    } finally {
      setRunning(false);
    }
  };

  const start = (action: StackedAction) => {
    if (needsMessage(action)) {
      setMessage('');
      setPendingAction(action);
      return;
    }
    void run(action);
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Git actions" disabled={running}>
                <GitBranch />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Git actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => start('commit')} aria-label="Commit…">
            {ACTION_LABELS.commit}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => start('commit_push')}
            disabled={!hasBranch}
            aria-label="Commit & push"
          >
            {ACTION_LABELS.commit_push}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => start('push')} disabled={!hasBranch} aria-label="Push">
            {ACTION_LABELS.push}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => start('create_pr')}
            disabled={!hasBranch || !prEligible}
            aria-label="Open PR"
          >
            {ACTION_LABELS.create_pr}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => start('commit_push_pr')}
            disabled={!hasBranch || !prEligible}
            aria-label="Commit, push & PR"
          >
            {ACTION_LABELS.commit_push_pr}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !running) setPendingAction(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingAction ? ACTION_LABELS[pendingAction] : 'Commit'}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message"
            rows={3}
            autoFocus
            disabled={running}
          />
          <DialogFooter>
            <Button
              onClick={() => pendingAction && void run(pendingAction, message)}
              disabled={!message.trim() || running}
            >
              {pendingAction ? ACTION_LABELS[pendingAction].replace('…', '') : 'Commit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
