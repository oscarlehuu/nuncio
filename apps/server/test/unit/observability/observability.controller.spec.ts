import { describe, expect, it } from 'bun:test';
import { ObservabilityController, TimelineController } from '../../../src/observability/observability.controller';
import type { ObservabilityService } from '../../../src/observability/observability.service';

describe('TimelineController', () => {
  it('GET /timeline forwards phone pagination query to the global timeline service', () => {
    const calls: unknown[] = [];
    const service = {
      timeline(input: unknown) {
        calls.push(input);
        return { entries: [], nextBefore: null };
      },
    } as Pick<ObservabilityService, 'timeline'>;

    const controller = new TimelineController(service as ObservabilityService);
    const body = controller.timeline('10', '20', '15', '5', '/repo/a', 'pi');

    expect(body).toEqual({ entries: [], nextBefore: null });
    expect(calls).toEqual([
      { from: '10', to: '20', before: '15', limit: '5', projectPath: '/repo/a', provider: 'pi' },
    ]);
  });

  it('keeps /observability/timeline compatible with the Sub-phase A array shape', () => {
    const service = {
      timeline() {
        return {
          entries: [
            {
              id: 'e1',
              ts: 10,
              at: 10,
              kind: 'session-started',
              title: 'Started',
              projectPath: null,
              provider: null,
            },
          ],
          nextBefore: 10,
        };
      },
    } as Pick<ObservabilityService, 'timeline'>;

    const controller = new ObservabilityController(service as ObservabilityService);
    expect(controller.timeline()).toEqual([
      expect.objectContaining({ id: 'e1', kind: 'session-started' }),
    ]);
  });
});
