import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ListChecks, Plus, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteLoop,
  fetchLoopRuns,
  fetchLoops,
  fetchLoopStats,
  pauseLoop,
  resumeLoop,
  type LoopDto,
  type LoopRunDto,
  type LoopStatsDto,
} from '../lib/api';
import { LoopRow } from './loop-row';
import { LoopDashboardHeader } from './loop-dashboard-header';
import { LoopTemplates, type LoopTemplate } from './loop-templates';
import { Button } from '@/components/ui/button';
import { CreateLoopDialog, type CreateLoopPrefill } from './create-loop-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AutopilotViewProps {
  onBack: () => void;
}

/**
 * Autopilot — the loops fleet. Standing tasks nuncio runs on a schedule inside a
 * daily budget, self-fixing red verifies (rung 1) and landing each result as a PR.
 * Polls only while a loop is active or broken (a broken loop's streak can't move on
 * its own, but a paused/completed-only list is inert — no need to poll).
 */
export function AutopilotView({ onBack }: AutopilotViewProps) {
  const navigate = useNavigate();
  const [loops, setLoops] = useState<LoopDto[]>([]);
  const [runsByLoop, setRunsByLoop] = useState<Record<string, LoopRunDto[]>>({});
  const [stats, setStats] = useState<LoopStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<CreateLoopPrefill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LoopDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const errorShown = useRef(false);

  const openCreate = (seed: CreateLoopPrefill | null) => {
    setPrefill(seed);
    setCreateOpen(true);
  };

  const pickTemplate = (t: LoopTemplate) => {
    openCreate({ goal: t.goal, schedule: t.schedule, maxRunsPerDay: t.maxRunsPerDay, stop: t.stop });
  };

  const loadRuns = useCallback(async (list: LoopDto[]) => {
    const entries = await Promise.all(
      list.map(async (loop) => {
        try {
          return [loop.id, await fetchLoopRuns(loop.id)] as const;
        } catch {
          return [loop.id, []] as const;
        }
      }),
    );
    setRunsByLoop(Object.fromEntries(entries));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchLoops();
      setLoops(list);
      errorShown.current = false;
      // Stats + per-loop runs load in parallel; stats failure is non-fatal.
      await Promise.all([
        loadRuns(list),
        fetchLoopStats()
          .then(setStats)
          .catch(() => {}),
      ]);
      return list;
    } catch {
      if (!errorShown.current) {
        toast.error('Failed to load loops');
        errorShown.current = true;
      }
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [loadRuns]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the view is mounted and any loop exists. A tripped breaker leaves
  // NO loop 'active', so gating on active froze the list on stale breaker/pause
  // state (smoke finding) — as long as loops exist, keep them fresh.
  const hasLoops = loops.length > 0;
  useEffect(() => {
    if (!hasLoops) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [hasLoops, refresh]);

  const runAction = async (id: string, action: (id: string) => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action(id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const handlePause = (id: string) => void runAction(id, pauseLoop);
  const handleResume = (id: string) => void runAction(id, resumeLoop);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    setBusyId(id);
    try {
      await deleteLoop(id);
      toast.success('Loop deleted');
      await refresh();
    } catch {
      toast.error('Failed to delete loop');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Autopilot</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate('/autopilot/runs')}
            aria-label="View all run history"
          >
            <ListChecks className="size-4" />
            <span className="hidden sm:inline">Run history</span>
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => openCreate(null)}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">New loop</span>
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[720px] space-y-6">
          {loading ? (
            <>
              <div className="grid grid-cols-3 gap-3" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[72px] rounded-xl border border-border bg-card shadow-e0 animate-pulse" />
                ))}
              </div>
              <ul className="flex flex-col gap-3" aria-hidden>
                {[0, 1].map((i) => (
                  <li key={i} className="h-24 rounded-xl border border-border bg-card shadow-e1 animate-pulse" />
                ))}
              </ul>
            </>
          ) : loops.length === 0 ? (
            <>
              <EmptyState onCreate={() => openCreate(null)} />
              <LoopTemplates onPick={pickTemplate} />
            </>
          ) : (
            <>
              <LoopDashboardHeader stats={stats} />
              <ul className="flex flex-col gap-3">
                {loops.map((loop) => (
                  <LoopRow
                    key={loop.id}
                    loop={loop}
                    runs={runsByLoop[loop.id] ?? []}
                    busy={busyId === loop.id}
                    onOpen={() => navigate(`/autopilot/${loop.id}`)}
                    onPause={handlePause}
                    onResume={handleResume}
                    onDelete={setPendingDelete}
                  />
                ))}
              </ul>
              {loops.length < 3 && <LoopTemplates onPick={pickTemplate} />}
            </>
          )}
        </div>
      </div>

      <CreateLoopDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void refresh()}
        prefill={prefill}
      />

      {/*
        Confirm delete. Rendered only when open (never a mounted-but-closed peer of
        CreateLoopDialog) and pinned to z-[60] so the Content sits unambiguously above
        the overlay's isolate/backdrop-filter stacking context — the Electron webview
        painted an equal-z Content behind the blurred overlay, so the confirm was
        invisible and un-clickable.
      */}
      {pendingDelete !== null && (
        <Dialog open onOpenChange={(open) => !open && setPendingDelete(null)}>
          <DialogContent className="z-[60]">
            <DialogHeader>
              <DialogTitle>Delete loop</DialogTitle>
              <DialogDescription>
                Delete “{pendingDelete.goal}”? Its schedule stops firing. Past run history is kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Delete loop
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card/40 px-8 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted/60 text-muted-foreground shadow-e0">
        <Repeat className="size-5" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground">No loops yet</h2>
        <p className="text-ui text-muted-foreground leading-relaxed">
          A loop is a standing task nuncio runs on a schedule — nightly cleanup, issue triage,
          overnight refactors — inside a daily budget, landing each result as a pull request.
        </p>
      </div>
      <Button className="gap-1.5" onClick={onCreate}>
        <Plus className="size-4" />
        Create your first loop
      </Button>
    </div>
  );
}
