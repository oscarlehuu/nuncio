import { describe, expect, it } from 'bun:test';
import {
  CrewPushNotifier,
  crewPushContentFor,
} from '../../../src/crew/crew-push-notifier.service';
import type { CrewRunDto } from '../../../src/crew/domain/crew.types';

describe('Crew push notifications', () => {
  it('routes blocked and terminal runs to their owning task and exact run', () => {
    expect(crewPushContentFor(run('RUNNING'), 'Ship Crew')).toBeNull();
    expect(crewPushContentFor(run('BLOCKED_USER'), 'Ship Crew')).toEqual({
      title: 'Crew needs your input',
      body: 'Ship Crew',
      data: { crewTaskId: 'task-1', crewRunId: 'run-1' },
    });
    expect(crewPushContentFor(run('BLOCKED_PROVIDER'), 'Ship Crew')).toEqual({
      title: 'Crew provider unavailable',
      body: 'Ship Crew',
      data: { crewTaskId: 'task-1', crewRunId: 'run-1' },
    });
    expect(crewPushContentFor(run('TERMINAL', 'SUCCEEDED'), 'Ship Crew')?.title).toBe('Crew finished');
    expect(crewPushContentFor(run('TERMINAL', 'FAILED'), 'Ship Crew')?.title).toBe('Crew failed');
    expect(crewPushContentFor(run('TERMINAL', 'CANCELLED'), 'Ship Crew')?.title).toBe('Crew cancelled');
  });

  it('broadcasts only user-relevant committed run changes and unsubscribes on shutdown', async () => {
    let listener: ((value: CrewRunDto) => void) | null = null;
    const broadcasts: unknown[] = [];
    const notifier = new CrewPushNotifier(
      {
        onChanged: (next: (value: CrewRunDto) => void) => {
          listener = next;
          return () => { listener = null; };
        },
      } as never,
      { findById: () => ({ objective: 'Ship Crew' }) } as never,
      { broadcast: async (content: unknown) => { broadcasts.push(content); } } as never,
    );
    notifier.onModuleInit();

    const emit = (value: CrewRunDto) => {
      const current = listener;
      if (!current) throw new Error('Crew push listener was not registered');
      current(value);
    };
    emit(run('RUNNING'));
    emit(run('BLOCKED_USER'));
    await Promise.resolve();
    expect(broadcasts).toEqual([{
      title: 'Crew needs your input', body: 'Ship Crew',
      data: { crewTaskId: 'task-1', crewRunId: 'run-1' },
    }]);

    notifier.onModuleDestroy();
    expect(listener).toBeNull();
  });
});

function run(status: CrewRunDto['status'], outcome: CrewRunDto['outcome'] = null): CrewRunDto {
  return {
    id: 'run-1', taskId: 'task-1', status, outcome,
  } as CrewRunDto;
}
