import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Maximize2, Send, X } from 'lucide-react';
import type { Session, SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';
import { hasSelectionInside } from '../lib/auto-copy-selection';
import { isComposingEvent } from '../lib/keyboard';
import { DETAIL_EVENT_TAIL, useSessionStream } from '../lib/use-session-stream';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { derivePendingUserInput } from '../lib/derive-pending-user-input';
import { derivePlan, planProgress } from '../lib/derive-plan';
import { deriveVerifyStatus } from '../lib/derive-verify-status';
import { VerifyChip } from './verify-chip';
import { projectDisplayName } from '../lib/projects';
import { prettyModelName } from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Transcript } from './session-transcript';

interface SessionTileProps {
  session: Session;
  focused: boolean;
  onFocus: () => void;
  /** Maximize this tile. Receives the tile's on-screen rect so the full view can
   *  grow from (and shrink back to) exactly this slot. */
  onMaximize: (rect: DOMRect) => void;
  /** Grid slot index — exposed as data-slot for keyboard-maximize and
   *  restore-focus lookups from the grid. */
  slotIndex?: number;
  /** Unbind this tile from its Workbench slot — frees the slot back to a "new
   *  agent" composer. Non-destructive: the session stays in the sidebar. Grid only. */
  onClose?: () => void;
  /** Steer callback, wired only for the focused tile's single-line composer. */
  onSteer?: (message: string) => Promise<void>;
  steering?: boolean;
  onSessionStatus?: (id: string, status: SessionStatus, createdAt: number) => void;
  onSessionTitle?: (id: string, title: string, createdAt: number) => void;
  /** Origin-absolute API base when the session lives on another hub machine. */
  apiBase?: string;
}

/**
 * Tile state maps to three independent visual channels so they never mask each
 * other:
 *   - border color + a breathing glow (.tile-glow) = activity
 *       waiting-for-input → amber, a larger + quicker breath (pulls the eye)
 *       running           → neutral hairline, a faint gray breath
 *       error             → red, no breath
 *       idle/paused/…      → dim hairline
 *   - a ring + lift = focus (which tile the keyboard drives), layered on top
 * The --glow-* custom properties (see glowStyle) drive the breath color/size/speed.
 */
function tileStateClasses(status: SessionStatus, pending: boolean, focused: boolean): string {
  let activity: string;
  if (pending) activity = 'border-warning tile-glow';
  else if (status === 'RUNNING') activity = 'border-border tile-glow';
  else if (status === 'ERROR') activity = 'border-destructive';
  else activity = 'border-border/60';
  return cn(activity, focused && 'ring-2 ring-ring shadow-e2');
}

/** Breath color/intensity for the active tile states; undefined = no breath. */
function glowStyle(status: SessionStatus, pending: boolean): CSSProperties | undefined {
  if (pending) {
    return { '--glow-color': 'var(--color-warning)', '--glow-size': '22px', '--glow-speed': '1.9s' } as CSSProperties;
  }
  if (status === 'RUNNING') {
    // Working is calm: a faint foreground-tinted breath, never a color summons.
    return { '--glow-color': 'color-mix(in oklch, var(--foreground) 30%, transparent)' } as CSSProperties;
  }
  return undefined;
}

/** Latest status reported by the stream wins over the (possibly stale) list row. */
function latestStatusEvent(
  events: ReturnType<typeof useSessionStream>['events'],
): { status: SessionStatus; createdAt: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'status') continue;
    const value = event.payload.status;
    if (typeof value === 'string') return { status: value as SessionStatus, createdAt: event.createdAt };
  }
  return null;
}

function latestTitleEvent(
  events: ReturnType<typeof useSessionStream>['events'],
): { title: string; createdAt: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'session_title') continue;
    const title = asSessionTitle(event.payload);
    if (title) return { title, createdAt: event.createdAt };
  }
  return null;
}

function asSessionTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const title = (payload as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

export function SessionTile({
  session,
  focused,
  onFocus,
  onMaximize,
  slotIndex,
  onClose,
  onSteer,
  steering,
  onSessionStatus,
  onSessionTitle,
  apiBase = '',
}: SessionTileProps) {
  const { events, loadEarlier, hasEarlier } = useSessionStream(session.id, apiBase, DETAIL_EVENT_TAIL);
  const pending = useMemo(() => derivePendingUserInput(events).length > 0, [events]);
  const plan = useMemo(() => derivePlan(events), [events]);
  const verifyStatus = useMemo(() => deriveVerifyStatus(events), [events]);
  const latestStatus = latestStatusEvent(events);
  const latestStatusValue = latestStatus?.status;
  const latestStatusCreatedAt = latestStatus?.createdAt;
  const latestTitle = latestTitleEvent(events);
  const latestTitleValue = latestTitle?.title;
  const latestTitleCreatedAt = latestTitle?.createdAt;
  const status = latestStatus?.status ?? session.status;
  const [steerText, setSteerText] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const steerRef = useRef<HTMLInputElement>(null);
  const maximize = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) onMaximize(rect);
  };

  // Start each tile at the latest message, then respect manual scrollback.
  useStickToBottom(scrollRef, events, { resetKey: session.id });

  useEffect(() => {
    if (!latestStatusValue || latestStatusCreatedAt === undefined || !onSessionStatus) return;
    onSessionStatus(session.id, latestStatusValue, latestStatusCreatedAt);
  }, [latestStatusCreatedAt, latestStatusValue, onSessionStatus, session.id]);

  useEffect(() => {
    if (!latestTitleValue || latestTitleCreatedAt === undefined || !onSessionTitle) return;
    onSessionTitle(session.id, latestTitleValue, latestTitleCreatedAt);
  }, [latestTitleCreatedAt, latestTitleValue, onSessionTitle, session.id]);

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
      ref={rootRef}
      data-grid-slot={slotIndex}
      role="button"
      tabIndex={0}
      onClick={() => {
        // Selecting a tile in the workbench lands the caret in its composer so
        // the user can type straight away — unless this click just finished a
        // text selection (focusing the input would clear the highlight).
        onFocus();
        if (hasSelectionInside(rootRef.current)) return;
        steerRef.current?.focus({ preventScroll: true });
      }}
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
      style={glowStyle(status, pending)}
      className={cn(
        'group flex flex-col min-h-0 min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground',
        'shadow-e1 surface-lit hover:shadow-e2 hover:-translate-y-0.5',
        'transition-[box-shadow,border-color,translate] outline-none active:scale-[0.995]',
        'focus-visible:ring-2 focus-visible:ring-ring',
        tileStateClasses(status, pending, focused),
      )}
    >
      <header
        onDoubleClick={(e) => {
          e.stopPropagation();
          maximize();
        }}
        className="flex items-center gap-2 border-b border-border/60 px-3 py-2 shrink-0"
      >
        <StatusDot status={status} pending={pending} className="shrink-0" />
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
                {plan ? ` · ${planProgress(plan).done}/${planProgress(plan).total} steps` : ''}
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
            maximize();
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
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {events.length === 0 ? (
          <p className="text-muted-foreground italic">No output yet.</p>
        ) : (
          <div
            className="flex min-h-full flex-col justify-end [--chat-font-scale:0.88] [--chat-gap:0.3rem] [--chat-msg-py:0.35rem]"
          >
            {hasEarlier ? (
              <div className="flex justify-center pb-1 pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-6 text-[11px] text-muted-foreground"
                  disabled={loadingEarlier}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setLoadingEarlier(true);
                    try {
                      await loadEarlier();
                    } finally {
                      setLoadingEarlier(false);
                    }
                  }}
                >
                  {loadingEarlier ? 'Loading...' : 'Load earlier history'}
                </Button>
              </div>
            ) : null}
            <Transcript
              events={events}
              sessionId={session.id}
              apiBase={apiBase}
              streaming={status === 'RUNNING'}
            />
          </div>
        )}
      </div>

      {onSteer ? (
        <div className="flex items-center gap-1.5 border-t border-border/60 p-2 shrink-0">
          <Input
            ref={steerRef}
            data-steer-input=""
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
