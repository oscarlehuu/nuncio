import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCrewArtifactRange,
  type CrewArtifactDto,
} from '@nuncio/core/crew-api';
import { Button } from '@/components/ui/button';

const PAGE_BYTES = 16_384;
interface ViewerState {
  text: string;
  nextOffset: number;
  eof: boolean;
  loading: boolean;
  error: string | null;
}

export function CrewArtifactViewer({ runId, artifact, onClose }: {
  runId: string;
  artifact: CrewArtifactDto;
  onClose?: () => void;
}) {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [state, setState] = useState<ViewerState>({
    text: '', nextOffset: 0, eof: false, loading: true, error: null,
  });

  const load = useCallback(async (offset: number, replace = false, token = generation.current) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((current) => ({
      ...(replace ? { text: '', nextOffset: 0, eof: false } : current),
      loading: true,
      error: null,
    }));
    try {
      const range = await fetchCrewArtifactRange(runId, artifact.id, {
        offset,
        limit: PAGE_BYTES,
      });
      if (generation.current !== token) return;
      inFlight.current = false;
      setState((current) => ({
        text: replace ? range.text : `${current.text}${range.text}`,
        nextOffset: range.nextOffset,
        eof: range.eof,
        loading: false,
        error: null,
      }));
    } catch {
      if (generation.current !== token) return;
      inFlight.current = false;
      setState((current) => ({
        ...current,
        loading: false,
        error: 'Could not load evidence',
      }));
    }
  }, [artifact.id, runId]);

  useEffect(() => {
    inFlight.current = false;
    const token = ++generation.current;
    void load(0, true, token);
    return () => { generation.current += 1; };
  }, [load]);

  const label = artifact.kind === 'verify-log' ? 'Verify log' : 'Workspace diff';
  return (
    <section aria-label={`${label} evidence`} className="min-w-0 rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground">{label}</h3>
          <p className="text-ui-sm text-muted-foreground">Redacted text · {artifact.byteCount} bytes</p>
        </div>
        {onClose ? <Button variant="ghost" size="sm" onClick={onClose}>Close</Button> : null}
      </div>
      {state.text ? (
        <pre className="mt-3 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-foreground">{state.text}</pre>
      ) : null}
      {state.loading ? <p className="mt-3 text-ui-sm text-muted-foreground">Loading evidence…</p> : null}
      {state.error ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ui-sm text-destructive">
          <span>{state.error}</span>
          <Button variant="outline" size="sm" onClick={() => void load(state.nextOffset)}>Retry</Button>
        </div>
      ) : null}
      {!state.loading && !state.error && !state.eof ? (
        <Button className="mt-3 min-h-11" variant="outline" onClick={() => void load(state.nextOffset)}>
          Load more
        </Button>
      ) : null}
      {state.eof ? <p className="mt-3 text-ui-sm text-muted-foreground">Complete evidence loaded.</p> : null}
    </section>
  );
}
