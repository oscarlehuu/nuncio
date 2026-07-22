import { lazy, memo, Suspense, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { splitMarkdownSegments } from '@/lib/markdown-segments';
import { remarkCodePathLinks } from '@/lib/remark-code-path-links';
import { resolveTranscriptLinkTarget } from '@/lib/transcript-link-target';
import { ChatImage } from '@/components/chat-image';
import { ChatVideo } from '@/components/chat-video';
import { ChunkErrorBoundary } from '@/components/chunk-error-boundary';
import { isVideoUrl, unwrapDetailsHtml } from '@/lib/markdown-media-prep';

// Lazy: mermaid is ~1 MB minified and only needed when a transcript actually
// contains a mermaid fence — keep it out of the entry chunk.
const MermaidDiagram = lazy(() =>
  import('@/components/mermaid-diagram').then((m) => ({ default: m.MermaidDiagram })),
);

export type MarkdownLinkClickHandler = (
  href: string,
) => boolean | void | Promise<boolean | void>;

interface MarkdownViewProps {
  text: string;
  className?: string;
  /** While true, only the tail segment re-parses per tick and mermaid in the
   * tail renders as a plain code block until its fence closes. */
  streaming?: boolean;
  onLinkClick?: MarkdownLinkClickHandler;
}

/** Trims leading newlines and dedents a fenced code body so it renders cleanly. */
function cleanCodeBody(raw: string): string {
  const trimmed = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  return trimmed;
}

function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable (jsdom / insecure context) — silent no-op
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/50"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function CodeBlock({ language, code }: { language?: string; code: string }) {
  const body = cleanCodeBody(code);
  const displayLang =
    language && language.length > 0 ? language.toUpperCase() : 'TEXT';
  return (
    <div className="my-2.5 rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/40">
        <span className="text-ui-sm font-mono text-muted-foreground tracking-wide">
          {displayLang}
        </span>
        <CopyButton getText={() => body} label="Copy code" />
      </div>
      <pre className="code-text px-3 py-2.5 overflow-x-auto leading-relaxed font-mono text-foreground/90">
        <code>{body}</code>
      </pre>
    </div>
  );
}

function markdownComponents(
  deferMermaid: boolean,
  onLinkClick?: MarkdownLinkClickHandler,
): ComponentProps<typeof ReactMarkdown>['components'] {
  return {
    code({ className: cls, children, ...props }) {
      const match = /language-(\w+)/.exec(cls ?? '');
      const isInline = !match && !String(children).includes('\n');
      if (isInline) {
        return (
          <code
            className="font-mono text-[length:calc(12.5px*var(--chat-font-scale))] bg-muted/40 px-1.5 py-0.5 rounded text-foreground/90"
            {...props}
          >
            {children}
          </code>
        );
      }
      const language = match?.[1];
      const code = String(children);
      if (language === 'mermaid' && !deferMermaid) {
        return (
          <ChunkErrorBoundary>
            <Suspense fallback={<CodeBlock language="mermaid" code={code} />}>
              <MermaidDiagram code={code} />
            </Suspense>
          </ChunkErrorBoundary>
        );
      }
      return <CodeBlock language={language} code={code} />;
    },
    // Strip the default <pre> wrapper — CodeBlock provides its own.
    pre({ children }: { children?: ReactNode }) {
      return <>{children}</>;
    },
    a({ href, children }) {
      const linkHref = typeof href === 'string' ? href : '';
      if (isVideoUrl(linkHref)) {
        const title =
          typeof children === 'string'
            ? children
            : Array.isArray(children)
              ? children.map(String).join('')
              : undefined;
        return <ChatVideo src={linkHref} title={title} />;
      }
      const target = resolveTranscriptLinkTarget(linkHref);
      const isFileLink = target.kind === 'file';
      return (
        <a
          href={linkHref}
          target={isFileLink ? undefined : '_blank'}
          rel={isFileLink ? undefined : 'noreferrer noopener'}
          onClick={(event) => {
            if (!linkHref) return;
            if (onLinkClick) {
              const handled = onLinkClick(linkHref);
              if (handled !== false) {
                event.preventDefault();
                event.stopPropagation();
              }
              return;
            }
            if (isFileLink) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      return (
        <ChatImage
          src={typeof src === 'string' ? src : undefined}
          alt={typeof alt === 'string' ? alt : undefined}
          className="my-2"
        />
      );
    },
  };
}

/** One markdown segment; memoized so completed segments never re-parse while
 * the tail streams. ReactMarkdown emits a fragment, so no extra DOM appears. */
const MarkdownSegment = memo(function MarkdownSegment({
  text,
  deferMermaid,
  onLinkClick,
}: {
  text: string;
  deferMermaid: boolean;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCodePathLinks]}
      components={markdownComponents(deferMermaid, onLinkClick)}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * Renders assistant message text as GitHub-flavored markdown.
 *
 * - Inline `code` → mono pill with subtle bg.
 * - Fenced ```lang code blocks → CodeBlock with language header + copy button.
 * - Tables, lists, headers, blockquotes via remark-gfm.
 * - Streaming-safe: the text is split into fence-aware segments; completed
 *   segments are memoized and only the tail re-parses per received batch.
 */
export function MarkdownView({ text, className, streaming, onLinkClick }: MarkdownViewProps) {
  const prepared = useMemo(() => unwrapDetailsHtml(text), [text]);
  const segments = useMemo(() => splitMarkdownSegments(prepared), [prepared]);
  return (
    <div
      className={cn(
        'chat-text-body leading-relaxed text-foreground',
        '[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_h1]:text-[length:calc(18px*var(--chat-font-scale))] [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
        '[&_h2]:text-[length:calc(16px*var(--chat-font-scale))] [&_h2]:font-semibold [&_h2]:mt-3.5 [&_h2]:mb-1.5',
        '[&_h3]:text-[length:calc(14.5px*var(--chat-font-scale))] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1',
        '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[_li]:my-0.5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:my-2',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_em]:italic',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_table]:my-2 [&_table]:w-full [&_table]:text-[length:calc(13px*var(--chat-font-scale))] [&_table]:border-collapse',
        '[&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted/30 [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1',
        className,
      )}
    >
      {segments.map((segment, index) => (
        <MarkdownSegment
          key={index}
          text={segment}
          deferMermaid={!!streaming && index === segments.length - 1}
          onLinkClick={onLinkClick}
        />
      ))}
    </div>
  );
}
