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
import {
  buildScheduleSpec,
  failureStreak,
  loopDisplayName,
  parseSpecToFields,
  type ScheduleFormFields,
} from '@nuncio/core/loop-schedule';
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
  const [maxFailures, setMaxFailures] = useState(3);
  const [sched, setSched] = useState<ScheduleFormFields>(() => parseSpecToFields('cron', ''));
  // A trigger PATCH ships ONLY when the user touched the controls — a stored spec
  // the form can't round-trip (a legacy/heartbeat kind) must not start dirty or let
  // an unrelated save silently replace the trigger.
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const seeded = useRef<string | null>(null);

  const seedDraft = useCallback((l: LoopDto) => {
    if (seeded.current === l.id) return;
    seeded.current = l.id;
    setName(l.name ?? '');
    setGoal(l.goal);
    setEngine(l.engine ?? null);
    setModel(l.model ?? null);
    setMaxRuns(l.maxRunsPerDay);
    setMaxFailures(l.maxConsecutiveFailures);
    setSched(parseSpecToFields(l.schedule?.kind ?? 'cron', l.schedule?.spec ?? ''));
    setScheduleTouched(false);
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

  // Trigger draft, projected to the {kind, spec} the server stores, vs the original.
  // Only a user-touched trigger counts as changed — a stored spec the form can't
  // round-trip (legacy/heartbeat) otherwise reads "dirty" and an unrelated save
  // would replace it.
  const nextKind: 'cron' | 'event' = sched.mode === 'event' ? 'event' : 'cron';
  const nextSpec = buildScheduleSpec(sched.mode, sched);
  const scheduleChanged =
    scheduleTouched &&
    (nextSpec !== (loop.schedule?.spec ?? '') || nextKind !== (loop.schedule?.kind ?? 'cron'));
  const scheduleValid =
    !scheduleTouched ||
    ((sched.mode === 'interval' || sched.mode === 'event' || /^\d{1,2}:\d{2}$/.test(sched.time)) &&
      (sched.mode !== 'interval' || (Number.isInteger(sched.interval) && sched.interval > 0)));

  const dirty =
    name.trim() !== (loop.name ?? '') ||
    goal.trim() !== loop.goal ||
    (engine ?? null) !== (loop.engine ?? null) ||
    (model ?? null) !== (loop.model ?? null) ||
    maxRuns !== loop.maxRunsPerDay ||
    maxFailures !== loop.maxConsecutiveFailures ||
    scheduleChanged;
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

  // Build the PATCH from CHANGED fields only. A loop whose stored model is a
  // legacy id (no longer in the catalog) must stay renameable — re-sending the
  // unchanged model would 400 server-side. An engine change sends {engine}
  // without a model key: the server clears the stored model (engine change
  // resets model to the provider default).
  const buildPatch = () => {
    const patch: Parameters<typeof updateLoop>[1] = {};
    // Empty name clears the label (falls back to the goal for display).
    const trimmedName = name.trim() || null;
    if (trimmedName !== (loop.name ?? null)) patch.name = trimmedName;
    const trimmedGoal = goal.trim();
    if (trimmedGoal !== loop.goal) patch.goal = trimmedGoal;
    const engineChanged = (engine ?? null) !== (loop.engine ?? null);
    if (engineChanged) {
      patch.engine = engine;
      // Only send a model alongside an engine change when one was explicitly
      // picked; null rides the server-side clear instead.
      if (model !== null) patch.model = model;
    } else if ((model ?? null) !== (loop.model ?? null)) {
      patch.model = model; // includes explicit clear-to-null on the same engine
    }
    if (maxRuns !== loop.maxRunsPerDay) patch.maxRunsPerDay = maxRuns;
    if (maxFailures !== loop.maxConsecutiveFailures) patch.maxConsecutiveFailures = maxFailures;
    // Re-spec the owned trigger in place — the server keeps the schedule id, so run
    // history + streaks survive the change.
    if (scheduleChanged) patch.schedule = { kind: nextKind, spec: nextSpec };
    return patch;
  };

  const handleSave = () => run(() => updateLoop(loop.id, buildPatch()), 'Loop saved');

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

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
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
          <Button size="sm" disabled={!dirty || !scheduleValid || busy} onClick={handleSave}>
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
          {/*
            One fact, one representation. active/paused is expressed by the toggle
            ALONE (no redundant status chip). A chip renders only for the states the
            toggle can't carry: broken (amber + streak + a Resume affordance) and
            completed (terminal, nothing to toggle).
          */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-e0">
            {loop.status === 'broken' ? (
              <>
                <div className="flex min-w-0 items-center gap-2.5">
                  <LoopStatusChip status="broken" />
                  <span className="text-ui-sm text-warning">
                    {failureStreak(runs)} failed run{failureStreak(runs) === 1 ? '' : 's'} in a row — fix and resume
                  </span>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => handleToggleActive(true)}
                >
                  <Play className="size-3.5" />
                  Fix &amp; resume
                </Button>
              </>
            ) : loop.status === 'completed' ? (
              <div className="flex items-center gap-2.5">
                <LoopStatusChip status="completed" />
                <span className="text-ui-sm text-muted-foreground">
                  This loop met its stop condition and won't run again.
                </span>
              </div>
            ) : (
              <label className="flex items-center gap-2 text-ui text-foreground">
                <span>{isActive ? 'Active' : 'Paused'}</span>
                <Switch
                  checked={isActive}
                  disabled={busy}
                  onCheckedChange={handleToggleActive}
                  aria-label="Loop active"
                />
              </label>
            )}
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
              schedule={sched}
              onScheduleChange={(next) => {
                setSched(next);
                setScheduleTouched(true);
              }}
              maxConsecutiveFailures={maxFailures}
              onMaxFailuresChange={setMaxFailures}
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
