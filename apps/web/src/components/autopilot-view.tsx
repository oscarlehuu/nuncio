import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteLoop,
  fetchAttention,
  fetchLoopRuns,
  fetchLoops,
  fetchLoopStats,
  pauseLoop,
  resumeLoop,
  type AttentionItemDto,
  type LoopDto,
  type LoopRunDto,
  type LoopStatsDto,
} from '../lib/api';
import {
  dispatcherDone,
  dispatcherPayload,
  markDispatcherProposalApproved,
  queuedTasksLabel,
  selectTonightDispatcherProposal,
} from '../lib/dispatcher-proposal';
import {
  approveDispatcherProposalOnce,
  useDispatcherProposalBusyIds,
} from '../lib/dispatcher-proposal-approval';
import { projectDisplayName } from '../lib/projects';
import type { ModelProvider } from '../lib/model-providers';
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
  /** The /api/models catalog — feeds the create dialog's engine + model picker. */
  providers: ModelProvider[];
}

/**
 * Autopilot — the loops fleet. Standing tasks nuncio runs on a schedule inside a
 * daily budget, self-fixing red verifies (rung 1) and landing each result as a PR.
 * The page keeps its existing poll cadence even when empty because tonight's plan
 * can arrive while the user is already here.
 */
export function AutopilotView({ onBack, providers }: AutopilotViewProps) {
  const navigate = useNavigate();
  const [loops, setLoops] = useState<LoopDto[]>([]);
  const [runsByLoop, setRunsByLoop] = useState<Record<string, LoopRunDto[]>>({});
  const [stats, setStats] = useState<LoopStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<CreateLoopPrefill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LoopDto | null>(null);
  const [tonightProposal, setTonightProposal] = useState<AttentionItemDto | null>(null);
  const [loopBusyId, setLoopBusyId] = useState<string | null>(null);
  const approvalBusyIds = useDispatcherProposalBusyIds();
  const loopErrorShown = useRef(false);
  const attentionErrorShown = useRef(false);
  const attentionRequestId = useRef(0);

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

  const refreshAttention = useCallback(async () => {
    const requestId = ++attentionRequestId.current;
    try {
      const { items } = await fetchAttention();
      if (requestId !== attentionRequestId.current) return;
      const selected = selectTonightDispatcherProposal(items);
      setTonightProposal((current) => {
        if (
          current &&
          selected?.id === current.id &&
          dispatcherDone(dispatcherPayload(current)) &&
          !dispatcherDone(dispatcherPayload(selected))
        ) {
          return current;
        }
        return selected;
      });
      attentionErrorShown.current = false;
    } catch {
      if (requestId !== attentionRequestId.current) return;
      if (!attentionErrorShown.current) {
        toast.error('Failed to load tonight’s plan');
        attentionErrorShown.current = true;
      }
    }
  }, []);

  const refreshLoops = useCallback(async () => {
    try {
      const list = await fetchLoops();
      setLoops(list);
      loopErrorShown.current = false;
      await Promise.all([
        loadRuns(list),
        fetchLoopStats()
          .then(setStats)
          .catch(() => {}),
      ]);
      return list;
    } catch {
      if (!loopErrorShown.current) {
        toast.error('Failed to load standing tasks');
        loopErrorShown.current = true;
      }
      return undefined;
    }
  }, [loadRuns]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshLoops(), refreshAttention()]);
    setLoading(false);
  }, [refreshAttention, refreshLoops]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A proposal can arrive while an empty Autopilot page is already open, so the
  // existing cadence stays active even before either feed has content.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const runAction = async (id: string, action: (id: string) => Promise<unknown>) => {
    setLoopBusyId(id);
    try {
      await action(id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setLoopBusyId(null);
    }
  };

  const handlePause = (id: string) => void runAction(id, pauseLoop);
  const handleResume = (id: string) => void runAction(id, resumeLoop);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    setLoopBusyId(id);
    try {
      await deleteLoop(id);
      toast.success('Standing task deleted');
      await refresh();
    } catch {
      toast.error('Failed to delete standing task');
    } finally {
      setLoopBusyId(null);
    }
  };

  const approveTonight = () => {
    if (!tonightProposal) return;
    const proposalId = tonightProposal.id;
    if (approvalBusyIds.has(proposalId)) return;
    void approveDispatcherProposalOnce(proposalId, async (outcome) => {
      if (outcome.ok) {
        setTonightProposal((current) =>
          current?.id === proposalId
            ? markDispatcherProposalApproved(current, outcome.result.taskIds)
            : current,
        );
        if (outcome.owner) {
          toast.success(queuedTasksLabel(outcome.result.taskIds.length));
        }
      } else if (outcome.owner) {
        toast.error(outcome.error instanceof Error ? outcome.error.message : 'Action failed');
      }
      await refreshAttention();
    });
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Autopilot</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" className="gap-1.5" onClick={() => openCreate(null)}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">New standing task</span>
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
                  <li key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
                ))}
              </ul>
            </>
          ) : (
            <>
              <LoopDashboardHeader stats={stats} onOpenRunHistory={() => navigate('/autopilot/runs')} />
              {tonightProposal && (
                <PlannedForTonight
                  item={tonightProposal}
                  busy={approvalBusyIds.has(tonightProposal.id)}
                  onApprove={approveTonight}
                />
              )}
              {loops.length === 0 ? (
                <>
                  <EmptyState onCreate={() => openCreate(null)} />
                  <LoopTemplates onPick={pickTemplate} />
                </>
              ) : (
                <>
                  <ul className="flex flex-col gap-3">
                    {loops.map((loop) => (
                      <LoopRow
                        key={loop.id}
                        loop={loop}
                        runs={runsByLoop[loop.id] ?? []}
                        busy={loopBusyId === loop.id}
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
            </>
          )}
        </div>
      </div>

      <CreateLoopDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void refresh()}
        prefill={prefill}
        providers={providers}
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
              <DialogTitle>Delete standing task</DialogTitle>
              <DialogDescription>
                Delete “{pendingDelete.goal}”? Its schedule stops firing. Past run history is kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Delete standing task
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
        <h2 className="text-ui-lg font-semibold text-foreground">No standing tasks yet</h2>
        <p className="text-ui text-muted-foreground leading-relaxed">
          A standing task is work nuncio runs on a schedule — nightly cleanup, issue triage,
          overnight refactors — inside a daily budget, landing each result as a pull request.
        </p>
      </div>
      <Button className="gap-1.5" onClick={onCreate}>
        <Plus className="size-4" />
        Create your first standing task
      </Button>
    </div>
  );
}

function PlannedForTonight({
  item,
  busy,
  onApprove,
}: {
  item: AttentionItemDto;
  busy: boolean;
  onApprove: () => void;
}) {
  const payload = dispatcherPayload(item);
  const done = dispatcherDone(payload);
  const queuedCount = payload.taskIds.length || payload.proposals.length;

  return (
    <section aria-labelledby="planned-for-tonight-heading" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="planned-for-tonight-heading" className="text-ui-lg font-semibold text-foreground">
          Planned for tonight
        </h2>
        {done ? (
          <span className="text-ui font-medium text-success">{queuedTasksLabel(queuedCount)}</span>
        ) : (
          <Button size="sm" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
        )}
      </div>
      <ul className="mt-3 space-y-2">
        {payload.proposals.map((proposal, index) => (
          <li
            key={`${proposal.title}:${proposal.projectPath ?? 'none'}:${index}`}
            className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
          >
            <p className="text-ui font-medium text-foreground">{proposal.title}</p>
            <p className="mt-0.5 text-ui-sm text-muted-foreground">
              {projectDisplayName(proposal.projectPath) ?? 'No project'}
            </p>
            <p className="mt-1 text-ui-sm text-muted-foreground">{proposal.rationale}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
