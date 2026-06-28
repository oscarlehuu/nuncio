/**
 * Parser for the Changesets-flavoured CHANGELOG.md (see repo root).
 *
 * File format produced by `@changesets/changelog-github`:
 *
 *   # Changelog
 *
 *   ## 0.2.0
 *
 *   ### Minor Changes
 *
 *   - <entry> ([#PR](url) by [@user](url))
 *
 *   ### Patch Changes
 *
 *   - <entry>
 *
 *   ## 0.1.0
 *   ...
 *
 * Releases appear newest-first (Changesets prepends each new version). A version
 * header may carry an optional trailing date: `## 0.2.0 (2026-06-28)`.
 */

export interface ChangelogSection {
  /** Category title, e.g. "Minor Changes", "Patch Changes", "Major Changes". */
  title: string;
  /** Bullet entry texts (raw markdown; links/bold/code rendered downstream). */
  entries: string[];
}

export interface ChangelogRelease {
  version: string;
  /** ISO date string when Changesets is configured to stamp one. */
  date?: string;
  sections: ChangelogSection[];
}

export interface ParsedChangelog {
  /** Releases in file order (newest-first). */
  releases: ChangelogRelease[];
}

const VERSION_HEADER = /^##\s+(\d+\.\d+\.\d+)(?:\s+\(([^)]+)\))?\s*$/;
const SECTION_HEADER = /^###\s+(.+?)\s*$/;
const BULLET = /^\s*-\s+(.*)$/;

export function parseChangelog(raw: string): ParsedChangelog {
  const releases: ChangelogRelease[] = [];
  const lines = raw.split('\n');

  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let entry: string[] | null = null;

  const flushEntry = () => {
    if (release && section && entry && entry.length > 0) {
      section.entries.push(entry.join(' ').trim());
    }
    entry = null;
  };
  const flushSection = () => {
    flushEntry();
    if (release && section) release.sections.push(section);
    section = null;
  };
  const flushRelease = () => {
    flushSection();
    if (release) releases.push(release);
    release = null;
  };

  for (const line of lines) {
    const v = line.match(VERSION_HEADER);
    if (v) {
      flushRelease();
      release = { version: v[1], date: v[2], sections: [] };
      section = null;
      entry = null;
      continue;
    }
    const s = line.match(SECTION_HEADER);
    if (s && release) {
      flushSection();
      section = { title: s[1].trim(), entries: [] };
      entry = null;
      continue;
    }
    if (release && section) {
      const b = line.match(BULLET);
      if (b) {
        flushEntry();
        entry = [b[1]];
        continue;
      }
      // Indented continuation line of the current bullet.
      if (entry !== null && line.trim() !== '') {
        entry.push(line.trim());
        continue;
      }
      if (line.trim() === '') flushEntry();
    }
  }
  flushRelease();
  return { releases };
}
