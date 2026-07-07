import { ArrowUpRight, Check, ExternalLink } from 'lucide-react';
import { relativeTime, type AttentionItemDto } from '../lib/api';
import {
  attentionKindMeta,
  openTargetFor,
  TONE_ACCENT,
  TONE_CHIP,
  type OpenTarget,
} from '../lib/attention-kind';
import { projectDisplayName } from '../lib/projects';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AttentionRowProps {
  item: AttentionItemDto;
  busy?: boolean;
  onOpen: (target: OpenTarget) => void;
  onAck: (id: string) => void;
  onResolve: (id: string) => void;
}

export function AttentionRow({ item, busy, onOpen, onAck, onResolve }: AttentionRowProps) {
  const meta = attentionKindMeta(item.kind);
  const Icon = meta.icon;
  const project = projectDisplayName(item.projectPath);
  const target = openTargetFor(item);
  const acked = item.acknowledgedAt !== null;
  const external = target !== null && 'href' in target;

  return (
    <li
      className={cn(
        'surface-lit relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card pl-4 pr-3 py-3 shadow-e1 sm:flex-row sm:items-center',
        acked && 'opacity-65',
      )}
    >
      {/* Severity-tinted left accent — amber for the needs-you class, quiet for review. */}
      <span className={cn('absolute inset-y-0 left-0 w-1', TONE_ACCENT[meta.tone])} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-ui-sm font-medium',
              TONE_CHIP[meta.tone],
            )}
          >
            <Icon className="size-3 shrink-0" />
            {meta.label}
          </span>
          {acked && <span className="text-ui-sm text-muted-foreground">Seen</span>}
        </div>
        <p className="mt-1.5 text-ui-lg font-medium text-foreground">{item.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-sm text-muted-foreground">
          {project && <span className="truncate">{project}</span>}
          {project && <span aria-hidden>·</span>}
          <span className="tabular-nums">{relativeTime(item.createdAt)}</span>
        </div>
      </div>

      {/* Actions — always visible (no hover), tap-sized for phone. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {!acked && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2.5"
            disabled={busy}
            onClick={() => onAck(item.id)}
            aria-label={`Mark "${item.title}" seen`}
          >
            <Check className="size-3.5" />
            <span className="hidden sm:inline">Seen</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2.5 text-muted-foreground"
          disabled={busy}
          onClick={() => onResolve(item.id)}
          aria-label={`Dismiss "${item.title}"`}
        >
          Dismiss
        </Button>
        {target && (
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3"
            disabled={busy}
            onClick={() => onOpen(target)}
            aria-label={`Open "${item.title}"`}
          >
            Open
            {external ? <ExternalLink className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
          </Button>
        )}
      </div>
    </li>
  );
}
