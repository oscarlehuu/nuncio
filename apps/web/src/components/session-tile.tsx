import { useMemo, useRef, useState, useEffect } from 'react';
import { Maximize2, Send } from 'lucide-react';
import type { Session, SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import { useSessionStream } from '../lib/use-session-stream';
import { useTranscriptBlocks } from '../lib/use-transcript-blocks';
import { derivePendingUserInput } from '../lib/derive-pending-user-input';
import { projectDisplayName } from '../lib/projects';
import { prettyModelName } from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
      focused && 'ring-2 ring-warning',
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
  return cn(
    stateColor[status],
    focused
      ? 'ring-2 ring-ring border-ring shadow-lg shadow-ring/10'
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
  onSteer,
  steering,
  apiBase = '',
}: SessionTileProps) {
  const { events } = useSessionStream(session.id, apiBase, TILE_EVENT_TAIL);
  const blocks = useTranscriptBlocks(events);
  const tail = useMemo(() => blocks.slice(-TILE_TAIL_LENGTH), [blocks]);
  const pending = useMemo(() => derivePendingUserInput(events).length > 0, [events]);
  const status = effectiveStatus(events, session.status);
  const [steerText, setSteerText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the tail pinned to the newest block as the stream grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const projectName = projectDisplayName(session.projectPath);
  const modelName = session.model ? prettyModelName(session.model) : null;

  const submitSteer = async () => {
    const text = steerText.trim();
    if (!text || !onSteer || steering) return;
    setSteerText('');
    await onSteer(text);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
      aria-label={`Session ${session.title}${focused ? ' (focused)' : ''}`}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'group flex flex-col min-h-0 min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground',
        'transition-[box-shadow,border-color] outline-none active:scale-[0.995]',
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
          <div className="truncate text-[13px] font-medium leading-tight">{session.title}</div>
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
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed"
      >
        {tail.length === 0 ? (
          <p className="text-muted-foreground italic">No output yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tail.map((block, i) => (
              <TileBlock key={i} block={block} />
            ))}
          </div>
        )}
      </div>

      {focused && onSteer ? (
        <div
          className="flex items-center gap-1.5 border-t border-border/60 p-2 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
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

/** Compact single-line-ish rendering of a transcript block for the tail. */
function TileBlock({ block }: { block: ReturnType<typeof useTranscriptBlocks>[number] }) {
  switch (block.kind) {
    case 'user':
      return <p className="text-muted-foreground"><span className="text-foreground/70">›</span> {block.text}</p>;
    case 'assistant':
      return <p className="text-foreground/90 whitespace-pre-wrap break-words">{block.text}</p>;
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
      return <p className="text-destructive break-words">{block.message}</p>;
    case 'cursor-context':
      return <p className="text-muted-foreground/70 italic truncate">{block.summary}</p>;
    default:
      return null;
  }
}
