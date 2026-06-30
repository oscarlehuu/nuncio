import { useCallback, useEffect, useState } from 'react';
import { openPullRequest, fetchPullRequest } from '../lib/api';
import type { Session, ForgePullRequest, ForgeCheck } from '../lib/api';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { GitPullRequest, ExternalLink, Loader2 } from 'lucide-react';

interface PrPanelProps {
  session: Session;
}

export function PrPanel({ session }: PrPanelProps) {
  const [pr, setPr] = useState<ForgePullRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const isIdle = session.status === 'IDLE';
  const hasBranch = !!session.branch;
  const canOpenPr = isIdle && hasBranch;

  const refreshPr = useCallback(async () => {
    try {
      setRefreshing(true);
      const prData = await fetchPullRequest(session.id);
      setPr(prData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to fetch pull request status');
    } finally {
      setRefreshing(false);
    }
  }, [session.id]);

  // Refresh an existing PR's state/checks when the session already carries one.
  useEffect(() => {
    if (session.pullRequestUrl) {
      void refreshPr();
    }
  }, [session.id, session.pullRequestUrl, refreshPr]);

  const handleOpenPr = async () => {
    if (!canOpenPr || loading) return;
    try {
      setLoading(true);
      const prData = await openPullRequest(session.id, {});
      setPr(prData);
      toast.success('Pull request opened successfully');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open pull request');
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (conclusion: string | null) => {
    switch (conclusion) {
      case 'success':
        return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800';
      case 'failure':
      case 'action_required':
      case 'timed_out':
        return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800';
      case 'cancelled':
      case 'skipped':
        return 'text-muted-foreground bg-muted border-border';
      default:
        return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800';
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 border rounded-lg bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Pull Request</span>
        </div>
        {pr && (
          <button
            type="button"
            onClick={refreshPr}
            disabled={refreshing}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      </div>

      {!pr ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {!hasBranch
              ? 'Cannot open a pull request without a branch.'
              : !isIdle
              ? 'Agent must be IDLE to open a pull request.'
              : 'Open a pull request on the remote repository for this session.'}
          </p>
          <Button
            onClick={handleOpenPr}
            disabled={!canOpenPr || loading}
            className="w-full flex items-center gap-2"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            Open Pull Request
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4 border-b pb-3">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-xs font-semibold text-muted-foreground uppercase">Pull Request</span>
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium hover:underline text-primary flex items-center gap-1.5 truncate"
              >
                pull/{pr.number}
                <ExternalLink className="size-3.5 shrink-0" />
              </a>
              {pr.title && <span className="text-xs text-muted-foreground">{pr.title}</span>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase">State</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-muted text-foreground">
                {pr.state}
              </span>
            </div>
          </div>

          {pr.checks && pr.checks.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Checks</span>
              <ul className="flex flex-col gap-1.5">
                {pr.checks.map((check: ForgeCheck) => (
                  <li
                    key={check.name}
                    className={`flex items-center justify-between gap-3 text-xs font-mono p-2 border rounded-md ${getStatusColor(
                      check.conclusion
                    )}`}
                  >
                    <span className="truncate font-semibold">{check.name}</span>
                    <span className="shrink-0 uppercase text-[10px]">
                      {check.conclusion || check.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
