import { Fragment, memo, useMemo, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TranscriptImage, ProviderRequestDecision, SessionEvent } from '../lib/api';
import { transcriptImageSrc } from '../lib/api';
import { ChatImage } from './chat-image';
import { ProviderIcon } from './provider-icon';
import {
  buildTranscriptBlocks,
  workingIndicatorLabel,
  type TranscriptBlock,
} from '../lib/transcript-build-blocks';
import { useTranscriptBlocks } from '../lib/use-transcript-blocks';
import { ThinkingBlock } from './transcript-blocks/thinking-block';
import { ToolGroup, type ToolGroupTool } from './transcript-blocks/tool-group';
import { CursorContextBlock } from './transcript-blocks/cursor-context-block';
import { UserInputBlock } from './transcript-blocks/user-input-block';
import { PlanBlock } from './transcript-blocks/plan-block';
import {
  VerifyNeedsAttentionRow,
  VerifyRetryRow,
} from './transcript-blocks/verify-rows';
import { ProviderRequestCard } from './provider-request-card';
import { TaskDigestCard } from './transcript-blocks/task-digest-card';
import {
  AssistantBubble,
  ErrorBlock,
  UserBubble,
} from './transcript-blocks/transcript-bubbles';
import type { MarkdownLinkClickHandler } from './markdown-view';

interface TranscriptProps {
  events: SessionEvent[];
  /** Owning session — used to resolve media-store image URLs in user messages. */
  sessionId: string;
  /** Origin-absolute API base when the transcript belongs to another hub machine. */
  apiBase?: string;
  streaming?: boolean;
  pendingRequestIds?: ReadonlySet<string>;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  onLinkClick?: MarkdownLinkClickHandler;
  /** Navigate to a child session from a delegation digest card's "Open session". */
  onOpenSession?: (sessionId: string) => void;
  /** Provider id (pi/codex/cursor…) — branded glyph shown as the assistant avatar. */
  provider?: string;
  /** Opt into the roomy focused-chat layout: assistant avatar gutter + turn rhythm.
   * Left off for compact previews (grid tiles) so they stay dense. */
  showAvatar?: boolean;
}

/** Branded provider glyph as the assistant's avatar — a small lifted chip that
 * anchors the start of each assistant turn. Falls back to a spark when the
 * provider is unknown. */
function AssistantAvatar({ provider }: { provider?: string }) {
  return (
    <div className="flex size-[22px] items-center justify-center rounded-lg border border-border/70 bg-card text-foreground/70 shadow-e0 surface-lit">
      {provider ? (
        <ProviderIcon providerId={provider} className="size-3" />
      ) : (
        <Sparkles className="size-3" aria-hidden />
      )}
    </div>
  );
}

type RenderItem =
  | { type: 'block'; key: string; block: TranscriptBlock }
  | {
      type: 'tool-group';
      key: string;
      tools: ToolGroupTool[];
      /** Source blocks — used to reuse the item when nothing in the group changed. */
      sourceBlocks: TranscriptBlock[];
    };

function groupConsecutiveTools(
  blocks: TranscriptBlock[],
  previous: Map<string, RenderItem>,
): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === 'tool') {
      const sourceBlocks: Extract<TranscriptBlock, { kind: 'tool' }>[] = [];
      while (i < blocks.length && blocks[i].kind === 'tool') {
        sourceBlocks.push(blocks[i] as Extract<TranscriptBlock, { kind: 'tool' }>);
        i++;
      }
      const key = `group-${sourceBlocks[0].key}`;
      const prior = previous.get(key);
      if (
        prior?.type === 'tool-group' &&
        prior.sourceBlocks.length === sourceBlocks.length &&
        prior.sourceBlocks.every((b, idx) => b === sourceBlocks[idx])
      ) {
        out.push(prior);
        continue;
      }
      out.push({
        type: 'tool-group',
        key,
        sourceBlocks,
        tools: sourceBlocks.map((t) => ({
          callId: t.callId,
          tool: t.tool,
          status: t.status,
          summary: t.summary,
          ...(t.input !== undefined ? { input: t.input } : {}),
          ...(t.output !== undefined ? { output: t.output } : {}),
        })),
      });
    } else {
      const prior = previous.get(block.key);
      if (prior?.type === 'block' && prior.block === block) {
        out.push(prior);
      } else {
        out.push({ type: 'block', key: block.key, block });
      }
      i++;
    }
  }
  return out;
}

export function WorkingIndicator({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 chat-text-sm text-muted-foreground"
      data-testid="working-indicator"
    >
      <span className="size-1.5 rounded-full bg-primary animate-pulse shrink-0" />
      <span>{label}</span>
    </div>
  );
}

function UserBlock({
  text,
  queued,
  images,
  sessionId,
  apiBase = '',
  onLinkClick,
}: {
  text: string;
  queued?: boolean;
  images?: TranscriptImage[];
  sessionId: string;
  apiBase?: string;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  const hasImages = !!images && images.length > 0;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {hasImages && (
        <div className="flex max-w-[90%] flex-wrap justify-end gap-1.5">
          {images.map((image, i) => (
            <ChatImage
              key={i}
              src={transcriptImageSrc(image, sessionId, apiBase)}
              alt="Attached image"
              className="max-h-40"
            />
          ))}
        </div>
      )}
      {(text.length > 0 || !hasImages) && (
        <div
          className={cn(
            'max-w-[88%] px-3.5 py-[var(--chat-msg-py)] rounded-[14px_14px_5px_14px] chat-text-body leading-relaxed',
            'border border-border/60 bg-card text-foreground shadow-e0 surface-lit',
            queued && 'opacity-70 border-dashed',
          )}
        >
          <UserBubble text={text} onLinkClick={onLinkClick} />
          {queued && (
            <div className="mt-1 text-[length:calc(11px*var(--chat-font-scale))] text-muted-foreground">
              Queued — sends when the agent is ready
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({
  text,
  streaming,
  onLinkClick,
}: {
  text: string;
  streaming?: boolean;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  return (
    <div className="chat-text-body leading-relaxed text-foreground">
      <AssistantBubble text={text} streaming={streaming} onLinkClick={onLinkClick} />
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="chat-text-body text-destructive">
      <ErrorBlock message={message} />
    </div>
  );
}

interface RenderItemViewProps {
  item: RenderItem;
  sessionId: string;
  apiBase?: string;
  streaming?: boolean;
  pendingRequestIds?: ReadonlySet<string>;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: TranscriptProps['onRespondProviderRequest'];
  onLinkClick?: MarkdownLinkClickHandler;
  onOpenSession?: (sessionId: string) => void;
}

/** requestId this item cares about, when it renders interactive state. */
function itemRequestId(item: RenderItem): string | null {
  if (item.type !== 'block') return null;
  if (item.block.kind === 'user_input' || item.block.kind === 'provider_request') {
    return item.block.requestId;
  }
  return null;
}

function RenderItemView({
  item,
  sessionId,
  apiBase = '',
  streaming,
  pendingRequestIds,
  respondingRequestId,
  onRespondProviderRequest,
  onLinkClick,
  onOpenSession,
}: RenderItemViewProps) {
  if (item.type === 'tool-group') {
    return <ToolGroup tools={item.tools} />;
  }
  const block = item.block;
  switch (block.kind) {
    case 'user':
      return (
        <UserBlock
          text={block.text}
          queued={block.queued}
          images={block.images}
          sessionId={sessionId}
          apiBase={apiBase}
          onLinkClick={onLinkClick}
        />
      );
    case 'assistant':
      return (
        <AssistantBlock
          text={block.text}
          streaming={streaming && block.streaming}
          onLinkClick={onLinkClick}
        />
      );
    case 'tool':
      return (
        <ToolGroup
          tools={[
            {
              callId: block.callId,
              tool: block.tool,
              status: block.status,
              summary: block.summary,
              ...(block.input !== undefined ? { input: block.input } : {}),
              ...(block.output !== undefined ? { output: block.output } : {}),
            },
          ]}
        />
      );
    case 'thinking':
      return <ThinkingBlock text={block.text} streaming={streaming && block.streaming} />;
    case 'cursor-context':
      return (
        <CursorContextBlock
          summary={block.summary}
          instruction={block.instruction}
          sections={block.sections}
        />
      );
    case 'plan':
      return <PlanBlock items={block.items} />;
    case 'user_input':
      return (
        <UserInputBlock
          requestId={block.requestId}
          questions={block.questions}
          defaultOpen={pendingRequestIds?.has(block.requestId)}
          {...(block.title ? { title: block.title } : {})}
          {...(block.resolvedBy ? { resolvedBy: block.resolvedBy } : {})}
          {...(block.answers ? { answers: block.answers } : {})}
        />
      );
    case 'provider_request':
      return (
        <ProviderRequestCard
          request={block}
          responding={respondingRequestId === block.requestId}
          onRespond={onRespondProviderRequest}
        />
      );
    case 'interrupted':
      return (
        <div
          className="flex items-center gap-2 text-[length:calc(12px*var(--chat-font-scale))] text-muted-foreground"
          data-testid="interrupted-marker"
        >
          <span className="h-px flex-1 bg-border" />
          <span>Interrupted</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case 'verify_retry':
      return (
        <VerifyRetryRow
          round={block.round}
          {...(block.command ? { command: block.command } : {})}
        />
      );
    case 'verify_needs_attention':
      return (
        <VerifyNeedsAttentionRow
          rounds={block.rounds}
          reason={block.reason}
          {...(block.lastOutputTail ? { lastOutputTail: block.lastOutputTail } : {})}
        />
      );
    case 'task_completed':
      return <TaskDigestCard digest={block.digest} onOpenSession={onOpenSession} />;
    case 'error':
      return <ErrorRow message={block.message} />;
    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Memoized per-item renderer: unchanged blocks (stable item refs from the
 * incremental builder's checkpoint prefix) skip re-render entirely while a
 * sibling streams. Interactive items also compare their own pending/responding
 * state instead of the container sets' identity.
 */
const MemoRenderItemView = memo(RenderItemView, (prev, next) => {
  if (prev.item !== next.item) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.apiBase !== next.apiBase) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.onRespondProviderRequest !== next.onRespondProviderRequest) return false;
  if (prev.onLinkClick !== next.onLinkClick) return false;
  if (prev.onOpenSession !== next.onOpenSession) return false;
  const requestId = itemRequestId(next.item);
  if (requestId) {
    const wasPending = prev.pendingRequestIds?.has(requestId) ?? false;
    const isPending = next.pendingRequestIds?.has(requestId) ?? false;
    if (wasPending !== isPending) return false;
    if ((prev.respondingRequestId === requestId) !== (next.respondingRequestId === requestId)) {
      return false;
    }
  }
  return true;
});

export const Transcript = memo(function Transcript({
  events,
  sessionId,
  apiBase = '',
  streaming,
  pendingRequestIds,
  respondingRequestId,
  onRespondProviderRequest,
  onLinkClick,
  onOpenSession,
  provider,
  showAvatar = false,
}: TranscriptProps) {
  const blocks = useTranscriptBlocks(events);
  const itemCacheRef = useRef(new Map<string, RenderItem>());
  const items = useMemo(() => {
    // Queued steers live in the composer's queue panel, not inline — drop them here.
    const visible = blocks.filter((block) => !(block.kind === 'user' && block.queued));
    const next = groupConsecutiveTools(visible, itemCacheRef.current);
    itemCacheRef.current = new Map(next.map((item) => [item.key, item]));
    return next;
  }, [blocks]);
  const indicatorLabel = workingIndicatorLabel(blocks, streaming ?? false);

  const indicatorIndex = useMemo(() => {
    if (!streaming) return -1;
    let lastUser = -1;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'block' && item.block.kind === 'user' && !item.block.queued) lastUser = i;
    }
    return lastUser === -1 ? items.length : lastUser + 1;
  }, [items, streaming]);

  const isUserItem = (item: RenderItem) =>
    item.type === 'block' && item.block.kind === 'user';

  return (
    <div className={cn('flex flex-col py-2', !showAvatar && 'gap-[var(--chat-gap)]')}>
      {items.map((item, i) => {
        const view = (
          <MemoRenderItemView
            item={item}
            sessionId={sessionId}
            apiBase={apiBase}
            streaming={streaming}
            pendingRequestIds={pendingRequestIds}
            respondingRequestId={respondingRequestId}
            onRespondProviderRequest={onRespondProviderRequest}
            onLinkClick={onLinkClick}
            onOpenSession={onOpenSession}
          />
        );
        const isUser = isUserItem(item);
        // First agent-side row after a user message (or the very first row)
        // begins a new assistant turn and earns the avatar.
        const turnStart = !isUser && (i === 0 || isUserItem(items[i - 1]));
        // Extra breathing room separates exchanges without loosening tight
        // in-turn rows (thinking → tools → answer stay grouped).
        const rowMargin = !showAvatar
          ? undefined
          : isUser
            ? 'mt-4 first:mt-0'
            : turnStart
              ? 'mt-3 first:mt-0'
              : 'mt-[var(--chat-gap)]';
        return (
          <Fragment key={item.key}>
            {i === indicatorIndex && (
              <IndicatorRow label={indicatorLabel} withGutter={showAvatar} />
            )}
            {/* content-visibility keeps long-session offscreen blocks unrendered. */}
            <div
              className={cn(
                '[content-visibility:auto] [contain-intrinsic-size:auto_60px]',
                rowMargin,
              )}
            >
              {showAvatar && !isUser ? (
                <div className="flex gap-2.5">
                  <div className="w-[22px] shrink-0 pt-0.5">
                    {turnStart && <AssistantAvatar provider={provider} />}
                  </div>
                  <div className="min-w-0 flex-1">{view}</div>
                </div>
              ) : (
                view
              )}
            </div>
          </Fragment>
        );
      })}
      {streaming && indicatorIndex >= items.length && (
        <IndicatorRow
          label={indicatorLabel}
          withGutter={showAvatar}
          avatar={showAvatar}
          provider={provider}
        />
      )}
    </div>
  );
});

/** Working indicator, optionally slotted into the assistant avatar column so it
 * lines up with the agent's other rows (and shows the avatar on a fresh turn). */
function IndicatorRow({
  label,
  withGutter,
  avatar,
  provider,
}: {
  label: string;
  withGutter?: boolean;
  avatar?: boolean;
  provider?: string;
}) {
  if (!withGutter) return <WorkingIndicator label={label} />;
  return (
    <div className="flex gap-2.5">
      <div className="w-[22px] shrink-0 pt-0.5">
        {avatar && <AssistantAvatar provider={provider} />}
      </div>
      <div className="min-w-0 flex-1">
        <WorkingIndicator label={label} />
      </div>
    </div>
  );
}

/** @deprecated Use buildTranscriptBlocks — kept for test back-compat. */
export function buildMessages(events: SessionEvent[]) {
  return buildTranscriptBlocks(events)
    .filter((b) => b.kind === 'user' || b.kind === 'assistant')
    .map((b) => ({
      role: b.kind as 'user' | 'assistant',
      text: b.text,
      ...(b.kind === 'assistant' && b.streaming ? { streaming: true } : {}),
    }));
}
