import { useEffect, useState } from 'react';
import type { GitHistoryDto } from '../lib/api';
import { fetchBranches, type Branch } from '../lib/projects';
import { ChevronDown, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface SessionScmHistoryProps {
  history: GitHistoryDto | null;
  repoPath?: string;
  selectedBranch?: string;
  onBranchChange?: (branch: string) => void;
}

function graphGlyph(parentCount: number): string {
  if (parentCount > 1) return '◎';
  return '●';
}

export function SessionScmHistory({
  history,
  repoPath,
  selectedBranch,
  onBranchChange,
}: SessionScmHistoryProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!repoPath || !onBranchChange) return;
    let cancelled = false;
    setLoading(true);
    void fetchBranches(repoPath, '', { refresh: false })
      .then((items) => {
        if (!cancelled) setBranches(items);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, onBranchChange]);

  const branchLabel = selectedBranch ?? history?.branch ?? 'HEAD';
  const commits = history?.commits ?? [];
  const canPick = Boolean(repoPath && onBranchChange);

  // Without a picker, keep the old hide-when-empty behavior.
  if (!canPick && (!history || commits.length === 0)) return null;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1.5 px-3 py-2 text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" aria-hidden />
        <span>Recent history</span>
        {canPick ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 max-w-[55%] gap-1 px-1.5 font-mono text-xs font-normal normal-case tracking-normal text-foreground"
                aria-label="History branch"
              >
                <span className="truncate">{branchLabel}</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[260px] p-0" align="end">
              <Command>
                <CommandInput placeholder="Search branches…" />
                <CommandList>
                  {loading && branches.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      Loading branches…
                    </div>
                  ) : (
                    <>
                      <CommandEmpty>No branch found.</CommandEmpty>
                      <CommandGroup heading="Branches">
                        {branches.map((branch) => (
                          <CommandItem
                            key={branch.name}
                            value={branch.name}
                            role="option"
                            onSelect={() => {
                              onBranchChange?.(branch.name);
                              setOpen(false);
                            }}
                            data-checked={branch.name === branchLabel ? 'true' : undefined}
                          >
                            <span className="truncate">{branch.name}</span>
                            {branch.isCurrent && (
                              <span className="ml-auto text-ui-xs text-muted-foreground">
                                current
                              </span>
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="ml-auto truncate font-mono text-xs font-normal normal-case tracking-normal">
            {branchLabel}
          </span>
        )}
      </div>
      {commits.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-muted-foreground">No commits on this branch.</div>
      ) : (
        <ul className="flex flex-col pb-2">
          {commits.map((commit, index) => {
            const isLast = index === commits.length - 1;
            const isMerge = commit.parents.length > 1;
            return (
              <li key={commit.sha} className="flex gap-2 px-3 py-0.5 font-mono text-xs">
                <div className="flex w-4 shrink-0 flex-col items-center">
                  <span
                    className={cn(
                      'leading-none',
                      isMerge ? 'text-info' : 'text-muted-foreground',
                    )}
                    aria-hidden
                  >
                    {graphGlyph(commit.parents.length)}
                  </span>
                  {!isLast && (
                    <span className="text-muted-foreground/50" aria-hidden>
                      │
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-muted-foreground">{commit.shortSha}</span>
                    <span className="min-w-0 truncate text-foreground" title={commit.subject}>
                      {commit.subject}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
