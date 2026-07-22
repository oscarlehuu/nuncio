import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { fetchForgePullFiles, type ForgeFileDiff, type ForgeReviewThread } from '../../lib/forge-api';
import { useForgeQuery } from '../../lib/forge-cache';
import { DiffView } from '../diff-view';
import { cn } from '@/lib/utils';

interface PrFilesProps {
  path: string;
  number: number;
  threads: ForgeReviewThread[];
}

const STATUS_CLASSES: Record<ForgeFileDiff['status'], string> = {
  added: 'text-success',
  removed: 'text-destructive',
  renamed: 'text-info',
  modified: 'text-warning',
};

export function PrFiles({ path, number, threads }: PrFilesProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { data: files } = useForgeQuery(
    `files:${path}:${number}`,
    () => fetchForgePullFiles(path, number),
    { staleMs: 60_000, onError: (err) => toast.error(err.message) },
  );

  if (files === null) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">Loading changed files…</div>;
  }
  if (files.length === 0) {
    return <div className="px-1 py-2 text-xs text-muted-foreground">No changed files.</div>;
  }

  const threadCountFor = (filePath: string) =>
    threads.filter((thread) => thread.path === filePath).length;

  const toggle = (filePath: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  return (
    <ul className="flex flex-col gap-1">
      {files.map((file) => {
        const isOpen = expanded.has(file.path);
        const threadCount = threadCountFor(file.path);
        return (
          <li key={file.path} className="rounded-md border border-border/50">
            <button
              type="button"
              onClick={() => toggle(file.path)}
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40"
            >
              {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate font-mono text-ui-lg">{file.path}</span>
              {threadCount > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-ui-sm text-info">
                  <MessageSquare className="size-3" />
                  {threadCount}
                </span>
              )}
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
                {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
                {file.deletions > 0 && <span className="text-destructive">-{file.deletions}</span>}
                <span className={cn('text-ui-xs font-semibold uppercase', STATUS_CLASSES[file.status])}>
                  {file.status[0]}
                </span>
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-border/40 p-2">
                {file.patch ? (
                  <DiffView diff={file.patch} className="max-h-96" />
                ) : (
                  <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                    Binary file or diff too large to display.
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
