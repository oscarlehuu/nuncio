import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CircleDot, MessageSquare, Plus } from 'lucide-react';
import { fetchForgeIssues } from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { fetchForgeStatus } from '../../lib/forge-status-api';
import { forgeTimeAgo } from './forge-ui';
import { NewIssueDialog } from './new-issue-dialog';
import { cn } from '@/lib/utils';

interface IssueListProps {
  path: string;
  onOpen: (number: number) => void;
}

type IssueChip = 'open' | 'closed' | 'mine';

export function IssueList({ path, onOpen }: IssueListProps) {
  const [chip, setChip] = useState<IssueChip>('open');
  const [creating, setCreating] = useState(false);

  const state = chip === 'closed' ? 'closed' : 'open';
  const { data: issues, refresh } = useForgeQuery(
    `issues:${path}:${state}`,
    () => fetchForgeIssues(path, state),
    { pollMs: 30_000, onError: (err) => toast.error(err.message) },
  );
  const { data: forgeStatus } = useForgeQuery('forge-status', fetchForgeStatus, {
    staleMs: 5 * 60_000,
  });
  const login = forgeStatus?.find((forge) => forge.connected && forge.login)?.login ?? null;

  const visible = useMemo(() => {
    if (!issues) return [];
    if (chip !== 'mine' || !login) return issues;
    return issues.filter((issue) => issue.assignees.includes(login) || issue.author === login);
  }, [issues, chip, login]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        {(['open', 'closed', 'mine'] as const).map((value) => (
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
            {value === 'mine' ? 'mine' : value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" />
          New issue
        </button>
      </div>

      {issues === null ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Loading issues…</div>
      ) : visible.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No issues found.</div>
      ) : (
        <ul className="flex flex-col">
          {visible.map((issue) => (
            <li key={issue.number}>
              <button
                type="button"
                onClick={() => onOpen(issue.number)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/40"
              >
                <span className="flex items-center gap-2">
                  <CircleDot
                    className={cn(
                      'size-3.5 shrink-0',
                      issue.state === 'open' ? 'text-success' : 'text-muted-foreground',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{issue.title}</span>
                </span>
                <span className="flex items-center gap-2 pl-5.5 text-xs text-muted-foreground">
                  <span>#{issue.number}</span>
                  {issue.labels.slice(0, 3).map((label) => (
                    <span key={label} className="rounded-full border border-border px-1.5 text-[10px]">
                      {label}
                    </span>
                  ))}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {issue.commentCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="size-3" />
                        {issue.commentCount}
                      </span>
                    )}
                    {forgeTimeAgo(issue.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewIssueDialog
        path={path}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(number) => {
          void refresh().catch(() => {});
          onOpen(number);
        }}
      />
    </div>
  );
}
