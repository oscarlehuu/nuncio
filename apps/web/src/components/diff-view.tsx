import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useAppearancePreference } from './appearance-provider';

interface DiffViewProps {
  /** Unified diff text: `diff --git` headers and/or `@@` hunks. */
  diff: string;
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

/* Symbol mode: drop the colored fills and lean on the +/- glyphs the diff text
 * already carries, for readers who parse structure over color. */
const SYMBOL_LINE_CLASSES: Record<DiffLineKind, string> = {
  hunk: 'text-muted-foreground font-medium',
  add: 'text-foreground/90',
  del: 'text-foreground/60',
  meta: 'text-muted-foreground',
  context: 'text-foreground/80',
};

/** Shared unified-diff renderer for local changes and forge PR files. */
export function DiffView({ diff, className }: DiffViewProps) {
  const { diffMarkers } = useAppearancePreference();
  const lines = useMemo(() => parseDiffLines(diff), [diff]);
  const lineClasses = diffMarkers === 'symbol' ? SYMBOL_LINE_CLASSES : LINE_CLASSES;

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
        'code-text max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono leading-5',
        className,
      )}
    >
      {lines.map((line, index) => (
        <div key={index} className={cn('whitespace-pre-wrap break-all px-1', lineClasses[line.kind])}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}
