import { AlertTriangle } from 'lucide-react';

interface SessionScmConflictsProps {
  conflicts: string[];
}

export function SessionScmConflicts({ conflicts }: SessionScmConflictsProps) {
  if (conflicts.length === 0) return null;

  return (
    <div className="border-b border-border/50 bg-warning/10 px-3 py-2">
      <div className="flex items-center gap-1.5 text-ui-sm font-semibold uppercase tracking-wide text-warning">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        <span>
          {conflicts.length} merge conflict{conflicts.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {conflicts.map((path) => (
          <li key={path} className="truncate font-mono text-xs text-foreground/90">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}
