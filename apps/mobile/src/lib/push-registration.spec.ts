import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-device', () => ({ isDevice: false, deviceName: null }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: null, easConfig: null } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@nuncio/core/http', () => ({ apiFetch: vi.fn() }));

function response(data: Record<string, unknown>) {
  return { notification: { request: { content: { data } } } };
}

describe('notificationTargetFromNotification', () => {
  it('routes a Crew notification to the stable CrewTask', async () => {
    const module = (await import('./push-registration')) as Record<string, unknown>;
    expect(typeof module.notificationTargetFromNotification).toBe('function');

    const resolve = module.notificationTargetFromNotification as (value: unknown) => unknown;
    expect(resolve(response({ crewTaskId: 'task-1', crewRunId: 'run-2' }))).toEqual({
      kind: 'crew',
      taskId: 'task-1',
      runId: 'run-2',
    });
  });

  it('prefers Crew routing when a backwards-compatible session id is also present', async () => {
    const module = (await import('./push-registration')) as Record<string, unknown>;
    const resolve = module.notificationTargetFromNotification as (value: unknown) => unknown;
    expect(resolve(response({ crewTaskId: 'task-1', sessionId: 'session-1' }))).toEqual({
      kind: 'crew',
      taskId: 'task-1',
      runId: null,
    });
  });

  it('preserves existing session routing and rejects malformed ids', async () => {
    const module = (await import('./push-registration')) as Record<string, unknown>;
    const resolve = module.notificationTargetFromNotification as (value: unknown) => unknown;
    expect(resolve(response({ sessionId: 'session-1' }))).toEqual({
      kind: 'session',
      sessionId: 'session-1',
    });
    expect(resolve(response({ crewTaskId: 42, sessionId: null }))).toBeNull();
  });
});
