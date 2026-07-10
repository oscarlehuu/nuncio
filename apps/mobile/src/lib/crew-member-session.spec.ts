import { describe, expect, it } from 'vitest';
import { crewMemberSessionAccess } from './crew-member-session';

describe('crewMemberSessionAccess', () => {
  it('makes Crew-owned member sessions inspect-only', () => {
    expect(crewMemberSessionAccess({ verifyOwner: 'crew' })).toEqual({
      managedByCrew: true,
      canMutate: false,
    });
  });

  it('preserves the exact Solo session behavior when owner is absent or session-owned', () => {
    expect(crewMemberSessionAccess({})).toEqual({ managedByCrew: false, canMutate: true });
    expect(crewMemberSessionAccess({ verifyOwner: 'session' })).toEqual({
      managedByCrew: false,
      canMutate: true,
    });
  });
});
