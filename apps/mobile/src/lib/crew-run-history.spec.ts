import { describe, expect, it } from 'vitest';
import type { CrewRunDto } from '@nuncio/core/crew-api';
import { buildCrewRunHistory, selectCrewRun } from './crew-run-history';

describe('mobile Crew immutable run history', () => {
  const first = run('run-1', 'DONE', 'TERMINAL', 'SUCCEEDED');
  const latest = run('run-2', 'VERIFY', 'RUNNING', null);

  it('honors an explicit deep-linked run and otherwise selects the latest run', () => {
    expect(selectCrewRun([first, latest], 'run-1')?.id).toBe('run-1');
    expect(selectCrewRun([first, latest], 'missing')?.id).toBe('run-2');
    expect(selectCrewRun([first, latest])?.id).toBe('run-2');
    expect(selectCrewRun([], 'run-1')).toBeNull();
  });

  it('projects every immutable run newest-first with stable numbering and selection', () => {
    expect(buildCrewRunHistory([first, latest], 'run-1')).toEqual([
      { id: 'run-2', number: 2, phase: 'Verify', state: 'Running', selected: false },
      { id: 'run-1', number: 1, phase: 'Done', state: 'Succeeded', selected: true },
    ]);
  });
});

function run(
  id: string,
  phase: CrewRunDto['phase'],
  status: CrewRunDto['status'],
  outcome: CrewRunDto['outcome'],
): CrewRunDto {
  return { id, phase, status, outcome } as CrewRunDto;
}
