import { Injectable } from '@nestjs/common';
import { CrewArtifactStore } from './crew-artifact.store';
import { CrewGateEvidenceService } from './crew-gate-evidence.service';
import { CrewNotFoundError } from './domain/crew-errors';
import { CrewArtifactsRepository } from './persistence/crew-artifacts.repository';
import { CrewEventsRepository } from './persistence/crew-events.repository';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewRunQueryService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly events: CrewEventsRepository,
    private readonly members: CrewMembersRepository,
    private readonly results: CrewResultsRepository,
    private readonly artifacts: CrewArtifactsRepository,
    private readonly gates: CrewGateEvidenceService,
    private readonly store: CrewArtifactStore,
  ) {}

  detail(id: string) {
    const run = this.requireRun(id);
    return {
      run: publicCrewRun(run), members: this.members.listByRun(id), results: this.results.listByRun(id),
      artifacts: this.artifacts.listByRun(id).map(({ relativeStoragePath: _private, ...artifact }) => ({
        ...artifact, metadata: publicArtifactMetadata(artifact.kind, artifact.metadata),
      })),
      gates: {
        verify: { retriesUsed: run.verifyRetriesUsed,
          retryLimit: run.profileSnapshot.policy.maxVerifyRetries, extraRounds: run.verifyExtraRounds },
        review: { retriesUsed: run.reviewRetriesUsed,
          retryLimit: run.profileSnapshot.policy.maxReviewRetries, extraRounds: run.reviewExtraRounds },
        items: this.gates.items(run),
      },
    };
  }

  listEvents(id: string, since = 0, limit = 200) {
    this.requireRun(id);
    const events = this.events.list(id, since, limit);
    return { events, nextSince: events.at(-1)?.seq ?? since };
  }

  readArtifactRange(runId: string, artifactId: string, offset: number, limit: number) {
    this.requireRun(runId);
    return this.store.readRange(runId, artifactId, offset, limit);
  }

  private requireRun(id: string) {
    const run = this.runs.findById(id);
    if (!run) throw new CrewNotFoundError('CrewRun', id);
    return run;
  }
}

export function publicCrewRun<T>(run: T): T {
  if (!run || typeof run !== 'object') return run;
  const record = run as Record<string, unknown>;
  const snapshot = record.profileSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return run;
  const policy = (snapshot as Record<string, unknown>).policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return run;
  return {
    ...record,
    profileSnapshot: {
      ...(snapshot as Record<string, unknown>),
      policy: { ...(policy as Record<string, unknown>), verifyCommand: null },
    },
  } as T;
}

function publicArtifactMetadata(kind: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const allowed = kind === 'verify-log'
    ? ['workspaceHead', 'passed', 'exitCode', 'durationMs', 'timedOut', 'outputOverflow', 'postBoundaryOk']
    : kind === 'workspace-diff' ? ['workspaceHead', 'baseHead', 'truncated', 'uiTouched', 'uiFileCount'] : [];
  return Object.fromEntries(allowed.flatMap((key) => key in metadata ? [[key, metadata[key]]] : []));
}
