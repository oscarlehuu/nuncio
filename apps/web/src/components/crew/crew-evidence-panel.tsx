import { useState } from 'react';
import {
  deriveBlockingReviewFinding,
  deriveCurrentCrewEvidenceArtifacts,
  type CrewRunDetailDto,
} from '@nuncio/core/crew-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CrewArtifactViewer } from './crew-artifact-viewer';

export function CrewEvidencePanel({ run }: { run: CrewRunDetailDto }) {
  const artifacts = deriveCurrentCrewEvidenceArtifacts(run);
  const blocker = deriveBlockingReviewFinding(run);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = artifacts.find(({ artifact }) => artifact.id === selectedId) ?? null;
  const currentDiff = artifacts.find(({ artifact }) => artifact.kind === 'workspace-diff')?.artifact;
  const uiFileCount = currentDiff?.kind === 'workspace-diff' && currentDiff.metadata.uiTouched === true
    ? currentDiff.metadata.uiFileCount ?? 0
    : null;
  if (!artifacts.length && !blocker) return null;
  return (
    <section aria-labelledby="crew-readable-evidence" className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="crew-readable-evidence" className="font-semibold text-foreground">Readable evidence</h2>
        {uiFileCount !== null ? (
          <Badge variant="secondary">{`UI-touching diff · ${uiFileCount} ${uiFileCount === 1 ? 'file' : 'files'}`}</Badge>
        ) : null}
      </div>
      {blocker ? (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <h3 className="font-medium text-foreground">{blocker.title}</h3>
          <p className="mt-1 text-ui-sm text-muted-foreground">{blocker.body}</p>
        </div>
      ) : null}
      {artifacts.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {artifacts.map((choice) => (
            <Button
              key={choice.artifact.id}
              className="min-h-11"
              variant={choice.artifact.id === selectedId ? 'default' : 'outline'}
              onClick={() => setSelectedId(choice.artifact.id)}
            >
              Open {choice.label.toLowerCase()}
            </Button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <div className="mt-3 min-w-0">
          <CrewArtifactViewer
            key={selected.artifact.id}
            runId={run.id}
            artifact={selected.artifact}
            onClose={() => setSelectedId(null)}
          />
        </div>
      ) : null}
    </section>
  );
}
