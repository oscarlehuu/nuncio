import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { GitBranchSyncDto } from '../lib/api';
import { pullSession, pushSession } from '../lib/api';
import { fetchForgeRuns } from '../lib/forge-api';
import { runStatusIcon } from './forge/run-list';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

interface SessionScmBranchStripProps {
  sessionId: string;
  sync: GitBranchSyncDto;
  repoPath?: string;
  branch?: string | null;
  onChanged: () => void;
  refreshing?: boolean;
}

export function SessionScmBranchStrip({
  sessionId,
  sync,
  repoPath,
  branch,
  onChanged,
  refreshing = false,
}: SessionScmBranchStripProps) {
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);
  const [ciLabel, setCiLabel] = useState<string | null>(null);
  const [ciIcon, setCiIcon] = useState<ReactNode>(null);

  useEffect(() => {
    if (!repoPath) {
      setCiLabel(null);
      setCiIcon(null);
      return;
    }
    let cancelled = false;
    void fetchForgeRuns(repoPath, branch ?? undefined)
      .then((runs) => {
        if (cancelled) return;
        const latest = runs[0];
        if (!latest) {
          setCiLabel(null);
          setCiIcon(null);
          return;
        }
        setCiIcon(runStatusIcon(latest));
        const conclusion = latest.conclusion ?? latest.status;
        setCiLabel(conclusion);
      })
      .catch(() => {
        if (!cancelled) {
          setCiLabel(null);
          setCiIcon(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, branch]);

  const runPush = async () => {
    if (sync.ahead === 0 || busy) return;
    try {
      setBusy('push');
      const result = await pushSession(sessionId);
      toast.success(result.pushed ? `Pushed to ${result.remoteBranch}` : 'Nothing to push');
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setBusy(null);
    }
  };

  const runPull = async () => {
    if (sync.behind === 0 || busy) return;
    try {
      setBusy('pull');
      const result = await pullSession(sessionId);
      toast.success(
        result.pulled
          ? result.fastForward
            ? 'Fast-forwarded'
            : 'Pulled remote changes'
          : 'Already up to date',
      );
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-border/50 px-3 py-2">
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate font-mono text-sm font-medium" title={sync.branch}>
        {sync.branch}
      </span>
      {sync.ahead > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-xs text-success" title="Ahead">
          <ArrowUp className="size-3" />
          {sync.ahead}
        </span>
      )}
      {sync.behind > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-xs text-info" title="Behind">
          <ArrowDown className="size-3" />
          {sync.behind}
        </span>
      )}
      {ciIcon && ciLabel && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground"
          title={`CI: ${ciLabel}`}
        >
          {ciIcon}
          <span className="max-w-16 truncate">{ciLabel}</span>
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={sync.ahead === 0 || busy != null}
          onClick={() => void runPush()}
        >
          {busy === 'push' ? '…' : 'Push'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={sync.behind === 0 || busy != null}
          onClick={() => void runPull()}
        >
          {busy === 'pull' ? '…' : 'Pull'}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Refresh changes"
          disabled={refreshing || busy != null}
          onClick={() => onChanged()}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </Button>
      </div>
    </div>
  );
}
