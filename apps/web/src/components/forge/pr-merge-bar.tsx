import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { GitMerge, Loader2, RefreshCw } from 'lucide-react';
import {
  mergeForgePull,
  updateForgeBranch,
  type ForgeCapabilitiesDto,
  type ForgeMergeMethod,
  type ForgePullRequestDetail,
} from '../../lib/forge-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface PrMergeBarProps {
  path: string;
  number: number;
  detail: ForgePullRequestDetail;
  capabilities: ForgeCapabilitiesDto | null;
  onMerged: () => void;
}

function checksGreen(detail: ForgePullRequestDetail): boolean {
  if (detail.checks.length === 0) return true;
  return detail.checks.every(
    (check) => check.conclusion === 'success' || check.conclusion === 'skipped',
  );
}

export function PrMergeBar({ path, number, detail, capabilities, onMerged }: PrMergeBarProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [method, setMethod] = useState<ForgeMergeMethod>('squash');
  const [deleteBranch, setDeleteBranch] = useState(detail.sourceBranch.startsWith('nuncio/'));
  const [override, setOverride] = useState(false);
  const [commitTitle, setCommitTitle] = useState('');
  const [merging, setMerging] = useState(false);
  const [updating, setUpdating] = useState(false);

  const green = checksGreen(detail);
  const methods = useMemo<ForgeMergeMethod[]>(
    () => (capabilities?.rebaseMerge === false ? ['merge', 'squash'] : ['merge', 'squash', 'rebase']),
    [capabilities],
  );

  if (detail.state !== 'open' || detail.draft) return null;

  const handleMerge = async () => {
    if (merging || (!green && !override)) return;
    try {
      setMerging(true);
      const result = await mergeForgePull(path, number, {
        method,
        deleteSourceBranch: deleteBranch,
        commitTitle: commitTitle.trim() || undefined,
      });
      if (result.merged) toast.success('Pull request merged');
      else toast.info(result.message || 'Merge accepted');
      setConfirmOpen(false);
      onMerged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to merge');
    } finally {
      setMerging(false);
    }
  };

  const handleUpdateBranch = async () => {
    if (updating) return;
    try {
      setUpdating(true);
      await updateForgeBranch(path, number);
      toast.success('Branch update requested');
      onMerged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update branch');
    } finally {
      setUpdating(false);
    }
  };

  if (detail.mergeable === 'conflicts' || detail.mergeable === 'behind') {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
        <span className="text-xs">
          {detail.mergeable === 'conflicts'
            ? `Conflicts with ${detail.targetBranch} — resolve before merging.`
            : `Behind ${detail.targetBranch}.`}
        </span>
        {capabilities?.updateBranch !== false && detail.mergeable === 'behind' && (
          <Button size="sm" variant="outline" onClick={handleUpdateBranch} disabled={updating}>
            {updating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Update branch
          </Button>
        )}
      </div>
    );
  }

  if (detail.mergeable === 'blocked') {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Merging is blocked by the repository's rules
        {detail.reviewDecision === 'review_required' ? ' (review required)' : ''}
        {detail.reviewDecision === 'changes_requested' ? ' (changes requested)' : ''}.
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {green ? 'Checks are green.' : 'Checks are failing or pending.'}
        </span>
        <Button size="sm" className="gap-1.5" onClick={() => setConfirmOpen(true)}>
          <GitMerge className="size-3.5" />
          Merge…
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent preventOutsideDismiss>
          <DialogHeader>
            <DialogTitle>Merge pull request #{number}</DialogTitle>
            <DialogDescription>
              {detail.sourceBranch} → {detail.targetBranch}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {methods.map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={method === m ? 'default' : 'outline'}
                  onClick={() => setMethod(m)}
                >
                  {m}
                </Button>
              ))}
            </div>

            {method === 'squash' && (
              <Input
                placeholder={`Squash commit title (default: PR title)`}
                value={commitTitle}
                onChange={(e) => setCommitTitle(e.target.value)}
                className="text-sm"
              />
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
              />
              Delete source branch after merge
            </label>

            {!green && (
              <label className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-sm text-destructive">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                Merge despite failing or pending checks
              </label>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={merging}>
              Cancel
            </Button>
            <Button
              onClick={handleMerge}
              disabled={merging || (!green && !override)}
              aria-label="Confirm merge"
            >
              {merging && <Loader2 className="size-4 animate-spin" />}
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
