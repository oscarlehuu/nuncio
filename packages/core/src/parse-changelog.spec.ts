import { describe, it, expect } from 'vitest';
import { parseChangelog } from './parse-changelog';

const SAMPLE = `# Changelog

## 0.2.0

### Minor Changes

- Added an in-app **What's new** page so you can see every release without leaving Nuncio. ([#5](https://github.com/oscarlehuu/nuncio/pull/5) by [@oscarlehuu](https://github.com/oscarlehuu))

### Patch Changes

- Fixed a toast spam bug when the server was unreachable.

## 0.1.0 (2026-06-20)

### Minor Changes

- Initial public release: a self-hosted, mobile-first web app for delegating tasks to AI coding agents.

### Patch Changes

- Migrated runtime to Bun.
`;

describe('parseChangelog', () => {
  it('parses releases in newest-first order', () => {
    const { releases } = parseChangelog(SAMPLE);
    expect(releases.map((r) => r.version)).toEqual(['0.2.0', '0.1.0']);
  });

  it('captures an optional date stamp on the version header', () => {
    const { releases } = parseChangelog(SAMPLE);
    expect(releases[0].date).toBeUndefined();
    expect(releases[1].date).toBe('2026-06-20');
  });

  it('groups entries under their category section', () => {
    const { releases } = parseChangelog(SAMPLE);
    const r0 = releases[0];
    expect(r0.sections.map((s) => s.title)).toEqual(['Minor Changes', 'Patch Changes']);
    expect(r0.sections[0].entries).toHaveLength(1);
    expect(r0.sections[0].entries[0]).toContain("What's new");
    expect(r0.sections[1].entries[0]).toContain('toast spam');
  });

  it('preserves inline markdown (bold, links) in entry text', () => {
    const { releases } = parseChangelog(SAMPLE);
    const entry = releases[0].sections[0].entries[0];
    expect(entry).toContain("**What's new**");
    expect(entry).toContain('([#5](https://github.com/oscarlehuu/nuncio/pull/5)');
  });

  it('ignores the H1 and any prose before the first version header', () => {
    const { releases } = parseChangelog(`# nuncio\n\nSome intro prose.\n\n## 0.1.0\n\n### Minor Changes\n\n- hi`);
    expect(releases).toHaveLength(1);
    expect(releases[0].sections[0].entries).toEqual(['hi']);
  });

  it('joins indented continuation lines into the current bullet', () => {
    const raw = `## 0.1.0\n\n### Minor Changes\n\n- first line\n  continued second line\n`;
    const { releases } = parseChangelog(raw);
    expect(releases[0].sections[0].entries[0]).toBe('first line continued second line');
  });

  it('returns an empty release list for empty or header-only input', () => {
    expect(parseChangelog('').releases).toEqual([]);
    expect(parseChangelog('# Changelog\n\n').releases).toEqual([]);
  });
});
