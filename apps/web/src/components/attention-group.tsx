import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  attentionGroupLabel,
  attentionKindMeta,
  TONE_ACCENT,
  TONE_CHIP,
} from '../lib/attention-kind';
import { cn } from '@/lib/utils';

interface AttentionGroupProps {
  kind: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** Collapses only an already-consecutive server-ranked run. */
export function AttentionGroup({ kind, count, expanded, onToggle, children }: AttentionGroupProps) {
  const meta = attentionKindMeta(kind);
  const Icon = meta.icon;
  const summary = attentionGroupLabel(kind, count);

  return (
    <li className="relative overflow-hidden rounded-xl border border-border bg-card pl-4 pr-3 py-3">
      <span className={cn('absolute inset-y-0 left-0 w-1', TONE_ACCENT[meta.tone])} aria-hidden />
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} ${summary}`}
      >
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-ui-sm font-medium', TONE_CHIP[meta.tone])}>
          <Icon className="size-3 shrink-0" />
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-lg font-medium text-foreground">{summary}</span>
      </button>
      {expanded && <ul className="mt-3 flex flex-col gap-3">{children}</ul>}
    </li>
  );
}
