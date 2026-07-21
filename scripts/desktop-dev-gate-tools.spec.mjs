import { describe, expect, it } from 'bun:test';
import {
  commitFromReleaseBody,
  decideDevPublish,
  devReleaseShas,
  isDevTag,
  latestShippedSha,
  withRetry,
} from './desktop-dev-gate-utils.mjs';
import { waitForRequiredRuns } from './desktop-dev-gate.mjs';

const CI = '.github/workflows/ci.yml';
const SMOKE = '.github/workflows/desktop-smoke.yml';
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const green = () => [
  { workflow: CI, conclusion: 'success' },
  { workflow: SMOKE, conclusion: 'success' },
];
const base = (over = {}) => ({
  requiredRuns: green(),
  releasedShas: [],
  lastShippedSha: null,
  aheadOfLastShipped: true,
  sha: SHA,
  ...over,
});

describe('decideDevPublish', () => {
  it('publishes when every required check is green, unshipped, and not behind', () => {
    expect(decideDevPublish(base()).publish).toBe(true);
  });

  it('holds while any required check is still pending (no run yet)', () => {
    const runs = [
      { workflow: CI, conclusion: 'success' },
      { workflow: SMOKE, conclusion: null },
    ];
    expect(decideDevPublish(base({ requiredRuns: runs })).publish).toBe(false);
  });

  it('holds when a required check concluded red — never publishes a red commit', () => {
    for (const bad of ['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']) {
      const runs = [
        { workflow: CI, conclusion: bad },
        { workflow: SMOKE, conclusion: 'success' },
      ];
      expect(decideDevPublish(base({ requiredRuns: runs })).publish).toBe(false);
    }
  });

  it('does not deadlock on a completion tie — the all-green trigger just publishes', () => {
    expect(decideDevPublish(base()).publish).toBe(true);
  });

  it('skips a commit that already has a dev release — draft or published, case-insensitive', () => {
    // Idempotency: the two-gates-before-first-publish race + re-runs are no-ops.
    const d = decideDevPublish(base({ releasedShas: [SHA.toUpperCase()] }));
    expect(d.publish).toBe(false);
    expect(d.reason).toContain('already exists');
  });

  it('publishes a different commit even when another commit has a release', () => {
    expect(decideDevPublish(base({ releasedShas: ['f'.repeat(40)] })).publish).toBe(true);
  });

  it('rejects a stale commit behind the last shipped one — never go backward', () => {
    const older = 'b'.repeat(40);
    const d = decideDevPublish(base({
      sha: older,
      lastShippedSha: SHA,
      aheadOfLastShipped: false, // compare said `older` is behind SHA
    }));
    expect(d.publish).toBe(false);
    expect(d.reason).toContain('behind the last shipped');
  });

  it('publishes a newer commit that is ahead of the last shipped one', () => {
    const newer = 'c'.repeat(40);
    expect(decideDevPublish(base({
      sha: newer,
      lastShippedSha: SHA,
      aheadOfLastShipped: true,
    })).publish).toBe(true);
  });

  it('publishes the very first dev build (nothing shipped to be behind of)', () => {
    expect(decideDevPublish(base({ lastShippedSha: null })).publish).toBe(true);
  });

  it('holds when no required checks resolved', () => {
    expect(decideDevPublish(base({ requiredRuns: [] })).publish).toBe(false);
  });
});

describe('devReleaseShas — includes drafts (a draft is a build in flight)', () => {
  it('collects dev-tag SHAs from draft AND published releases, ignoring stable/unmarked', () => {
    const releases = [
      { tagName: 'v1.0.0-dev.10', isDraft: false, body: 'x\ncommit: aaaa111' },
      { tagName: 'v1.0.0-dev.11', isDraft: true, body: 'commit: bbbb222' }, // draft counts
      { tagName: 'v1.0.0', isDraft: false, body: 'commit: cccc333' }, // stable, not dev
      { tagName: 'v1.0.0-dev.9', isDraft: false, body: 'no marker' }, // unmarked
      { tag_name: 'v1.0.0-dev.8', draft: false, body: 'commit: DDDD444' }, // gh api field names
    ];
    expect(devReleaseShas(releases).sort()).toEqual(['aaaa111', 'bbbb222', 'dddd444']);
  });
  it('handles an empty/undefined payload', () => {
    expect(devReleaseShas([])).toEqual([]);
    expect(devReleaseShas(undefined)).toEqual([]);
  });
});

describe('latestShippedSha — newest PUBLISHED dev release', () => {
  it('picks the most recent non-draft dev release by created_at (drafts never freeze the head)', () => {
    const releases = [
      { tag_name: 'v1.0.0-dev.8', draft: false, body: 'commit: a1a1a1a', created_at: '2026-07-01T00:00:00Z' },
      { tag_name: 'v1.0.0-dev.12', draft: true, body: 'commit: b2b2b2b', created_at: '2026-07-05T00:00:00Z' },
      { tag_name: 'v1.0.0-dev.10', draft: false, body: 'commit: c3c3c3c', created_at: '2026-07-03T00:00:00Z' },
    ];
    expect(latestShippedSha(releases)).toBe('c3c3c3c');
  });
  it('returns null when nothing has shipped', () => {
    expect(latestShippedSha([{ tag_name: 'v1.0.0-dev.1', draft: true, body: 'commit: aaa1111' }])).toBe(null);
    expect(latestShippedSha([])).toBe(null);
  });
});

describe('withRetry — lookup failure fails instead of silently holding', () => {
  const noSleep = () => Promise.resolve();

  it('returns on first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(() => { calls += 1; return 'ok'; }, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return 'recovered';
    }, { attempts: 3, sleep: noSleep });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws the last error after exhausting attempts (so the job fails, retryable)', async () => {
    let calls = 0;
    await expect(withRetry(() => {
      calls += 1;
      throw new Error(`down #${calls}`);
    }, { attempts: 3, sleep: noSleep })).rejects.toThrow('down #3');
    expect(calls).toBe(3);
  });
});

describe('isDevTag', () => {
  it('matches dev prerelease tags only', () => {
    expect(isDevTag('v1.2.3-dev.45')).toBe(true);
    expect(isDevTag('v1.2.3')).toBe(false);
    expect(isDevTag('v1.2.3-beta.4')).toBe(false);
    expect(isDevTag(null)).toBe(false);
  });
});

describe('commitFromReleaseBody', () => {
  it('reads the commit marker, lowercased', () => {
    expect(commitFromReleaseBody(`Automated dev build. commit: ${SHA}`)).toBe(SHA);
    expect(commitFromReleaseBody('commit: A1B2C3D')).toBe('a1b2c3d');
  });
  it('returns null when absent', () => {
    expect(commitFromReleaseBody('Automated dev build of Nuncio.')).toBe(null);
    expect(commitFromReleaseBody(null)).toBe(null);
  });
});

describe('waitForRequiredRuns (push-path poll)', () => {
  it('returns once every required check has a terminal conclusion', async () => {
    const polls = [
      [
        { workflow: CI, conclusion: null },
        { workflow: SMOKE, conclusion: null },
      ],
      [
        { workflow: CI, conclusion: 'success' },
        { workflow: SMOKE, conclusion: null },
      ],
      [
        { workflow: CI, conclusion: 'success' },
        { workflow: SMOKE, conclusion: 'success' },
      ],
    ];
    let i = 0;
    const sleeps = [];
    const result = await waitForRequiredRuns('owner/repo', SHA, {
      intervalMs: 1,
      timeoutMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      collect: async () => polls[Math.min(i++, polls.length - 1)],
    });
    expect(result.every((r) => r.conclusion === 'success')).toBe(true);
    expect(sleeps.length).toBe(2);
  });

  it('stops early when a required check fails', async () => {
    const polls = [
      [
        { workflow: CI, conclusion: null },
        { workflow: SMOKE, conclusion: null },
      ],
      [
        { workflow: CI, conclusion: 'failure' },
        { workflow: SMOKE, conclusion: 'success' },
      ],
    ];
    let i = 0;
    const result = await waitForRequiredRuns('owner/repo', SHA, {
      intervalMs: 1,
      timeoutMs: 10_000,
      sleep: async () => undefined,
      collect: async () => polls[Math.min(i++, polls.length - 1)],
    });
    expect(result.find((r) => r.workflow === CI)?.conclusion).toBe('failure');
  });
});
