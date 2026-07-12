import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import {
  fetchCrewArtifactRange,
  type CrewArtifactDto,
  type CrewBlockingReviewFinding,
  type CrewEvidenceArtifactChoice,
} from '@nuncio/core/crew-api';
import {
  appendCrewArtifactPage,
  failCrewArtifactPage,
  initialCrewArtifactViewerState,
  startCrewArtifactPage,
} from '../lib/crew-artifact-viewer-state';

const PAGE_BYTES = 16_384;

export function CrewArtifactEvidence({ runId, artifacts, blocker }: {
  runId: string;
  artifacts: CrewEvidenceArtifactChoice[];
  blocker: CrewBlockingReviewFinding | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = artifacts.find(({ artifact }) => artifact.id === selectedId) ?? null;
  if (!artifacts.length && !blocker) return null;
  return (
    <View className="mt-6 min-w-0 rounded-lg border border-border bg-card px-4 py-3">
      <Text className="font-semibold text-foreground">Readable evidence</Text>
      {blocker ? (
        <View className="mt-3 rounded-lg border border-destructive px-3 py-2">
          <Text className="font-semibold text-foreground">{blocker.title}</Text>
          <Text className="mt-1 text-sm text-muted-foreground">{blocker.body}</Text>
        </View>
      ) : null}
      <View className="mt-3 gap-2">
        {artifacts.map((choice) => (
          <Pressable
            key={choice.artifact.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${choice.label.toLowerCase()}`}
            onPress={() => setSelectedId(choice.artifact.id)}
            className="min-h-11 justify-center rounded-lg border border-border px-3"
          >
            <Text className="font-medium text-foreground">Open {choice.label.toLowerCase()}</Text>
          </Pressable>
        ))}
      </View>
      {selected ? (
        <ArtifactViewer
          key={selected.artifact.id}
          runId={runId}
          artifact={selected.artifact}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </View>
  );
}

function ArtifactViewer({ runId, artifact, onClose }: {
  runId: string;
  artifact: CrewArtifactDto;
  onClose: () => void;
}) {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [state, setState] = useState(() =>
    startCrewArtifactPage(initialCrewArtifactViewerState),
  );
  const load = useCallback(async (offset: number, token = generation.current) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState(startCrewArtifactPage);
    try {
      const range = await fetchCrewArtifactRange(runId, artifact.id, {
        offset,
        limit: PAGE_BYTES,
      });
      if (generation.current !== token) return;
      inFlight.current = false;
      setState((current) => appendCrewArtifactPage(current, range));
    } catch {
      if (generation.current !== token) return;
      inFlight.current = false;
      setState((current) => failCrewArtifactPage(current, 'Could not load evidence'));
    }
  }, [artifact.id, runId]);
  useEffect(() => {
    inFlight.current = false;
    const token = ++generation.current;
    void load(0, token);
    return () => { generation.current += 1; };
  }, [load]);
  const label = artifact.kind === 'verify-log' ? 'Verify log' : 'Workspace diff';
  return (
    <View className="mt-3 min-w-0 border-t border-border pt-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="font-semibold text-foreground">{label}</Text>
          <Text className="text-xs text-muted-foreground">Redacted text · {artifact.byteCount} bytes</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} className="min-h-11 justify-center px-2">
          <Text className="text-primary">Close</Text>
        </Pressable>
      </View>
      {state.text ? (
        <ScrollView className="mt-2 max-h-72 rounded-lg bg-muted p-3" nestedScrollEnabled>
          <Text selectable className="font-mono text-xs text-foreground">{state.text}</Text>
        </ScrollView>
      ) : null}
      {state.loading ? <View className="mt-3 flex-row items-center gap-2"><ActivityIndicator size="small" /><Text className="text-sm text-muted-foreground">Loading evidence…</Text></View> : null}
      {state.error ? (
        <View accessibilityRole="alert" className="mt-3 gap-2">
          <Text className="text-sm text-destructive">{state.error}</Text>
          <PageButton label="Retry" onPress={() => void load(state.nextOffset)} />
        </View>
      ) : null}
      {!state.loading && !state.error && !state.eof ? <PageButton label="Load more" onPress={() => void load(state.nextOffset)} /> : null}
      {state.eof ? <Text className="mt-3 text-sm text-muted-foreground">Complete evidence loaded.</Text> : null}
    </View>
  );
}

function PageButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} className="mt-2 min-h-11 justify-center self-start rounded-lg border border-border px-4">
      <Text className="font-semibold text-primary">{label}</Text>
    </Pressable>
  );
}
