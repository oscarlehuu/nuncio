import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MoreHorizontal, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteLoop,
  fetchLoop,
  fetchLoopRuns,
  fireLoop,
  pauseLoop,
  resumeLoop,
  updateLoop,
  type LoopDto,
  type LoopRunDto,
} from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import { loopDisplayName } from '@nuncio/core/loop-schedule';
import { LoopStatusChip } from './loop-status-chip';
import { LoopSettingsTab } from './loop-settings-tab';
import { LoopRunHistory } from './loop-run-history';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Tab = 'settings' | 'runs';

/** Why "Run now" is unavailable, or null when it can fire. */
function fireDisabledReason(status: LoopDto['status']): string | null {
  if (status === 'broken') return 'Resume the loop before running it';
  if (status === 'paused') return 'Resume the loop before running it';
  if (status === 'completed') return 'This loop has completed';
  return null;
}

interface LoopDetailViewProps {
  providers: ModelProvider[];
}

export function LoopDetailView({ providers }: LoopDetailViewProps) {
  const { loopId } = useParams();
  const navigate = useNavigate();
  const [loop, setLoop] = useState<LoopDto | null>(null);
  const [runs, setRuns] = useState<LoopRunDto[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('settings');
  const [missing, setMissing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // Draft state for the editable Settings fields.
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [engine, setEngine] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [maxRuns, setMaxRuns] = useState(24);
  const seeded = useRef<string | null>(null);

  const seedDraft = useCallback((l: LoopDto) => {
    if (seeded.current === l.id) return;
    seeded.current = l.id;
    setName(l.name ?? '');
    setGoal(l.goal);
    setEngine(l.engine ?? null);
    setModel(l.model ?? null);
    setMaxRuns(l.maxRunsPerDay);
  }, []);

  const load = useCallback(async () => {
    if (!loopId) return;
    try {
      const l = await fetchLoop(loopId);
      setLoop(l);
      seedDraft(l);
    } catch {
      setMissing(true);
      return;
    }
    try {
      setRuns(await fetchLoopRuns(loopId));
    } catch {
      /* keep prior runs */
    } finally {
      setRunsLoading(false);
    }
  }, [loopId, seedDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (missing) {
      toast.error('Loop not found');
      navigate('/autopilot', { replace: true });
    }
  }, [missing, navigate]);

  if (!loop) return <DetailSkeleton onBack={() => navigate('/autopilot')} />;

  const dirty =
    name.trim() !== (loop.name ?? '') ||
    goal.trim() !== loop.goal ||
    (engine ?? null) !== (loop.engine ?? null) ||
    (model ?? null) !== (loop.model ?? null) ||
    maxRuns !== loop.maxRunsPerDay;
  const fireReason = fireDisabledReason(loop.status);

  const run = async (action: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await action();
      if (okMsg) toast.success(okMsg);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () =>
    run(
      // Empty name clears the label (falls back to the goal for display).
      () =>
        updateLoop(loop.id, {
          name: name.trim() || null,
          goal: goal.trim(),
          engine,
          model,
          maxRunsPerDay: maxRuns,
        }),
      'Loop saved',
    );

  const handleToggleActive = (next: boolean) =>
    run(() => (next ? resumeLoop(loop.id) : pauseLoop(loop.id)));

  // A fire can be skipped server-side (409) without erroring — tell the truth
  // instead of a false "Run started".
  const handleFire = async () => {
    setBusy(true);
    try {
      const result = await fireLoop(loop.id);
      if (result.fired) {
        toast.success('Run started');
      } else if (result.reason === 'budget') {
        toast.info('Daily budget spent — resumes tomorrow');
      } else {
        toast.info('Previous run still in progress');
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run loop');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await deleteLoop(loop.id);
      toast.success('Loop deleted');
      navigate('/autopilot');
    } catch {
      toast.error('Failed to delete loop');
      setBusy(false);
    }
  };

  const isActive = loop.status === 'active';
  const canResume = loop.status === 'paused' || loop.status === 'broken';

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button variant="ghost" size="icon" onClick={() => navigate('/autopilot')} aria-label="Back to Autopilot">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
          {loopDisplayName(loop)}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy || fireReason !== null}
            title={fireReason ?? 'Run this loop now'}
            onClick={handleFire}
          >
            <Play className="size-3.5" />
            <span className="hidden sm:inline">Run now</span>
          </Button>
          <Button size="sm" disabled={!dirty || busy} onClick={handleSave}>
            Save
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" />
                Delete loop
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[720px]">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e0">
            <div className="flex items-center gap-2.5">
              <LoopStatusChip status={loop.status} />
              {loop.status === 'broken' && (
                <span className="text-ui-sm text-warning">Paused after repeated failures — resume to retry</span>
              )}
            </div>
            <label className="flex items-center gap-2 text-ui text-foreground">
              <span>{isActive ? 'Active' : 'Inactive'}</span>
              <Switch
                checked={isActive}
                disabled={busy || (!isActive && !canResume)}
                onCheckedChange={handleToggleActive}
                aria-label="Loop active"
              />
            </label>
          </div>

          <div role="tablist" aria-label="Loop detail" className="mb-4 inline-flex gap-1 rounded-lg bg-muted/40 p-1">
            <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              Settings
            </TabButton>
            <TabButton active={tab === 'runs'} onClick={() => setTab('runs')}>
              Run history
            </TabButton>
          </div>

          {tab === 'settings' ? (
            <LoopSettingsTab
              loop={loop}
              providers={providers}
              name={name}
              onNameChange={setName}
              goal={goal}
              onGoalChange={setGoal}
              engine={engine}
              model={model}
              onEngineModelChange={(nextEngine, nextModel) => {
                setEngine(nextEngine);
                setModel(nextModel);
              }}
              maxRunsPerDay={maxRuns}
              onMaxRunsChange={setMaxRuns}
            />
          ) : (
            <LoopRunHistory
              runs={runs}
              loading={runsLoading}
              onSelectRun={(runId) => navigate(`/autopilot/${loop.id}/runs/${runId}`)}
            />
          )}
        </div>
      </div>

      {confirmDelete && (
        <Dialog open onOpenChange={(open) => !open && setConfirmDelete(false)}>
          <DialogContent className="z-[60]">
            <DialogHeader>
              <DialogTitle>Delete loop</DialogTitle>
              <DialogDescription>
                Delete “{loopDisplayName(loop)}”? Its schedule stops firing. Past run history is kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void doDelete()}>
                Delete loop
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1 text-ui-lg transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-card font-medium text-foreground shadow-e0' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function DetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Autopilot">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="h-5 w-48 rounded bg-muted/60 animate-pulse" />
      </header>
      <div className="flex-1 px-4 py-6">
        <div className="mx-auto w-full max-w-[720px] space-y-4">
          <div className="h-14 rounded-xl border border-border bg-card animate-pulse" />
          <div className="h-40 rounded-xl border border-border bg-card animate-pulse" />
        </div>
      </div>
    </section>
  );
}
