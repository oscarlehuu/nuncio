import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { GitPullRequest, MessageSquare } from 'lucide-react';
import { fetchForgePulls, type ForgeStateFilter } from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { ForgeStateBadge, forgeTimeAgo } from './forge-ui';
import { cn } from '@/lib/utils';

interface PrListProps {
  path: string;
  onOpen: (number: number) => void;
}

type PrChip = 'open' | 'merged' | 'closed';

/** Merged/closed both ride the server's `all` filter and split client-side. */
const CHIP_TO_FILTER: Record<PrChip, ForgeStateFilter> = {
  open: 'open',
  merged: 'all',
  closed: 'all',
};

export function PrList({ path, onOpen }: PrListProps) {
  const [chip, setChip] = useState<PrChip>('open');
  const filter = CHIP_TO_FILTER[chip];
  const { data: pulls } = useForgeQuery(
    `pulls:${path}:${filter}`,
    () => fetchForgePulls(path, filter),
    { pollMs: 30_000, onError: (err) => toast.error(err.message) },
  );

  const visible = useMemo(() => {
    if (!pulls) return [];
    if (chip === 'open') return pulls.filter((pr) => pr.state === 'open');
    return pulls.filter((pr) => pr.state === chip);
  }, [pulls, chip]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        {(['open', 'merged', 'closed'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setChip(value)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
              chip === value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      {pulls === null ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Loading pull requests…</div>
      ) : visible.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No {chip} pull requests.</div>
      ) : (
        <ul className="flex flex-col">
          {visible.map((pr) => (
            <li key={pr.number}>
              <button
                type="button"
                onClick={() => onOpen(pr.number)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/40"
              >
                <span className="flex items-center gap-2">
                  <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{pr.title}</span>
                  <ForgeStateBadge state={pr.state} draft={pr.draft} />
                </span>
                <span className="flex items-center gap-2 pl-5.5 text-xs text-muted-foreground">
                  <span>#{pr.number}</span>
                  <span className="min-w-0 truncate font-mono">{pr.sourceBranch}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {pr.commentCount != null && pr.commentCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="size-3" />
                        {pr.commentCount}
                      </span>
                    )}
                    {forgeTimeAgo(pr.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
