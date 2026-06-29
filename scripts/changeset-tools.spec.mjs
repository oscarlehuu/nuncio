import { describe, expect, it } from 'bun:test';
import {
  formatChangeset,
  hasChangesetInDiff,
  isUserFacingPath,
  shouldRequireChangeset,
  slugFromSummary,
} from './changeset-utils.mjs';

describe('isUserFacingPath', () => {
  it('matches web and server source', () => {
    expect(isUserFacingPath('apps/web/src/components/home-view.tsx')).toBe(true);
    expect(isUserFacingPath('apps/server/src/sessions/sessions.service.ts')).toBe(true);
    expect(isUserFacingPath('apps/landing/src/App.tsx')).toBe(true);
    expect(isUserFacingPath('mockup.html')).toBe(true);
  });

  it('excludes specs, tests, and docs', () => {
    expect(isUserFacingPath('apps/web/src/components/home-view.spec.tsx')).toBe(false);
    expect(isUserFacingPath('apps/server/src/foo.spec.ts')).toBe(false);
    expect(isUserFacingPath('apps/server/test/unit/app.spec.ts')).toBe(false);
    expect(isUserFacingPath('README.md')).toBe(false);
    expect(isUserFacingPath('AGENTS.md')).toBe(false);
    expect(isUserFacingPath('scripts/add-changeset.mjs')).toBe(false);
  });
});

describe('hasChangesetInDiff', () => {
  it('detects changeset fragments but not README', () => {
    expect(hasChangesetInDiff(['.changeset/fix-steer-draft.md'])).toBe(true);
    expect(hasChangesetInDiff(['.changeset/README.md'])).toBe(false);
    expect(hasChangesetInDiff(['apps/web/src/App.tsx'])).toBe(false);
  });
});

describe('shouldRequireChangeset', () => {
  it('requires a changeset when user-facing files change', () => {
    expect(
      shouldRequireChangeset(['apps/web/src/App.tsx', 'README.md']),
    ).toBe(true);
  });

  it('does not require a changeset for docs-only or test-only diffs', () => {
    expect(shouldRequireChangeset(['README.md', 'AGENTS.md'])).toBe(false);
    expect(shouldRequireChangeset(['apps/server/test/unit/app.spec.ts'])).toBe(false);
  });

  it('passes when a changeset fragment is included', () => {
    expect(
      shouldRequireChangeset([
        'apps/web/src/App.tsx',
        '.changeset/fix-steer-draft.md',
      ]),
    ).toBe(false);
  });

  it('honours the no-changeset skip marker', () => {
    expect(
      shouldRequireChangeset(['apps/web/src/App.tsx'], { skip: true }),
    ).toBe(false);
  });
});

describe('formatChangeset', () => {
  it('writes valid changeset frontmatter and body', () => {
    const content = formatChangeset('patch', 'Fixed steer draft clearing on reconnect.');
    expect(content).toBe(
      '---\n"nuncio": patch\n---\n\nFixed steer draft clearing on reconnect.\n',
    );
  });
});

describe('slugFromSummary', () => {
  it('slugifies summary text', () => {
    expect(slugFromSummary('Fixed steer draft!')).toBe('fixed-steer-draft');
  });
});
