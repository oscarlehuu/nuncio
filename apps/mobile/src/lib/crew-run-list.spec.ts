import { describe, expect, it } from 'vitest';
import type { CrewRunSummaryDto } from '@nuncio/core/crew-api';
import { buildCrewRunRows } from './crew-run-list';

function run(
  id: string, taskId: string, objective: string, updatedAt: number,
  overrides: Partial<CrewRunSummaryDto> = {},
): CrewRunSummaryDto {
  return {
    id, taskId, objective, phase: 'BUILD', status: 'RUNNING', outcome: null,
    blockedReason: null, revision: 1, workspaceHead: 'abc', createdAt: updatedAt - 1,
    updatedAt, ...overrides,
  };
}

describe('mobile Crew run list projection', () => {
  it('orders bounded summary rows and preserves objective, phase, and status', () => {
    const runs = [
      run('run-a', 'task-a', 'Verify mobile', 20, { phase: 'VERIFY' }),
      run('run-b', 'task-b', 'Build Crew', 30),
    ];
    expect(buildCrewRunRows(runs)).toEqual([
      { key: 'crew:task-b', taskId: 'task-b', objective: 'Build Crew', phase: 'BUILD', status: 'RUNNING', updatedAt: 30 },
      { key: 'crew:task-a', taskId: 'task-a', objective: 'Verify mobile', phase: 'VERIFY', status: 'RUNNING', updatedAt: 20 },
    ]);
  });
});
