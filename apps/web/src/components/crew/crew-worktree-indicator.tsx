import { GitBranchPlus } from 'lucide-react';

/** Crew always owns one isolated run worktree; this is information, not a choice. */
export function CrewWorktreeIndicator() {
  return (
    <span
      role="status"
      aria-label="Crew worktree"
      className="inline-flex min-h-11 items-center gap-1.5 px-2 text-ui-lg text-muted-foreground"
    >
      <GitBranchPlus className="size-3.5" aria-hidden />
      Crew worktree
    </span>
  );
}
