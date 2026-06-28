import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import changelogRaw from 'virtual:changelog';
import { parseChangelog, type ChangelogRelease, type ChangelogSection } from '../lib/parse-changelog';
import { tokenizeInlineMarkdown, type InlineToken } from '../lib/render-inline-markdown';

/** GitHub repo, used to deep-link each version to its Release page. */
const REPO = 'oscarlehuu/nuncio';

interface ChangelogViewProps {
  onBack: () => void;
}

/**
 * In-app "What's new" page. Renders the repo-root CHANGELOG.md (produced by
 * Changesets, loaded at build time via the `virtual:changelog` Vite plugin)
 * as a versioned, categorized timeline. Mirrors the SettingsView layout:
 * sticky header with a back button, then a centered max-width scroll area.
 */
export function ChangelogView({ onBack }: ChangelogViewProps) {
  const { releases } = parseChangelog(changelogRaw);

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-[16px] font-semibold tracking-tight">What's new</h1>
      </header>

      <div className="flex-1 px-4 py-2 max-w-[640px] w-full mx-auto">
        <p className="text-[12px] text-muted-foreground mt-3 leading-relaxed">
          New releases and improvements to Nuncio. Each entry links back to the pull request that shipped it.
        </p>

        {releases.length === 0 ? (
          <p className="text-[13px] text-muted-foreground mt-8">No releases yet.</p>
        ) : (
          <div className="mt-6">
            {releases.map((release) => (
              <ReleaseBlock key={release.version} release={release} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ReleaseBlock({ release }: { release: ChangelogRelease }) {
  const releaseUrl = `https://github.com/${REPO}/releases/tag/v${release.version}`;
  return (
    <article className="mt-10 first:mt-0">
      <div className="flex items-center gap-2 mb-4">
        <Badge variant="secondary" className="font-mono">
          v{release.version}
        </Badge>
        {release.date && (
          <time className="text-[11px] text-muted-foreground tabular-nums">{release.date}</time>
        )}
        <a
          href={releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Release notes <ExternalLink className="size-3" />
        </a>
      </div>
      <div className="border-l border-border pl-4 ml-1 space-y-5">
        {release.sections.map((section) => (
          <SectionBlock key={section.title} section={section} />
        ))}
      </div>
    </article>
  );
}

function SectionBlock({ section }: { section: ChangelogSection }) {
  const dot = sectionDot(section.title);
  return (
    <div className="-ml-[17px] pl-0">
      <div className="flex items-center gap-1.5 mb-2">
        <span className={cn('size-1.5 rounded-full', dot)} />
        <h3 className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
          {section.title}
        </h3>
      </div>
      <ul className="space-y-1.5 pl-[9px]">
        {section.entries.map((entry, i) => (
          <li key={i} className="text-[13.5px] leading-relaxed text-foreground flex gap-2">
            <span className="text-muted-foreground select-none mt-[1px]">–</span>
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
        return (
          <strong key={i} className="font-semibold">
            {token.value}
          </strong>
        );
      case 'code':
        return (
          <code key={i} className="font-mono text-[12px] bg-muted px-1 py-0.5 rounded">
            {token.value}
          </code>
        );
      case 'link':
        return (
          <a
            key={i}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {token.label}
          </a>
        );
      default:
        return <span key={i}>{token.value}</span>;
    }
  });
}

function sectionDot(title: string): string {
  if (title.startsWith('Major')) return 'bg-destructive';
  if (title.startsWith('Minor')) return 'bg-primary';
  return 'bg-muted-foreground/60';
}
