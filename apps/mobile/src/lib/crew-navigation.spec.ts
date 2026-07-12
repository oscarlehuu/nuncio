import { describe, expect, it } from 'vitest';
import { crewTaskPath, notificationPath } from './crew-navigation';

describe('Crew mobile navigation', () => {
  it('uses the stable task route and preserves an explicit immutable run selection', () => {
    expect(crewTaskPath('task 1')).toBe('/crew/task%201');
    expect(crewTaskPath('task 1', 'run 9')).toBe('/crew/task%201?run=run%209');
    expect(notificationPath({ kind: 'crew', taskId: 'task-1', runId: 'run-9' })).toBe(
      '/crew/task-1?run=run-9',
    );
    expect(notificationPath({ kind: 'crew', taskId: 'task-1', runId: null })).toBe('/crew/task-1');
  });

  it('preserves session notification routing', () => {
    expect(notificationPath({ kind: 'session', sessionId: 'session-1' })).toBe('/session/session-1');
  });
});
