import { Archive } from 'lucide-react';
import type { GitStashEntryDto } from '../lib/api';

interface SessionScmStashProps {
  entries: GitStashEntryDto[];
}

export function SessionScmStash({ entries }: SessionScmStashProps) {
  if (entries.length === 0) return null;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1.5 px-3 py-2 text-ui-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Archive className="size-3.5 shrink-0" aria-hidden />
        <span>
          {entries.length} stash entr{entries.length === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <ul className="flex flex-col pb-1">
        {entries.map((entry) => (
          <li
            key={entry.index}
            title={`${entry.sha}\n${entry.message}`}
            className="flex items-baseline gap-2 px-3 py-1.5 font-mono text-xs"
          >
            <span className="shrink-0 text-muted-foreground">stash@{'{'}{entry.index}{'}'}</span>
            <span className="min-w-0 truncate text-foreground">{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
