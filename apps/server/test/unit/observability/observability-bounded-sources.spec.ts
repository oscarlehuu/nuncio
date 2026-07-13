import { describe, expect, it } from 'bun:test';
import { ObservabilityService } from '../../../src/observability/observability.service';

function session(id: string) {
  return {
    id,
    title: id,
    provider: 'codex',
    projectPath: null,
    createdAt: 1,
    updatedAt: 1,
    pendingInput: false,
    pullRequestUrl: null,
    pullRequestState: null,
  };
}

function makeService(sessionIds = ['solo', 'other']) {
  const observabilityCalls: Array<[string, number, number]> = [];
  const timelineCalls: Array<[string, number, number]> = [];
  let legacyCalls = 0;
  const service = new ObservabilityService(
    { listUserFacing: () => sessionIds.map(session) } as never,
    {
      list: () => { legacyCalls += 1; throw new Error('legacy full-history read'); },
      listObservabilityWindow: (id: string, from: number, to: number) => {
        observabilityCalls.push([id, from, to]);
        return [];
      },
      listTimelineWindow: (id: string, from: number, to: number) => {
        timelineCalls.push([id, from, to]);
        return [];
      },
    } as never,
    { list: () => [] } as never,
    { listAllRuns: () => [] } as never,
    { list: () => [] } as never,
    { list: () => [], latest: () => null } as never,
  );
  service.clock = { now: () => 1_000 };
  return { service, observabilityCalls, timelineCalls, legacyCalls: () => legacyCalls };
}

describe('ObservabilityService bounded event sources', () => {
  it('loads summary facts through the observability projection for the exact window', () => {
    const harness = makeService();
    harness.service.summary('10', '90');

    expect(harness.observabilityCalls).toEqual([
      ['solo', 10, 90],
      ['other', 10, 90],
    ]);
    expect(harness.timelineCalls).toEqual([]);
    expect(harness.legacyCalls()).toBe(0);
  });

  it('bounds timeline event reads by the exclusive before cursor', () => {
    const harness = makeService(['solo']);
    harness.service.timeline({ from: '10', to: '90', before: '70' });

    expect(harness.timelineCalls).toEqual([['solo', 10, 70]]);
    expect(harness.observabilityCalls).toEqual([]);
    expect(harness.legacyCalls()).toBe(0);
  });

  it('loads only the requested user-facing session for per-session metrics', () => {
    const harness = makeService();
    harness.service.session('solo', '20', '80');

    expect(harness.observabilityCalls).toEqual([['solo', 20, 80]]);
    expect(harness.legacyCalls()).toBe(0);
  });
});
