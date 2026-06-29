import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarkdownViewProps {
  text: string;
  className?: string;
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

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const body = cleanCodeBody(code);
  const displayLang =
    language && language.length > 0 ? language.toUpperCase() : 'TEXT';
  return (
    <div className="my-2 rounded-md border border-border/40 bg-muted/25 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/30">
        <span className="text-[11px] font-mono text-muted-foreground tracking-wide">
          {displayLang}
        </span>
        <CopyButton getText={() => body} label="Copy code" />
      </div>
      <pre className="px-3 py-2.5 overflow-x-auto text-[12.5px] leading-relaxed font-mono text-foreground/90">
        <code>{body}</code>
      </pre>
    </div>
  );
}

/**
 * Renders assistant message text as GitHub-flavored markdown.
 *
 * - Inline `code` → mono pill with subtle bg.
 * - Fenced ```lang code blocks → CodeBlock with language header + copy button.
 * - Tables, lists, headers, blockquotes via remark-gfm.
 * - Streaming-safe: react-markdown handles partial input gracefully (unclosed
 *   fences render as plain text until the closing fence arrives).
 */
export function MarkdownView({ text, className }: MarkdownViewProps) {
  return (
    <div
      className={cn(
        'text-[14px] leading-relaxed text-foreground',
        '[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_h1]:text-[18px] [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
        '[&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:mt-3.5 [&_h2]:mb-1.5',
        '[&_h3]:text-[14.5px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1',
        '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[_li]:my-0.5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:my-2',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_em]:italic',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_table]:my-2 [&_table]:w-full [&_table]:text-[13px] [&_table]:border-collapse',
        '[&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted/30 [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: cls, children, ...props }) {
            const match = /language-(\w+)/.exec(cls ?? '');
            const isInline = !match && !String(children).includes('\n');
            if (isInline) {
              return (
                <code
                  className="font-mono text-[12.5px] bg-muted/40 px-1.5 py-0.5 rounded text-foreground/90"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock
                language={match?.[1]}
                code={String(children)}
              />
            );
          },
          // Strip the default <pre> wrapper — CodeBlock provides its own.
          pre({ children }: { children?: ReactNode }) {
            return <>{children}</>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
