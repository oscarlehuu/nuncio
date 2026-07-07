import { useState } from 'react';
import { CircleDot, GitBranch, Loader2 } from 'lucide-react';
import type { TaskDto } from '../lib/api';
import { Button } from '@/components/ui/button';

const STATUS_LABEL: Record<TaskDto['status'], string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  DONE: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const STATUS_DOT: Record<TaskDto['status'], string> = {
  QUEUED: 'bg-muted-foreground/60',
  RUNNING: 'bg-info animate-pulse',
  DONE: 'bg-success',
  FAILED: 'bg-destructive',
  CANCELLED: 'bg-muted-foreground/40',
};

interface SubagentsPanelProps {
  tasks: TaskDto[];
  onReview: (id: string) => void | Promise<void>;
}

/** Compact, dense list of child subagents spawned from this session's
 *  multitasking. Quiet by design — no cards, one row per task. */
export function SubagentsPanel({ tasks, onReview }: SubagentsPanelProps) {
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  if (tasks.length === 0) return null;

  const handleReview = async (id: string) => {
    setReviewingId(id);
    try {
      await onReview(id);
    } finally {
      setReviewingId(null);
    }
  };

  return (
    <section
      data-testid="subagents-panel"
      className="max-w-[760px] mx-auto mb-2 rounded-lg border border-border/70 bg-card/60 surface-lit"
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 text-ui-sm text-muted-foreground">
        <GitBranch className="size-3" />
        <span className="font-medium">Subagents</span>
        <span className="text-muted-foreground/70">{tasks.length}</span>
      </div>
      <ul className="divide-y divide-border/30">
        {tasks.map((task) => {
          const model = task.model && task.model !== 'Composer' ? task.model : null;
          const providerModel = [task.provider, model].filter(Boolean).join(' · ');
          const awaitingReview = task.reviewState === 'awaiting_review';
          return (
            <li
              key={task.id}
              data-testid="subagent-row"
              className="flex items-center gap-2.5 px-3 py-1.5 text-body min-w-0"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status]}`}
                aria-hidden
              />
              <span className="flex-1 min-w-0 truncate" title={task.prompt}>
                {task.prompt}
              </span>
              {providerModel && (
                <span className="hidden sm:inline shrink-0 text-ui-sm text-muted-foreground truncate max-w-[40%]">
                  {providerModel}
                </span>
              )}
              <span className="shrink-0 flex items-center gap-1 text-ui-sm text-muted-foreground">
                <span aria-label={`Status ${STATUS_LABEL[task.status]}`}>
                  {STATUS_LABEL[task.status]}
                </span>
              </span>
              {task.reviewState === 'reviewed' && (
                <span className="shrink-0 flex items-center gap-1 text-ui-sm text-success">
                  <CircleDot className="size-3" />
                  Reviewed
                </span>
              )}
              {awaitingReview && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 px-2 text-ui-sm"
                  disabled={reviewingId === task.id}
                  onClick={() => void handleReview(task.id)}
                  aria-label={`Review done for ${task.prompt}`}
                >
                  {reviewingId === task.id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    'Review done'
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
