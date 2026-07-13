import { describe, expect, it } from 'bun:test';
import { ObservabilityService } from '../../../src/observability/observability.service';

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
      {
        list: () => { throw new Error('legacy full-history read'); },
        listObservabilityWindow: (id: string) => { loadedEventIds.push(id); return []; },
      } as never,
      { list: () => [] } as never,
      { listAllRuns: () => [] } as never,
      { list: () => [] } as never,
      { list: () => [] } as never,
    );

    service.clock = { now: () => 1_000 };
    service.summary('0', '1_000');
    expect(loadedEventIds).toEqual(['solo']);
    expect(userFacingCalls).toBe(1);
    expect(rawCalls).toBe(0);
  });
});
