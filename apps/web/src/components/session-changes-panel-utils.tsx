import type { DiffFile } from '../lib/api';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<DiffFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  renamed: 'Renamed',
  binary: 'Binary',
};

const STATUS_CLASSES: Record<DiffFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  removed: 'text-destructive',
  renamed: 'text-info',
  binary: 'text-muted-foreground',
};

export function FileSummary({ file }: { file: DiffFile }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate font-mono text-ui-lg">{file.path}</span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
        {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-destructive">-{file.deletions}</span>}
        <span className={cn('text-ui-xs font-semibold uppercase', STATUS_CLASSES[file.status])}>
          {STATUS_LABELS[file.status]}
        </span>
      </span>
    </>
  );
}
