import { describe, expect, it } from 'bun:test';
import {
  commitFromReleaseBody,
  decideDevPublish,
  isDevTag,
  publishedDevShas,
} from './desktop-dev-gate-utils.mjs';

const CI = '.github/workflows/ci.yml';
const SMOKE = '.github/workflows/desktop-smoke.yml';
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const green = () => [
  { workflow: CI, conclusion: 'success' },
  { workflow: SMOKE, conclusion: 'success' },
];

describe('decideDevPublish', () => {
  it('publishes when every required check is green and the commit has not shipped', () => {
    const d = decideDevPublish({ requiredRuns: green(), publishedShas: [], sha: SHA });
    expect(d.publish).toBe(true);
  });

  it('holds while any required check is still pending (no run yet)', () => {
    const runs = [
      { workflow: CI, conclusion: 'success' },
      { workflow: SMOKE, conclusion: null },
    ];
    expect(decideDevPublish({ requiredRuns: runs, publishedShas: [], sha: SHA }).publish).toBe(false);
  });

  it('holds when a required check concluded red — never publishes a red commit', () => {
    for (const bad of ['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']) {
      const runs = [
        { workflow: CI, conclusion: bad },
        { workflow: SMOKE, conclusion: 'success' },
      ];
      expect(decideDevPublish({ requiredRuns: runs, publishedShas: [], sha: SHA }).publish).toBe(false);
    }
  });

  it('does not deadlock on a completion tie — the all-green trigger just publishes', () => {
    // Both checks finished; whichever event evaluates this publishes (no > compare).
    expect(decideDevPublish({ requiredRuns: green(), publishedShas: [], sha: SHA }).publish).toBe(true);
  });

  it('skips a re-run of an already-shipped commit (idempotent, case-insensitive)', () => {
    const d = decideDevPublish({ requiredRuns: green(), publishedShas: [SHA.toUpperCase()], sha: SHA });
    expect(d.publish).toBe(false);
    expect(d.reason).toContain('already shipped');
  });

  it('publishes a different commit even when another commit has shipped', () => {
    const other = 'f'.repeat(40);
    expect(decideDevPublish({ requiredRuns: green(), publishedShas: [other], sha: SHA }).publish).toBe(true);
  });

  it('holds when no required checks resolved', () => {
    expect(decideDevPublish({ requiredRuns: [], publishedShas: [], sha: SHA }).publish).toBe(false);
  });
});

describe('isDevTag', () => {
  it('matches dev prerelease tags only', () => {
    expect(isDevTag('v1.2.3-dev.45')).toBe(true);
    expect(isDevTag('v1.2.3-dev.1')).toBe(true);
    expect(isDevTag('v1.2.3')).toBe(false);
    expect(isDevTag('v1.2.3-beta.4')).toBe(false);
    expect(isDevTag('')).toBe(false);
    expect(isDevTag(null)).toBe(false);
  });
});

describe('commitFromReleaseBody', () => {
  it('reads the commit marker, lowercased', () => {
    expect(commitFromReleaseBody(`Automated dev build.\n\ncommit: ${SHA}`)).toBe(SHA);
    expect(commitFromReleaseBody('commit: A1B2C3D')).toBe('a1b2c3d');
  });
  it('returns null when absent', () => {
    expect(commitFromReleaseBody('Automated dev build of Nuncio.')).toBe(null);
    expect(commitFromReleaseBody(null)).toBe(null);
  });
});

describe('publishedDevShas', () => {
  it('collects published dev-tag SHAs, ignoring drafts, stable, and unmarked releases', () => {
    const releases = [
      { tagName: 'v1.0.0-dev.10', isDraft: false, body: 'x\ncommit: aaaa111' },
      { tagName: 'v1.0.0-dev.11', isDraft: true, body: 'commit: bbbb222' }, // draft → in-flight
      { tagName: 'v1.0.0', isDraft: false, body: 'commit: cccc333' }, // stable, not a dev tag
      { tagName: 'v1.0.0-dev.9', isDraft: false, body: 'no marker here' }, // legacy, unmarked
      { tag_name: 'v1.0.0-dev.8', draft: false, body: 'commit: DDDD444' }, // gh api field names
    ];
    expect(publishedDevShas(releases).sort()).toEqual(['aaaa111', 'dddd444']);
  });
  it('handles an empty/undefined payload', () => {
    expect(publishedDevShas([])).toEqual([]);
    expect(publishedDevShas(undefined)).toEqual([]);
  });
});
