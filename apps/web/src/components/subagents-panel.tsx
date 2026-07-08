import { useEffect, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { TaskDto } from '../lib/api';
import type { ModelOptionsMap } from '../lib/model-options';
import type { ModelProvider } from '../lib/model-providers';
import { holdSecondsRemaining, isHeldTask } from '../lib/subagent-hold';
import { SubagentRow } from './subagent-row';

interface SubagentsPanelProps {
  tasks: TaskDto[];
  providers?: ModelProvider[];
  onReview: (id: string) => void | Promise<void>;
  onCancel: (id: string) => void | Promise<void>;
  onRetry: (id: string) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void;
  /** Launch the held task immediately, skipping the remaining grace window. */
  onStartNow: (id: string) => void | Promise<void>;
  /** Change a held task's provider·model; also re-arms the countdown server-side. */
  onChangeModel: (
    id: string,
    provider: string,
    model: string,
    modelOptions?: ModelOptionsMap,
  ) => void | Promise<void>;
  /** Re-arm the countdown when the picker opens, so it can't expire mid-selection. */
  onPickerOpen: (id: string) => void;
}

/** Compact, dense list of child subagents spawned from this session's
 *  multitasking. Quiet by design — no cards, one row per task. Held rows (a
 *  QUEUED task inside its launch grace window) show a live countdown, an
 *  editable model chip, and a Start-now action. */
export function SubagentsPanel({
  tasks,
  providers,
  onReview,
  onCancel,
  onRetry,
  onOpenSession,
  onStartNow,
  onChangeModel,
  onPickerOpen,
}: SubagentsPanelProps) {
  // One in-flight row action at a time — locks that row's buttons.
  const [busyId, setBusyId] = useState<string | null>(null);

  const hasHeld = tasks.some((task) => isHeldTask(task, Date.now()));
  // A shared 1s clock drives every held row's countdown text and progress bar.
  // It only runs while a held row exists (server truth still arrives via the
  // 4s poll owned by session-detail — this tick never refetches).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasHeld) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasHeld]);

  // Largest remaining seconds seen per task gives the progress bar a stable
  // denominator (the original window length isn't sent by the server), and a
  // re-arm that grows the remaining value updates the ceiling instead of
  // snapping the bar backwards.
  const maxRemainingRef = useRef<Map<string, number>>(new Map());
  const activeIds = new Set<string>();
  for (const task of tasks) {
    if (!isHeldTask(task, now)) continue;
    activeIds.add(task.id);
    const remaining = holdSecondsRemaining(task, now);
    const prev = maxRemainingRef.current.get(task.id) ?? 0;
    if (remaining > prev) maxRemainingRef.current.set(task.id, remaining);
  }
  // Drop bookkeeping for tasks that are no longer held so a retry starts fresh.
  for (const id of [...maxRemainingRef.current.keys()]) {
    if (!activeIds.has(id)) maxRemainingRef.current.delete(id);
  }

  if (tasks.length === 0) return null;

  const runRowAction =
    (action: (id: string) => void | Promise<void>) => async (id: string) => {
      setBusyId(id);
      try {
        await action(id);
      } finally {
        setBusyId(null);
      }
    };

  // A model change shares the same one-busy-per-row lock as Cancel/Retry/Start
  // now: while the update (and its re-arm) is in flight the row's other actions
  // are disabled, so "Start now" can't race the update and launch the task with
  // the stale model.
  const handleChangeModel = async (
    id: string,
    provider: string,
    model: string,
    modelOptions?: ModelOptionsMap,
  ) => {
    setBusyId(id);
    try {
      await onChangeModel(id, provider, model, modelOptions);
    } finally {
      setBusyId(null);
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
        {tasks.map((task) => (
          <SubagentRow
            key={task.id}
            task={task}
            now={now}
            maxRemaining={maxRemainingRef.current.get(task.id) ?? holdSecondsRemaining(task, now)}
            busy={busyId === task.id}
            providers={providers}
            onOpenSession={onOpenSession}
            onReview={runRowAction(onReview)}
            onCancel={runRowAction(onCancel)}
            onRetry={runRowAction(onRetry)}
            onStartNow={runRowAction(onStartNow)}
            onChangeModel={handleChangeModel}
            onPickerOpen={onPickerOpen}
          />
        ))}
      </ul>
    </section>
  );
}
