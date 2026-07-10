import { describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';

describe('HeartbeatService Crew session boundary', () => {
  it('excludes Crew member sessions from the zombie-session probe', () => {
    let rawCalls = 0;
    let userFacingCalls = 0;
    const sessions = {
      list: () => {
        rawCalls += 1;
        return [{ id: 'crew', verifyOwner: 'crew', status: 'RUNNING', createdAt: 0 }];
      },
      listUserFacing: () => {
        userFacingCalls += 1;
        return [{ id: 'solo', verifyOwner: 'session', status: 'RUNNING', createdAt: 0 }];
      },
      findById: () => null,
    };
    const infra = { runningSessions: () => [] as Array<{ id: string }> };
    const heartbeat = new HeartbeatService(
      undefined, undefined, undefined, undefined, infra as never,
      undefined, undefined, undefined, undefined,
      sessions as never, { latestEventAt: () => 1 } as never,
    );

    (heartbeat as unknown as { bindInfraProbes: () => void }).bindInfraProbes();
    expect(infra.runningSessions().map(({ id }) => id)).toEqual(['solo']);
    expect(userFacingCalls).toBe(1);
    expect(rawCalls).toBe(0);
  });
});
