import { useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { relativeTime, type AttentionItemDto } from '../lib/api';
import {
  attentionKindMeta,
  openTargetFor,
  TONE_ACCENT,
  TONE_CHIP,
  type OpenTarget,
} from '../lib/attention-kind';
import { projectDisplayName } from '../lib/projects';
import {
  dispatcherDone,
  dispatcherPayload,
  queuedTasksLabel,
  type DispatcherPayload,
} from '../lib/dispatcher-proposal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AttentionRowProps {
  item: AttentionItemDto;
  busy?: boolean;
  onOpen: (target: OpenTarget) => void;
  onApprove: (id: string, proposalCount: number) => void;
  onResolve: (id: string) => void;
  /** Spawn-task chip: one-tap spin the follow-up into its own session. */
  onCreate?: (id: string) => void;
}

/** A row carries at most two actions: one primary (Open/Approve/Create) plus Dismiss. */
export function AttentionRow({ item, busy, onOpen, onApprove, onResolve, onCreate }: AttentionRowProps) {
  const meta = attentionKindMeta(item.kind);
  const Icon = meta.icon;
  const target = item.kind === 'missed-schedule' ? null : openTargetFor(item);
  const acked = item.acknowledgedAt !== null;
  const external = target !== null && 'href' in target;
  const dispatcher = dispatcherPayload(item);
  const isDispatcher = item.kind === 'dispatcher-proposal' && dispatcher.proposals.length > 0;
  const isSpawnTask = item.kind === 'spawn-task';
  const spawnTaskTldr = isSpawnTask ? payloadText(item, 'tldr') : null;
  const approved = dispatcherDone(dispatcher);
  const project = isDispatcher ? null : projectDisplayName(item.projectPath);

  return (
    <li
      className={cn(
        'relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card pl-4 pr-3 py-3 sm:flex-row sm:items-center',
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
          {approved && <span className="text-ui-sm text-success">Done</span>}
        </div>
        {isDispatcher ? (
          <DispatcherProposalSummary payload={dispatcher} />
        ) : (
          <>
            <p className="mt-1.5 text-ui-lg font-medium text-foreground">{item.title}</p>
            {spawnTaskTldr && (
              <p className="mt-0.5 text-ui-sm text-muted-foreground line-clamp-2">{spawnTaskTldr}</p>
            )}
          </>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-sm text-muted-foreground">
          {project && <span className="truncate">{project}</span>}
          {project && <span aria-hidden>·</span>}
          <span className="tabular-nums">{relativeTime(item.createdAt)}</span>
        </div>
      </div>

      {/* Actions — always visible (no hover), tap-sized for phone. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2.5 text-muted-foreground"
          disabled={busy}
          onClick={() => onResolve(item.id)}
          aria-label={`Dismiss "${item.title}"`}
        >
          Dismiss
        </Button>
        {isDispatcher && !approved && (
          <Button
            size="sm"
            className="min-h-11 gap-1.5 px-3"
            disabled={busy}
            onClick={() => onApprove(item.id, dispatcher.proposals.length)}
            aria-label={`Approve ${dispatcher.proposals.length} dispatcher proposal${dispatcher.proposals.length === 1 ? '' : 's'}`}
          >
            Approve
          </Button>
        )}
        {target && !isDispatcher && !isSpawnTask && (
          <Button
            size="sm"
            className="min-h-11 gap-1.5 px-3"
            disabled={busy}
            onClick={() => onOpen(target)}
            aria-label={`Open "${item.title}"`}
          >
            Open
            {external ? <ExternalLink className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
          </Button>
        )}
        {isSpawnTask && onCreate && (
          <Button
            size="sm"
            className="min-h-11 gap-1.5 px-3"
            disabled={busy}
            onClick={() => onCreate(item.id)}
            aria-label={`Create a session for "${item.title}"`}
          >
            Create
            <ArrowUpRight className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function DispatcherProposalSummary({
  payload,
}: {
  payload: DispatcherPayload;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = payload.proposals.length;
  const done = dispatcherDone(payload);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-ui-lg font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} dispatcher proposals`}
      >
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="truncate">
          {done
            ? `Done - ${queuedTasksLabel(payload.taskIds.length || count)}`
            : `Tomorrow's plan - ${count} proposal${count === 1 ? '' : 's'}`}
        </span>
      </button>
      {!done && (
        <p className="mt-1 text-ui-sm text-muted-foreground">
          Approve queues {count} task{count === 1 ? '' : 's'} to run tonight
        </p>
      )}
      {expanded && (
        <ul className="mt-3 space-y-2">
          {payload.proposals.map((proposal, idx) => (
            <li key={`${proposal.title}:${proposal.projectPath ?? 'none'}:${idx}`} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
              <p className="text-ui font-medium text-foreground">{proposal.title}</p>
              <p className="mt-0.5 text-ui-sm text-muted-foreground">{projectDisplayName(proposal.projectPath) ?? 'No project'}</p>
              <p className="mt-1 line-clamp-1 text-ui-sm text-muted-foreground">{proposal.rationale}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Read a trimmed string field off an item's payload, or null. */
function payloadText(item: AttentionItemDto, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
