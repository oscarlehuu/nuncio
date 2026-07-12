import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  commandCrewRun,
  createCrewSuccessorRun,
  fetchCrewRun,
  fetchCrewTask,
  type CrewRunCommand,
  type CrewRunDetailDto,
  type CrewRunDto,
  type CrewTaskDto,
} from '@nuncio/core/crew-api';
import { CrewGateCard } from '../../components/crew-gate-card';
import { CrewOutcomeEvidence } from '../../components/crew-outcome-evidence';
import { CrewArtifactEvidence } from '../../components/crew-artifact-evidence';
import { CrewRunActionPanel } from '../../components/crew-run-action-panel';
import { CrewRunHistory } from '../../components/crew-run-history';
import { CrewRunProgress } from '../../components/crew-run-progress';
import { crewTaskPath } from '../../lib/crew-navigation';
import { selectCrewRun } from '../../lib/crew-run-history';
import { buildCrewCommandInput, buildCrewSuccessorInput } from '../../lib/crew-run-actions';
import { buildCrewRunViewModel } from '../../lib/crew-run-view-model';

export default function CrewTaskScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ taskId?: string; run?: string }>();
  const taskId = typeof params.taskId === 'string' ? params.taskId : null;
  const requestedRunId = typeof params.run === 'string' ? params.run : null;
  const [task, setTask] = useState<CrewTaskDto | null>(null);
  const [run, setRun] = useState<CrewRunDetailDto | null>(null);
  const [runHistory, setRunHistory] = useState<CrewRunDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!taskId) return;
    const generation = ++loadGeneration.current;
    try {
      const aggregate = await fetchCrewTask(taskId);
      const selected = selectCrewRun(aggregate.runs, requestedRunId);
      if (!selected) throw new Error('No Crew run');
      const detail = await fetchCrewRun(selected.id);
      if (generation !== loadGeneration.current) return;
      setTask(aggregate.task);
      setRunHistory(aggregate.runs);
      setRun(detail);
      setError(null);
    } catch {
      if (generation !== loadGeneration.current) return;
      setError('Could not load this Crew task.');
    }
  }, [requestedRunId, taskId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => {
    if (!run || run.status === 'TERMINAL') return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load, run]);

  const view = useMemo(() => (run ? buildCrewRunViewModel(run) : null), [run]);

  const act = useCallback(async (command: CrewRunCommand, value?: string): Promise<boolean> => {
    if (!run || actionLock.current) return false;
    const input = buildCrewCommandInput(run, command, value);
    if (!input) return false;
    actionLock.current = true;
    loadGeneration.current += 1;
    setBusy(true);
    try {
      const next = await commandCrewRun(run.id, command, input);
      setRun((current) => current ? { ...current, ...next } : current);
      setRunHistory((current) => current.map((item) => item.id === next.id ? { ...item, ...next } : item));
      setError(null);
      return true;
    } catch {
      setError('The run changed or the action failed. Refresh and try again.');
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }, [run]);

  const createSuccessor = useCallback(async (changeRequest: string): Promise<boolean> => {
    if (!run || !taskId || actionLock.current) return false;
    const input = buildCrewSuccessorInput(run, changeRequest);
    if (!input) return false;
    actionLock.current = true;
    loadGeneration.current += 1;
    setBusy(true);
    try {
      const created = await createCrewSuccessorRun(taskId, input);
      setTask(created.task);
      setRunHistory((current) => [...current, created.run]);
      setRun(await fetchCrewRun(created.run.id));
      router.replace(crewTaskPath(taskId, created.run.id));
      setError(null);
      return true;
    } catch {
      setError('The terminal run changed or the successor could not be created.');
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }, [router, run, taskId]);

  if (!taskId) return <LoadState error="Invalid Crew task link." onBack={() => router.back()} />;
  if (!run || !view) {
    return <LoadState error={error} onBack={() => router.back()} onRetry={() => void load()} />;
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-row items-start justify-between gap-3 px-4 pb-3">
          <View className="min-w-0 flex-1">
            <Text className="text-2xl font-semibold text-foreground" numberOfLines={2}>{task?.objective ?? 'Crew task'}</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              {view.summary}{view.outcomeLabel ? ` · ${view.outcomeLabel}` : ''}
            </Text>
          </View>
          <Pressable onPress={() => router.back()} className="min-h-11 justify-center px-2">
            <Text className="text-muted-foreground">Back</Text>
          </Pressable>
        </View>

        <ScrollView className="flex-1 px-4" contentContainerClassName="pb-6" keyboardShouldPersistTaps="handled">
          <CrewRunHistory
            runs={runHistory}
            selectedRunId={run.id}
            onSelect={(runId) => router.replace(crewTaskPath(taskId, runId))}
          />
          <CrewRunProgress steps={view.steps} />
          <CrewOutcomeEvidence evidence={view.outcomeEvidence} />

          <Text className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">Members</Text>
          <View className="gap-2">
            {run.members.map((member) => (
              <Pressable
                key={member.id}
                disabled={!member.sessionId}
                onPress={() => member.sessionId && router.push(`/session/${member.sessionId}`)}
                className="min-h-11 rounded-lg border border-border bg-card px-4 py-3"
              >
                <Text className="font-medium text-foreground">{member.label}</Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {member.provider} · {member.model} · {member.status}{member.sessionId ? ' · View session' : ''}
                </Text>
              </Pressable>
            ))}
            {!run.members.length ? <Text className="text-sm text-muted-foreground">Members appear as each role starts.</Text> : null}
          </View>

          <Text className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">Gates</Text>
          <View className="gap-2">
            {view.gates.map((gate) => <CrewGateCard key={gate.kind} gate={gate} />)}
            {!view.gates.length ? <Text className="text-sm text-muted-foreground">No verify or review evidence yet.</Text> : null}
          </View>
          <CrewArtifactEvidence
            runId={run.id}
            artifacts={view.evidenceArtifacts}
            blocker={view.blockingReviewFinding}
          />
          {error ? <Text className="mt-4 text-sm text-destructive">{error}</Text> : null}
        </ScrollView>

        <CrewRunActionPanel
          actions={view.actions}
          busy={busy}
          successorReady={Boolean(run.workspaceHead)}
          onCommand={act}
          onSuccessor={createSuccessor}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function LoadState({ error, onBack, onRetry }: { error: string | null; onBack: () => void; onRetry?: () => void }) {
  return (
    <SafeAreaView className="flex-1 items-center justify-center gap-3 bg-background px-6">
      {error ? <Text className="text-center text-destructive">{error}</Text> : <ActivityIndicator />}
      {error && onRetry ? <Pressable onPress={onRetry} className="min-h-11 justify-center px-4"><Text className="font-semibold text-primary">Try again</Text></Pressable> : null}
      <Pressable onPress={onBack} className="min-h-11 justify-center px-4"><Text className="text-muted-foreground">Back</Text></Pressable>
    </SafeAreaView>
  );
}
