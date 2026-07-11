import { describe, expect, it } from 'bun:test';
import { ObservabilityService } from '../../../src/observability/observability.service';
import type { ObservabilitySources } from '../../../src/observability/observability.types';

describe('ObservabilityService Crew session boundary', () => {
  it('uses only user-facing sessions and never loads Crew member events', () => {
    let rawCalls = 0;
    let userFacingCalls = 0;
    const sessions = {
      list: () => { rawCalls += 1; return [{ id: 'crew', verifyOwner: 'crew' }]; },
      listUserFacing: () => {
        userFacingCalls += 1;
        return [{ id: 'solo', verifyOwner: 'session' }];
      },
    };
    const loadedEventIds: string[] = [];
    const service = new ObservabilityService(
      sessions as never,
      { list: (id: string) => { loadedEventIds.push(id); return []; } } as never,
      { list: () => [] } as never,
      { listAllRuns: () => [] } as never,
      { list: () => [] } as never,
      { list: () => [] } as never,
    );

    const sources = (service as unknown as { sources: () => ObservabilitySources }).sources();
    expect(sources.sessions.map(({ id, verifyOwner }) => ({ id, verifyOwner })))
      .toEqual([{ id: 'solo', verifyOwner: 'session' }]);
    expect(loadedEventIds).toEqual(['solo']);
    expect(userFacingCalls).toBe(1);
    expect(rawCalls).toBe(0);
  });
});
