import changelogRaw from 'virtual:changelog';
import { parseChangelog, type ChangelogRelease, type ChangelogSection } from '../lib/parse-changelog';
import { tokenizeInlineMarkdown, type InlineToken } from '../lib/render-inline-markdown';

const REPO = 'oscarlehuu/nuncio';

/**
 * Landing Changelog section. Renders the repo-root CHANGELOG.md (produced by
 * Changesets, loaded at build time via the `virtual:changelog` Vite plugin) as
 * a versioned, categorized list. Every rebuild on `main` picks up the latest
 * releases automatically — no manual update needed.
 *
 * Mirrors the parsing/rendering approach of apps/web's ChangelogView but uses
 * the landing's own greyscale styling instead of shadcn primitives.
 */
export function ChangelogSection() {
  const { releases } = parseChangelog(changelogRaw);

  return (
    <div className="changelog">
      {releases.length === 0 ? (
        <p className="cl-empty">No releases yet.</p>
      ) : (
        releases.map((release) => <ReleaseBlock key={release.version} release={release} />)
      )}
      <p className="cl-foot">
        Generated from{' '}
        <a href={`https://github.com/${REPO}/blob/main/CHANGELOG.md`}>CHANGELOG.md</a> — updated
        automatically on every release.
      </p>
    </div>
  );
}

function ReleaseBlock({ release }: { release: ChangelogRelease }) {
  const releaseUrl = `https://github.com/${REPO}/releases/tag/v${release.version}`;
  return (
    <article className="cl-release">
      <div className="cl-release-head">
        <span className="cl-version">v{release.version}</span>
        {release.date && <time className="cl-date">{release.date}</time>}
        <a href={releaseUrl} target="_blank" rel="noreferrer" className="cl-release-link">
          Release notes ↗
        </a>
      </div>
      {release.sections.map((section) => (
        <SectionBlock key={section.title} section={section} />
      ))}
    </article>
  );
}

function SectionBlock({ section }: { section: ChangelogSection }) {
  const dotClass = sectionDotClass(section.title);
  return (
    <div className="cl-section">
      <div className="cl-section-head">
        <span className={`cl-section-dot ${dotClass}`} />
        <h3 className="cl-section-title">{section.title}</h3>
      </div>
      <ul className="cl-entries">
        {section.entries.map((entry, i) => (
          <li key={i} className="cl-entry">
            <span className="dash">–</span>
            <span>{renderInline(entry)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderInline(text: string) {
  return tokenizeInlineMarkdown(text).map((token: InlineToken, i: number) => {
    switch (token.type) {
      case 'bold':
        return <strong key={i}>{token.value}</strong>;
      case 'code':
        return <code key={i}>{token.value}</code>;
      case 'link':
        return (
          <a key={i} href={token.href} target="_blank" rel="noreferrer">
            {token.label}
          </a>
        );
      default:
        return <span key={i}>{token.value}</span>;
    }
  });
}

function sectionDotClass(title: string): string {
  if (title.startsWith('Major')) return 'major';
  if (title.startsWith('Minor')) return 'minor';
  return 'patch';
}
