import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { DiffHunk } from '../lib/api';

interface DiffViewProps {
  /** Unified diff text: `diff --git` headers and/or `@@` hunks. */
  diff?: string;
  /** Structured hunks from the session diff endpoint. */
  hunks?: DiffHunk[];
  renderHunkAction?: (hunk: DiffHunk, index: number) => ReactNode;
  renderHunkFooter?: (hunk: DiffHunk, index: number) => ReactNode;
  className?: string;
}

type DiffLineKind = 'hunk' | 'add' | 'del' | 'meta' | 'context';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ')) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

export function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => ({ kind: classifyLine(text), text }));
}

const LINE_CLASSES: Record<DiffLineKind, string> = {
  hunk: 'text-info bg-info/5',
  add: 'text-success bg-success/5',
  del: 'text-destructive bg-destructive/5',
  meta: 'text-muted-foreground',
  context: 'text-foreground/80',
};

function prefixStructuredLine(line: DiffHunk['lines'][number]): string {
  if (line.kind === 'add') return `+${line.text}`;
  if (line.kind === 'del') return `-${line.text}`;
  return ` ${line.text}`;
}

/** Shared unified-diff renderer for local changes and forge PR files. */
export function DiffView({ diff = '', hunks, renderHunkAction, renderHunkFooter, className }: DiffViewProps) {
  const lines = useMemo(() => parseDiffLines(diff), [diff]);

  if (hunks) {
    if (hunks.length === 0) {
      return (
        <div className={cn('rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground', className)}>
          No textual diff available.
        </div>
      );
    }

    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {hunks.map((hunk, hunkIndex) => (
          <section key={`${hunk.header}-${hunkIndex}`} className="overflow-hidden rounded-md border bg-muted/30">
            <div className="flex min-h-10 items-center gap-2 border-b border-border/50 bg-info/5 px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-info">{hunk.header}</code>
              {renderHunkAction?.(hunk, hunkIndex)}
            </div>
            <pre className="max-h-80 overflow-auto p-2 font-mono text-xs leading-5">
              {hunk.lines.map((line, lineIndex) => {
                const text = prefixStructuredLine(line);
                const kind = line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'context';
                return (
                  <div key={lineIndex} className={cn('whitespace-pre-wrap break-all px-1', LINE_CLASSES[kind])}>
                    {text || ' '}
                  </div>
                );
              })}
            </pre>
            {renderHunkFooter?.(hunk, hunkIndex)}
          </section>
        ))}
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className={cn('rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground', className)}>
        No textual diff available.
      </div>
    );
  }

  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5',
        className,
      )}
    >
      {lines.map((line, index) => (
        <div key={index} className={cn('whitespace-pre-wrap break-all px-1', LINE_CLASSES[line.kind])}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}
