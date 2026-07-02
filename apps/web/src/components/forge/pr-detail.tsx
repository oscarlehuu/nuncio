import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import {
  fetchForgeCapabilities,
  fetchForgePull,
  fetchForgeThreads,
  setForgePullState,
  type ForgeReviewThread,
} from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { Button } from '../ui/button';
import { ChecksList, ForgeStateBadge } from './forge-ui';
import { PrConversation } from './pr-conversation';
import { PrFiles } from './pr-files';
import { PrMergeBar } from './pr-merge-bar';
import { PrReviewBar } from './pr-review-bar';
import { cn } from '@/lib/utils';

interface PrDetailProps {
  path: string;
  number: number;
  onBack?: () => void;
}

type PrTab = 'conversation' | 'files' | 'checks';

const POLL_INTERVAL_MS = 30_000;

export function PrDetail({ path, number, onBack }: PrDetailProps) {
  const [tab, setTab] = useState<PrTab>('conversation');
  const [refreshing, setRefreshing] = useState(false);

  const { data: detail, refresh: refreshDetail } = useForgeQuery(
    `pull:${path}:${number}`,
    () => fetchForgePull(path, number),
    { pollMs: POLL_INTERVAL_MS, onError: (err) => toast.error(err.message) },
  );
  const { data: threads, refresh: refreshThreads } = useForgeQuery(
    `threads:${path}:${number}`,
    () => fetchForgeThreads(path, number).catch(() => [] as ForgeReviewThread[]),
    { pollMs: POLL_INTERVAL_MS },
  );
  const { data: capabilities } = useForgeQuery(
    `caps:${path}`,
    () => fetchForgeCapabilities(path),
    { staleMs: 5 * 60_000 },
  );

  const refresh = async () => {
    try {
      setRefreshing(true);
      await Promise.all([refreshDetail(), refreshThreads()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh pull request');
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleState = async () => {
    if (!detail) return;
    const next = detail.state === 'open' ? 'closed' : 'open';
    try {
      await setForgePullState(path, number, next);
      toast.success(next === 'closed' ? 'Pull request closed' : 'Pull request reopened');
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update pull request');
    }
  };

  if (!detail) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">Loading pull request…</div>;
  }

  const openThreadCount = (threads ?? []).filter((t) => t.resolved !== true).length;
  const tabs: Array<{ id: PrTab; label: string }> = [
    { id: 'conversation', label: openThreadCount > 0 ? `Conversation (${openThreadCount})` : 'Conversation' },
    { id: 'files', label: detail.changedFiles > 0 ? `Files (${detail.changedFiles})` : 'Files' },
    { id: 'checks', label: detail.checks.length > 0 ? `Checks (${detail.checks.length})` : 'Checks' },
  ];

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start gap-2">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back" className="shrink-0">
            <ArrowLeft className="size-3.5" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ForgeStateBadge state={detail.state} draft={detail.draft} />
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <span className="truncate">#{number}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
            {detail.reviewDecision && (
              <span
                className={cn(
                  'text-[10px] font-semibold uppercase',
                  detail.reviewDecision === 'approved' ? 'text-success' : 'text-warning',
                )}
              >
                {detail.reviewDecision.replace('_', ' ')}
              </span>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="Refresh pull request"
              className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </button>
          </div>
          <div className="mt-1 text-sm font-medium">{detail.title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">
              {detail.sourceBranch} → {detail.targetBranch}
            </span>
            <span>by {detail.author}</span>
            {(detail.additions > 0 || detail.deletions > 0) && (
              <span className="font-mono">
                <span className="text-success">+{detail.additions}</span>{' '}
                <span className="text-destructive">-{detail.deletions}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border/50">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'border-b-2 px-2 py-1.5 text-xs font-medium',
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'conversation' && (
        <PrConversation
          path={path}
          number={number}
          detail={detail}
          threads={threads}
          capabilities={capabilities}
          onChanged={() => void refresh()}
        />
      )}
      {tab === 'files' && <PrFiles path={path} number={number} threads={threads ?? []} />}
      {tab === 'checks' && <ChecksList checks={detail.checks} />}

      {detail.state === 'open' && (
        <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
          <PrReviewBar
            path={path}
            number={number}
            capabilities={capabilities}
            onSubmitted={() => void refresh()}
          />
          <PrMergeBar
            path={path}
            number={number}
            detail={detail}
            capabilities={capabilities}
            onMerged={() => void refresh()}
          />
        </div>
      )}

      {(detail.state === 'open' || detail.state === 'closed') && (
        <button
          type="button"
          onClick={handleToggleState}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {detail.state === 'open' ? 'Close pull request' : 'Reopen pull request'}
        </button>
      )}
    </div>
  );
}
