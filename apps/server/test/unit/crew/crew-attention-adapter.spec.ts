import { CrewAttentionAdapter } from '../../../src/crew/crew-attention.adapter';

describe('CrewAttentionAdapter condition probe', () => {
  it('registers a durable state probe so boot reconciliation closes stale blockers', () => {
    let probe: ((item: { subjectId: string }) => boolean) | undefined;
    const attention = {
      registerProbe: jest.fn((_kind: string, next: typeof probe) => { probe = next; }),
    };
    let status = 'BLOCKED_USER';

    new CrewAttentionAdapter(
      attention as never,
      { findById: () => status === 'MISSING' ? null : { status } } as never,
    );

    expect(attention.registerProbe).toHaveBeenCalledWith('crew-blocked', expect.any(Function));
    expect(probe?.({ subjectId: 'run-1' })).toBe(true);
    status = 'BLOCKED_PROVIDER';
    expect(probe?.({ subjectId: 'run-1' })).toBe(true);
    status = 'TERMINAL';
    expect(probe?.({ subjectId: 'run-1' })).toBe(false);
    status = 'MISSING';
    expect(probe?.({ subjectId: 'run-1' })).toBe(false);
  });
});
