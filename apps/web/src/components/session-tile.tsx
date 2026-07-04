import { useMemo, useRef, useState } from 'react';
import { Maximize2, Send, X } from 'lucide-react';
import type { Session, SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import { isComposingEvent } from '../lib/keyboard';
import { useSessionStream } from '../lib/use-session-stream';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { useTranscriptBlocks } from '../lib/use-transcript-blocks';
import { derivePendingUserInput } from '../lib/derive-pending-user-input';
import { deriveVerifyStatus } from '../lib/derive-verify-status';
import { VerifyChip } from './verify-chip';
import { projectDisplayName } from '../lib/projects';
import { prettyModelName } from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { summarizeToolGroup } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';

/** Only the freshest blocks are rendered in a tile — LOD, not the full transcript. */
const TILE_TAIL_LENGTH = 30;
/** LOD tiles only render a block tail; cap the event window they subscribe to. */
const TILE_EVENT_TAIL = 300;

interface SessionTileProps {
  session: Session;
  focused: boolean;
  onFocus: () => void;
  onMaximize: () => void;
  /** Unbind this tile from its Workbench slot — frees the slot back to a "new
   *  agent" composer. Non-destructive: the session stays in the sidebar. Grid only. */
  onClose?: () => void;
  /** Steer callback, wired only for the focused tile's single-line composer. */
  onSteer?: (message: string) => Promise<void>;
  steering?: boolean;
  /** Origin-absolute API base when the session lives on another hub machine. */
  apiBase?: string;
}

/**
 * Border encodes tile state, with a fixed precedence (founder-locked):
 *   focused ring > pending-input amber pulse > run-state color.
 * Non-focused tiles carry the state color at a lower intensity.
 */
function borderClasses(status: SessionStatus, pending: boolean, focused: boolean): string {
  if (pending) {
    return cn(
      'border-warning ring-1 ring-warning/50 animate-pulse',
      focused && 'ring-2 ring-warning shadow-e2',
    );
  }
  const stateColor: Record<SessionStatus, string> = {
    RUNNING: 'border-success/70',
    ERROR: 'border-destructive',
    IDLE: 'border-border',
    CREATED: 'border-border',
    PAUSED: 'border-border',
    ARCHIVED: 'border-border',
  };
  // Resting elevation (shadow-e1) comes from the base className; focus lifts it
  // to shadow-e2 while the ring still encodes the focus state.
  return cn(
    stateColor[status],
    focused
      ? 'ring-2 ring-ring border-ring shadow-e2'
      : status === 'RUNNING'
        ? 'ring-1 ring-success/25'
        : '',
  );
}

/** Latest status reported by the stream wins over the (possibly stale) list row. */
function effectiveStatus(events: ReturnType<typeof useSessionStream>['events'], fallback: SessionStatus): SessionStatus {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'status') continue;
    const value = event.payload.status;
    if (typeof value === 'string') return value as SessionStatus;
  }
  return fallback;
}

export function SessionTile({
  session,
  focused,
  onFocus,
  onMaximize,
  onClose,
  onSteer,
  steering,
  apiBase = '',
}: SessionTileProps) {
  const { events } = useSessionStream(session.id, apiBase, TILE_EVENT_TAIL);
  const blocks = useTranscriptBlocks(events);
  const tail = useMemo(() => blocks.slice(-TILE_TAIL_LENGTH), [blocks]);
  const items = useMemo(() => groupTileItems(tail), [tail]);
  const pending = useMemo(() => derivePendingUserInput(events).length > 0, [events]);
  const verifyStatus = useMemo(() => deriveVerifyStatus(events), [events]);
  const status = effectiveStatus(events, session.status);
  const [steerText, setSteerText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the tail pinned to the newest block as the stream grows.
  useStickToBottom(scrollRef, tail, { always: true });

  const projectName = projectDisplayName(session.projectPath);
  const modelName = session.model ? prettyModelName(session.model) : null;

  const submitSteer = async () => {
    const text = steerText.trim();
    if (!text || !onSteer || steering) return;
    setSteerText('');
    try {
      await onSteer(text);
    } catch (error) {
      // Give the message back rather than losing it on a failed send.
      setSteerText((current) => (current.trim() ? current : text));
      throw error;
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        // Only keys aimed at the tile itself — never swallow typing that
        // bubbles up from the steer input (Space would otherwise be eaten).
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
      aria-label={`Session ${session.title}${focused ? ' (focused)' : ''}`}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'group flex flex-col min-h-0 min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground',
        'shadow-e1 surface-lit hover:shadow-e2 hover:-translate-y-px',
        'transition-[box-shadow,border-color,translate] outline-none active:scale-[0.995]',
        'focus-visible:ring-2 focus-visible:ring-ring',
        borderClasses(status, pending, focused),
      )}
    >
      <header
        onDoubleClick={(e) => {
          e.stopPropagation();
          onMaximize();
        }}
        className="flex items-center gap-2 border-b border-border/60 px-3 py-2 shrink-0"
      >
        <StatusDot status={status} className="shrink-0" />
        <span
          className="shrink-0 leading-none text-muted-foreground"
          aria-label={`${session.provider} provider`}
        >
          <ProviderIcon providerId={session.provider} className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium leading-tight">{session.title}</span>
            <VerifyChip status={verifyStatus} />
          </div>
          <div className="truncate text-[11px] text-muted-foreground leading-tight">
            {pending ? (
              <span className="text-warning">Waiting for you</span>
            ) : (
              <>
                {projectName ?? 'Chat'}
                {modelName ? ` · ${modelName}` : ''}
                {` · ${statusLabel(status)}`}
              </>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          aria-label={`Maximize ${session.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onMaximize();
          }}
        >
          <Maximize2 className="size-3.5" />
        </Button>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Remove ${session.title} from the workbench slot`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed"
      >
        {tail.length === 0 ? (
          <p className="text-muted-foreground italic">No output yet.</p>
        ) : (
          // min-h-full + justify-end: a short tail hugs the steer input at the
          // bottom (chat-style) instead of stranding a gap in the middle.
          <div className="flex min-h-full flex-col justify-end gap-1.5">
            {items.map((item, i) =>
              item.kind === 'tool-group' ? (
                <p key={i} className="truncate text-[11px] text-muted-foreground/90">
                  {item.summary}
                </p>
              ) : (
                <TileBlock key={i} block={item.block} />
              ),
            )}
          </div>
        )}
      </div>

      {onSteer ? (
        <div className="flex items-center gap-1.5 border-t border-border/60 p-2 shrink-0">
          <Input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isComposingEvent(e)) {
                e.preventDefault();
                void submitSteer();
              }
            }}
            placeholder="Steer this agent…"
            aria-label={`Steer ${session.title}`}
            className="h-8 text-[12px]"
            disabled={steering}
          />
          <Button
            type="button"
            size="icon-sm"
            className="size-8 shrink-0"
            aria-label="Send steer message"
            disabled={steering || steerText.trim().length === 0}
            onClick={() => void submitSteer()}
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type TileBlockItem = ReturnType<typeof useTranscriptBlocks>[number];
type TileItem =
  | { kind: 'block'; block: TileBlockItem }
  | { kind: 'tool-group'; summary: string };

/**
 * Collapse consecutive tool calls into one summary line. A tile is a glanceable
 * preview, so a run of tools reads as "Ran 2 commands" (matching the detail
 * view) instead of N raw command lines flooding the tail. Single, isolated
 * tools keep their verb+subject line.
 */
function groupTileItems(blocks: TileBlockItem[]): TileItem[] {
  const out: TileItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === 'tool') {
      const group: Array<{ tool: string; input?: unknown }> = [];
      while (i < blocks.length) {
        const b = blocks[i];
        if (b.kind !== 'tool') break;
        group.push({ tool: b.tool, input: b.input });
        i += 1;
      }
      if (group.length === 1) out.push({ kind: 'block', block });
      else out.push({ kind: 'tool-group', summary: summarizeToolGroup(group) });
    } else {
      out.push({ kind: 'block', block });
      i += 1;
    }
  }
  return out;
}

/** Compact single-line-ish rendering of a transcript block for the tail. */
function TileBlock({ block }: { block: TileBlockItem }) {
  switch (block.kind) {
    case 'user':
      return (
        <p className="text-muted-foreground line-clamp-2 break-words">
          <span className="text-foreground/70">›</span> {block.text}
          {block.queued ? <span className="text-muted-foreground/70"> (queued)</span> : null}
        </p>
      );
    case 'interrupted':
      return <p className="text-muted-foreground/70 italic">— interrupted —</p>;
    // Collapse whitespace + clamp: a tile is a level-of-detail PREVIEW, so no
    // single block (e.g. a pasted log or long reply) may grow into a wall.
    case 'assistant':
      return <p className="text-foreground/90 break-words line-clamp-3">{block.text}</p>;
    case 'thinking':
      return <p className="text-muted-foreground/70 italic truncate">thinking…</p>;
    case 'tool':
      return (
        <p className="text-muted-foreground font-mono text-[11px] truncate">
          <span className="text-foreground/60">{block.summary.verb || block.tool}</span>
          {block.summary.subject ? ` ${block.summary.subject}` : ''}
        </p>
      );
    case 'user_input':
      return <p className="text-warning">Needs your input: {block.title ?? 'question'}</p>;
    case 'provider_request':
      return <p className="text-info">Permission request ({block.method})</p>;
    case 'error':
      return <p className="text-destructive break-words line-clamp-2">{block.message}</p>;
    case 'cursor-context':
      return <p className="text-muted-foreground/70 italic truncate">{block.summary}</p>;
    default:
      return null;
  }
}
