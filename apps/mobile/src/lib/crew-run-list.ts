import type { CrewRunSummaryDto } from '@nuncio/core/crew-api';

export interface CrewRunRowModel {
  key: string;
  taskId: string;
  objective: string;
  phase: CrewRunSummaryDto['phase'];
  status: CrewRunSummaryDto['status'];
  updatedAt: number;
}

export function buildCrewRunRows(runs: CrewRunSummaryDto[]): CrewRunRowModel[] {
  return runs
    .map((run): CrewRunRowModel => ({
        key: `crew:${run.taskId}`,
        taskId: run.taskId,
        objective: run.objective,
        phase: run.phase,
        status: run.status,
        updatedAt: run.updatedAt,
      }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));
}
