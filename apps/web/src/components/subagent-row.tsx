import { ArrowUpRight, CircleDot, Clock, Loader2, Play } from 'lucide-react';
import type { TaskDto } from '../lib/api';
import type { ModelOptionsMap } from '../lib/model-options';
import type { ModelProvider } from '../lib/model-providers';
import { holdProgress, holdSecondsRemaining, isHeldTask } from '../lib/subagent-hold';
import { ModelPicker } from './model-picker';
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

const TERMINAL = new Set<TaskDto['status']>(['DONE', 'FAILED', 'CANCELLED']);

const ACTION_BUTTON = 'h-6 shrink-0 px-2 text-ui-sm';

interface SubagentRowProps {
  task: TaskDto;
  /** Shared 1s tick — drives the countdown text/bar. */
  now: number;
  /** Largest remaining seconds observed for this task, for a stable progress denominator. */
  maxRemaining: number;
  busy: boolean;
  providers?: ModelProvider[];
  onOpenSession?: (sessionId: string) => void;
  onReview: (id: string) => void | Promise<void>;
  onCancel: (id: string) => void | Promise<void>;
  onRetry: (id: string) => void | Promise<void>;
  onStartNow: (id: string) => void | Promise<void>;
  onChangeModel: (
    id: string,
    provider: string,
    model: string,
    modelOptions?: ModelOptionsMap,
  ) => void | Promise<void>;
  onPickerOpen: (id: string) => void;
}

export function SubagentRow({
  task,
  now,
  maxRemaining,
  busy,
  providers,
  onOpenSession,
  onReview,
  onCancel,
  onRetry,
  onStartNow,
  onChangeModel,
  onPickerOpen,
}: SubagentRowProps) {
  const model = task.model && task.model !== 'Composer' ? task.model : null;
  const providerModel = [task.provider, model].filter(Boolean).join(' · ');
  const awaitingReview = task.reviewState === 'awaiting_review';
  const needsInput = task.status === 'RUNNING' && task.pendingInput;
  const canOpen = Boolean(task.sessionId) && Boolean(onOpenSession);
  const held = isHeldTask(task, now);
  const remaining = held ? holdSecondsRemaining(task, now) : 0;
  // Window elapsed but not yet flipped to RUNNING by the poll — brief "starting" gap.
  const starting = task.status === 'QUEUED' && task.holdUntil != null && remaining <= 0;

  return (
    <li
      data-testid="subagent-row"
      data-held={held || undefined}
      className={`relative flex items-center gap-2.5 px-3 py-1.5 text-body min-w-0 ${
        held ? 'bg-primary/5' : ''
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status]}`}
        aria-hidden
      />
      {canOpen ? (
        <button
          type="button"
          onClick={() => onOpenSession?.(task.sessionId!)}
          title={task.prompt}
          aria-label={`Open subagent session for ${task.prompt}`}
          className="group flex-1 min-w-0 flex items-center gap-1 text-left rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground active:scale-[0.99] transition"
        >
          <span className="truncate">{task.prompt}</span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" />
        </button>
      ) : (
        <span className="flex-1 min-w-0 truncate" title={task.prompt}>
          {task.prompt}
        </span>
      )}

      {held ? (
        <ModelPicker
          value={task.model ?? ''}
          modelOptions={task.modelOptions ?? undefined}
          providers={providers}
          variant="boxed"
          disabled={busy}
          onChange={(modelId, providerId, modelOptions) =>
            void onChangeModel(task.id, providerId, modelId, modelOptions)
          }
          onOpen={() => onPickerOpen(task.id)}
        />
      ) : (
        providerModel && (
          <span className="hidden sm:inline shrink-0 text-ui-sm text-muted-foreground truncate max-w-[40%]">
            {providerModel}
          </span>
        )
      )}

      {held ? (
        <span
          data-testid="subagent-countdown"
          className="shrink-0 flex items-center gap-1 text-ui-sm font-medium text-primary tabular-nums"
          aria-label={`Starts in ${remaining} seconds`}
          aria-live="polite"
        >
          <Clock className="size-3" aria-hidden />
          starts in {remaining}s
        </span>
      ) : starting ? (
        <span className="shrink-0 flex items-center gap-1 text-ui-sm text-primary">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Starting…
        </span>
      ) : needsInput ? (
        <span
          className="shrink-0 flex items-center gap-1 rounded-full border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-ui-sm font-medium text-warning"
          aria-label="Needs input"
        >
          <span className="size-1.5 rounded-full bg-warning animate-pulse" aria-hidden />
          Needs input
        </span>
      ) : (
        <span className="shrink-0 flex items-center gap-1 text-ui-sm text-muted-foreground">
          <span aria-label={`Status ${STATUS_LABEL[task.status]}`}>
            {STATUS_LABEL[task.status]}
          </span>
        </span>
      )}

      {task.reviewState === 'reviewed' && (
        <span className="shrink-0 flex items-center gap-1 text-ui-sm text-success">
          <CircleDot className="size-3" />
          Reviewed
        </span>
      )}

      {held && (
        <Button
          size="sm"
          variant="outline"
          className={`${ACTION_BUTTON} gap-1`}
          disabled={busy}
          onClick={() => void onStartNow(task.id)}
          aria-label={`Start ${task.prompt} now`}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Start now
        </Button>
      )}

      {task.status === 'QUEUED' && (
        <Button
          size="sm"
          variant="outline"
          className={ACTION_BUTTON}
          disabled={busy}
          onClick={() => void onCancel(task.id)}
          aria-label={`Cancel ${task.prompt}`}
        >
          {busy && !held ? <Loader2 className="size-3 animate-spin" /> : 'Cancel'}
        </Button>
      )}

      {TERMINAL.has(task.status) && (
        <Button
          size="sm"
          variant="outline"
          className={ACTION_BUTTON}
          disabled={busy}
          onClick={() => void onRetry(task.id)}
          aria-label={`Retry ${task.prompt}`}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : 'Retry'}
        </Button>
      )}

      {awaitingReview && (
        <Button
          size="sm"
          variant="outline"
          className={ACTION_BUTTON}
          disabled={busy}
          onClick={() => void onReview(task.id)}
          aria-label={`Review done for ${task.prompt}`}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : 'Review done'}
        </Button>
      )}

      {held && (
        <span
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-primary/60"
          style={{ width: `${holdProgress(remaining, maxRemaining) * 100}%` }}
          aria-hidden
        />
      )}
    </li>
  );
}
