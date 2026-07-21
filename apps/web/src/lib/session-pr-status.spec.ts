import { describe, expect, it } from 'vitest';
import { resolveSessionPrBadge } from './session-pr-status';

describe('resolveSessionPrBadge', () => {
  it('returns null when there is no PR number', () => {
    expect(resolveSessionPrBadge({ pullRequestState: 'open' })).toBeNull();
    expect(resolveSessionPrBadge({ pullRequestNumber: null, forgeStatus: 'open' })).toBeNull();
  });

  it('maps an open PR to the success presentation', () => {
    expect(
      resolveSessionPrBadge({
        pullRequestNumber: 42,
        pullRequestState: 'open',
        pullRequestUrl: 'https://github.com/o/r/pull/42',
      }),
    ).toEqual({
      state: 'open',
      number: 42,
      label: 'PR open',
      colorClass: 'text-success',
      url: 'https://github.com/o/r/pull/42',
      ariaLabel: '#42 PR open',
    });
  });

  it('maps merged and closed states', () => {
    expect(
      resolveSessionPrBadge({ pullRequestNumber: 7, pullRequestState: 'merged' })?.state,
    ).toBe('merged');
    expect(
      resolveSessionPrBadge({ pullRequestNumber: 7, pullRequestState: 'closed' }),
    ).toMatchObject({ state: 'closed', colorClass: 'text-muted-foreground' });
  });

  it('falls back to forgeStatus when pullRequestState is missing', () => {
    expect(
      resolveSessionPrBadge({ pullRequestNumber: 3, forgeStatus: 'merged' }),
    ).toMatchObject({ state: 'merged', label: 'PR merged', colorClass: 'text-info' });
  });

  it('ignores non-terminal forge statuses like opening/none/error', () => {
    expect(resolveSessionPrBadge({ pullRequestNumber: 1, forgeStatus: 'opening' })).toBeNull();
    expect(resolveSessionPrBadge({ pullRequestNumber: 1, forgeStatus: 'none' })).toBeNull();
    expect(resolveSessionPrBadge({ pullRequestNumber: 1, forgeStatus: 'error' })).toBeNull();
  });
});
