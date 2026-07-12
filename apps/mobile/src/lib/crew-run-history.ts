import type { CrewRunDto } from '@nuncio/core/crew-api';

export interface MobileCrewRunHistoryItem {
  id: string;
  number: number;
  phase: string;
  state: string;
  selected: boolean;
}

export function selectCrewRun(
  runs: CrewRunDto[],
  requestedRunId?: string | null,
): CrewRunDto | null {
  if (requestedRunId) {
    const requested = runs.find((run) => run.id === requestedRunId);
    if (requested) return requested;
  }
  return runs.at(-1) ?? null;
}

export function buildCrewRunHistory(
  runs: CrewRunDto[],
  selectedRunId: string,
): MobileCrewRunHistoryItem[] {
  return runs.map((run, index) => ({
    id: run.id,
    number: index + 1,
    phase: title(run.phase),
    state: title(run.outcome ?? run.status),
    selected: run.id === selectedRunId,
  })).reverse();
}

function title(value: string): string {
  const normalized = value.toLowerCase().replaceAll('_', ' ');
  return normalized.replace(/^\w/, (letter) => letter.toUpperCase());
}
