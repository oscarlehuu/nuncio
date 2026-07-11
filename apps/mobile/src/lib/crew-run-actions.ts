import type {
  CreateCrewSuccessorInput,
  CrewRunCommand,
  CrewRunCommandInput,
  CrewRunDto,
} from '@nuncio/core/crew-api';

export function buildCrewCommandInput(
  run: CrewRunDto,
  command: CrewRunCommand,
  value?: string,
): CrewRunCommandInput | null {
  if (command === 'clarification') {
    const message = value?.trim();
    return message ? { expectedRevision: run.revision, message } : null;
  }
  if (command === 'extra-round') {
    return value === 'verify' || value === 'review'
      ? { expectedRevision: run.revision, gate: value }
      : null;
  }
  return { expectedRevision: run.revision };
}

export function buildCrewSuccessorInput(
  run: CrewRunDto,
  changeRequest: string,
): CreateCrewSuccessorInput | null {
  const trimmed = changeRequest.trim();
  if (run.status !== 'TERMINAL' || !run.workspaceHead || !trimmed) return null;
  return {
    changeRequest: trimmed,
    expectedBaseHead: run.workspaceHead,
    priorRunId: run.id,
    expectedRevision: run.revision,
  };
}
