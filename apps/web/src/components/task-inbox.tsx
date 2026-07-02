import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BranchPicker } from './branch-picker';
import { ModelPicker } from './model-picker';
import { ProjectPicker } from './project-picker';
import { VerifyChip } from './verify-chip';
import { WorkspaceModePicker, type WorkspaceMode } from './workspace-mode-picker';
import { bucketTasks, verifyStatusFromOutcome } from '../lib/task-lanes';
import { cancelTask, createTask, fetchTasks, retryTask, type Task } from '../lib/tasks-api';
import type { ModelOptionsMap } from '../lib/model-options';
import { modelById, normalizeModelCatalog, pickDefaultModelSelection, type ModelProvider } from '../lib/model-providers';
import { defaultOptionsForModel } from '../lib/model-picker-catalog';
import { loadModelPreference, resolveModelSelection } from '../lib/model-preference';
import { projectDisplayName } from '../lib/projects';
import { resolveWorkspacePreference } from '../lib/project-preference';

const REFRESH_MS = 5000;

const LANES = [
  { key: 'needsYou', label: 'Needs you' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done' },
] as const;

export function TaskInbox({ providers }: { providers?: ModelProvider[] }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
  const [projectPath, setProjectPath] = useState<string | undefined>(
    () => resolveWorkspacePreference().projectPath,
  );
  const [baseBranch, setBaseBranch] = useState<string | undefined>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('local');
  const [submitting, setSubmitting] = useState(false);

  const catalog = useMemo(() => normalizeModelCatalog(providers ?? []), [providers]);
  const catalogLoaded = Boolean(providers && providers.length > 0);

  const refresh = useCallback(async () => {
    try {
      setTasks(await fetchTasks());
    } catch {
      // Transient poll errors keep the last known list.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!catalogLoaded || !providers) return;
    const lookup = modelById(catalog);
    if (model && provider && lookup[model]) return;
    const resolved = resolveModelSelection(providers, loadModelPreference());
    if (resolved) {
      setModel(resolved.modelId);
      setProvider(resolved.providerId);
      setModelOptions(resolved.modelOptions);
      return;
    }
    const picked = pickDefaultModelSelection(providers);
    if (picked) {
      setModel(picked.modelId);
      setProvider(picked.providerId);
      setModelOptions(defaultOptionsForModel(lookup[picked.modelId]));
    }
  }, [catalogLoaded, providers, model, provider, catalog]);

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await createTask({
        prompt: text,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
        ...(projectPath ? { projectPath } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(workspaceMode === 'worktree' ? { useWorktree: true } : {}),
      });
      setPrompt('');
      toast.success('Task queued');
      await refresh();
    } catch {
      toast.error('Failed to queue task');
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
      await refresh();
    } catch {
      toast.error(failure);
    }
  };

  const lanes = useMemo(() => bucketTasks(tasks), [tasks]);

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 pt-16 md:p-6">
      <div className="w-full max-w-[960px] mx-auto">
        <h1 className="text-lg font-medium tracking-tight mb-3">Tasks</h1>

        <div className="flex flex-col rounded-xl border border-border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/50">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="Delegate a task — nuncio queues it, runs the agent, verifies, and pings you only when needed…"
            className="min-h-[72px] resize-none border-0 shadow-none bg-transparent text-[14px] px-4 pt-3 focus-visible:ring-0 focus-visible:border-0"
          />
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [&_button]:shrink-0">
              <ProjectPicker value={projectPath} onChange={setProjectPath} />
              <WorkspaceModePicker
                value={workspaceMode}
                onChange={setWorkspaceMode}
                disabled={!projectPath}
              />
              <BranchPicker projectPath={projectPath} value={baseBranch} onChange={setBaseBranch} />
              <ModelPicker
                value={model}
                modelOptions={modelOptions}
                onChange={(modelId, providerId, options) => {
                  setModel(modelId);
                  setProvider(providerId);
                  setModelOptions(options ?? {});
                }}
                providers={providers}
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!prompt.trim() || submitting}
              aria-label="Queue task"
            >
              Queue task
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map(({ key, label }) => (
            <div key={key} aria-label={`${label} lane`} className="min-w-0">
              <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground mb-2">
                {label} · {lanes[key].length}
              </h2>
              <div className="flex flex-col gap-2">
                {lanes[key].length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/70 italic">Empty</p>
                ) : (
                  lanes[key].map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onCancel={() => act(() => cancelTask(task.id), 'Failed to cancel task')}
                      onRetry={() => act(() => retryTask(task.id), 'Failed to retry task')}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TaskCard({
  task,
  onCancel,
  onRetry,
}: {
  task: Task;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const title = task.prompt.split('\n')[0] ?? task.prompt;
  const project = projectDisplayName(task.projectPath);
  const verify = verifyStatusFromOutcome(task.outcome);
  const terminal = task.status === 'DONE' || task.status === 'FAILED' || task.status === 'CANCELLED';
  const failureError = typeof task.outcome?.error === 'string' ? task.outcome.error : null;

  return (
    <div className="rounded-lg border border-border/70 bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight" title={task.prompt}>
            {title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {project ?? 'No project'}
            {task.useWorktree ? ' · worktree' : ''}
            {` · ${task.status.toLowerCase()}`}
          </p>
          {failureError ? (
            <p className="mt-1 line-clamp-2 text-[11px] text-destructive" title={failureError}>
              {failureError}
            </p>
          ) : null}
        </div>
        <VerifyChip status={verify} />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {task.sessionId ? (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
          >
            <Link to={`/session/${task.sessionId}`} aria-label={`Open session for ${title}`}>
              Open session
            </Link>
          </Button>
        ) : null}
        {task.status === 'QUEUED' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={onCancel}
            aria-label={`Cancel task ${title}`}
          >
            Cancel
          </Button>
        ) : null}
        {terminal ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={onRetry}
            aria-label={`Retry task ${title}`}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
