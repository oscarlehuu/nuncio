import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  commandCrewRun,
  createCrewSuccessorRun,
  fetchCrewRun,
  fetchCrewRunEvents,
  fetchCrewTask,
  type CrewRunDetailDto,
  type CrewRunDto,
  type CrewTaskDto,
} from '@nuncio/core/crew-api';
import { projectCrewRun } from '@nuncio/core/crew-run-projection';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CrewGates } from './crew-gates';
import { CrewMembersPanel } from './crew-members-panel';
import { CrewOutcomeEvidence } from './crew-outcome-evidence';
import { CrewRunProgress } from './crew-run-progress';
import { CrewRunHistory } from './crew-run-history';
import { CrewEvidencePanel } from './crew-evidence-panel';

interface CrewTaskDetailProps {
  taskId: string;
  runId?: string;
  onBack?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

export function CrewTaskDetail({ taskId, runId, onBack, onOpenSession }: CrewTaskDetailProps) {
  const navigate = useNavigate();
  const [task, setTask] = useState<CrewTaskDto | null>(null);
  const [run, setRun] = useState<CrewRunDetailDto | null>(null);
  const [runHistory, setRunHistory] = useState<CrewRunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const taskResponse = await fetchCrewTask(taskId);
      const selected = runId ? taskResponse.runs.find((item) => item.id === runId) : taskResponse.runs.at(-1);
      if (!selected) throw new Error('Crew run not found');
      const detail = await fetchCrewRun(selected.id);
      const replay = await fetchCrewRunEvents(detail.id, detail.revision);
      if (generation !== loadGeneration.current) return;
      setTask(taskResponse.task);
      setRunHistory(taskResponse.runs);
      setRun(projectCrewRun(detail, replay.events).run);
      setError(null);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setError(cause instanceof Error ? cause.message : 'Failed to load Crew task');
    }
  }, [runId, taskId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  const activeRunId = run && run.status !== 'TERMINAL' ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [activeRunId, load]);

  const projection = useMemo(() => run ? projectCrewRun(run) : null, [run]);
  const summary = projection ? summaryWithMember(projection.summary, projection.run) : '';

  const runCommand = async (command: 'pause' | 'resume' | 'cancel') => {
    if (!projection || busy) return;
    setBusy(true);
    try {
      await commandCrewRun(projection.run.id, command, { expectedRevision: projection.run.revision });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Crew action failed');
    } finally {
      setBusy(false);
    }
  };

  const answerClarification = async () => {
    if (!projection || !message.trim() || busy) return;
    setBusy(true);
    try {
      await commandCrewRun(projection.run.id, 'clarification', { expectedRevision: projection.run.revision, message: message.trim() });
      setMessage('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Crew action failed');
    } finally {
      setBusy(false);
    }
  };

  const requestChange = async () => {
    if (!projection?.run.workspaceHead || !message.trim() || busy) return;
    setBusy(true);
    try {
      const { run: successor } = await createCrewSuccessorRun(taskId, { changeRequest: message.trim(), expectedBaseHead: projection.run.workspaceHead, priorRunId: projection.run.id, expectedRevision: projection.run.revision, profileId: projection.run.profileSnapshot.sourceProfileId ?? undefined });
      setMessage('');
      navigate(`/crew/${encodeURIComponent(taskId)}?run=${encodeURIComponent(successor.id)}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create successor');
    } finally {
      setBusy(false);
    }
  };

  if (error && !projection) return <State message={error} action={<Button onClick={() => void load()}>Retry</Button>} />;
  if (!task || !projection) return <State message="Loading Crew task…" />;

  return (
    <section className="flex-1 min-w-0 overflow-y-auto bg-background px-3 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[900px] min-w-0 flex-col gap-4">
        <header className="flex min-w-0 items-center gap-3">
          {onBack ? <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Back" onClick={onBack}><ArrowLeft /></Button> : null}
          <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold" title={task.objective}>{task.objective}</h1><p className="truncate text-ui-sm text-muted-foreground">Profile snapshot · {projection.run.profileSnapshot.sourceProfileId ?? 'Quality default'} · revision {projection.run.profileSnapshot.sourceProfileRevision ?? 0}</p></div>
        </header>
        <CrewRunHistory taskId={taskId} runs={runHistory} selectedRunId={projection.run.id} />
        <CrewRunProgress steps={projection.steps} />
        <p aria-live="polite" className="rounded-lg border bg-card px-3 py-2 text-ui font-medium">{summary}</p>
        {error ? <p role="alert" className="text-ui-sm text-destructive">{error}</p> : null}
        <CrewOutcomeEvidence run={projection.run} />
        <div className="grid min-w-0 gap-4 md:grid-cols-2"><CrewMembersPanel members={projection.run.members} onOpenSession={onOpenSession} /><CrewGates gates={projection.run.gates} currentHead={projection.run.workspaceHead} /></div>
        <CrewEvidencePanel run={projection.run} />
        <div aria-label="Crew run actions" className="flex flex-wrap gap-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {projection.actions.includes('clarification') || projection.actions.includes('successor') ? (
            <Textarea
              aria-label={projection.actions.includes('clarification') ? 'Clarification answer' : 'Requested change'}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={projection.actions.includes('clarification') ? 'Answer the crew’s question…' : 'Describe the change for a successor run…'}
              className="min-h-[88px] w-full"
            />
          ) : null}
          {projection.actions.includes('pause') ? <Action disabled={busy} onClick={() => void runCommand('pause')}>Pause</Action> : null}
          {projection.actions.includes('resume') ? <Action disabled={busy} onClick={() => void runCommand('resume')}>Resume</Action> : null}
          {projection.actions.includes('cancel') ? <Action disabled={busy} onClick={() => void runCommand('cancel')}>Cancel</Action> : null}
          {projection.actions.includes('extra-verify-round') ? <Action disabled={busy} onClick={() => void extraRound(projection.run, 'verify', load, setError)}>Run one more verify round</Action> : null}
          {projection.actions.includes('extra-review-round') ? <Action disabled={busy} onClick={() => void extraRound(projection.run, 'review', load, setError)}>Run one more review round</Action> : null}
          {projection.actions.includes('clarification') ? <Action disabled={busy || !message.trim()} onClick={() => void answerClarification()}>Send answer</Action> : null}
          {projection.actions.includes('successor') && projection.run.workspaceHead ? <Action disabled={busy || !message.trim()} onClick={() => void requestChange()}>Request a change</Action> : null}
        </div>
      </div>
    </section>
  );
}

function summaryWithMember(summary: string, run: CrewRunDetailDto): string {
  const role = run.phase === 'BUILD' ? 'builder' : run.phase === 'REVIEW' ? 'reviewer' : run.phase === 'VERIFY' ? 'tester' : 'foreman';
  const member = role === 'tester' ? 'Nuncio Tester' : run.members.find((item) => item.role === role)?.label || run.profileSnapshot.bindings[role].label || run.profileSnapshot.bindings[role].model;
  return summary.includes(' · round') ? summary.replace(' · round', ` · ${member} · round`) : `${summary} · ${member}`;
}
function Action({ children, ...props }: React.ComponentProps<typeof Button>) { return <Button className="min-h-11" {...props}>{children}</Button>; }
function State({ message, action }: { message: string; action?: React.ReactNode }) { return <section className="grid flex-1 place-items-center p-6 text-center"><div><p className="text-muted-foreground">{message}</p>{action}</div></section>; }
async function extraRound(run: CrewRunDetailDto, gate: 'verify' | 'review', reload: () => Promise<void>, setError: (value: string | null) => void) {
  try { await commandCrewRun(run.id, 'extra-round', { expectedRevision: run.revision, gate }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Crew action failed'); }
}
