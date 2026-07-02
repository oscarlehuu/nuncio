import { Fragment, memo, useMemo, useRef } from 'react';
import type { ProviderRequestDecision, SessionEvent } from '../lib/api';
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
import { ProviderRequestCard } from './provider-request-card';
import {
  AssistantBubble,
  ErrorBlock,
  UserBubble,
} from './transcript-blocks/transcript-bubbles';

interface TranscriptProps {
  events: SessionEvent[];
  streaming?: boolean;
  pendingRequestIds?: ReadonlySet<string>;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
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

function UserBlock({ text, queued }: { text: string; queued?: boolean }) {
  return (
    <div className="flex flex-col items-end">
      <div
        className={`max-w-[90%] px-3 py-[var(--chat-msg-py)] rounded-[12px_12px_4px_12px] chat-text-body leading-relaxed bg-muted/25 text-foreground/90 ${queued ? 'opacity-70 border border-dashed border-border' : ''}`}
      >
        <UserBubble text={text} />
        {queued && (
          <div className="mt-1 text-[length:calc(11px*var(--chat-font-scale))] text-muted-foreground">
            Queued — sends when the agent is ready
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-text-body leading-relaxed text-foreground">
      <AssistantBubble text={text} streaming={streaming} />
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
  streaming?: boolean;
  pendingRequestIds?: ReadonlySet<string>;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: TranscriptProps['onRespondProviderRequest'];
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
  streaming,
  pendingRequestIds,
  respondingRequestId,
  onRespondProviderRequest,
}: RenderItemViewProps) {
  if (item.type === 'tool-group') {
    return <ToolGroup tools={item.tools} />;
  }
  const block = item.block;
  switch (block.kind) {
    case 'user':
      return <UserBlock text={block.text} queued={block.queued} />;
    case 'assistant':
      return <AssistantBlock text={block.text} streaming={streaming && block.streaming} />;
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
    case 'user_input':
      return (
        <UserInputBlock
          requestId={block.requestId}
          questions={block.questions}
          defaultOpen={pendingRequestIds?.has(block.requestId)}
          {...(block.title ? { title: block.title } : {})}
          {...(block.resolvedBy ? { resolvedBy: block.resolvedBy } : {})}
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
  if (prev.streaming !== next.streaming) return false;
  if (prev.onRespondProviderRequest !== next.onRespondProviderRequest) return false;
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
  streaming,
  pendingRequestIds,
  respondingRequestId,
  onRespondProviderRequest,
}: TranscriptProps) {
  const blocks = useTranscriptBlocks(events);
  const itemCacheRef = useRef(new Map<string, RenderItem>());
  const items = useMemo(() => {
    const next = groupConsecutiveTools(blocks, itemCacheRef.current);
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

  return (
    <div className="flex flex-col gap-[var(--chat-gap)] py-2">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i === indicatorIndex && <WorkingIndicator label={indicatorLabel} />}
          {/* content-visibility keeps long-session offscreen blocks unrendered. */}
          <div className="[content-visibility:auto] [contain-intrinsic-size:auto_60px]">
            <MemoRenderItemView
              item={item}
              streaming={streaming}
              pendingRequestIds={pendingRequestIds}
              respondingRequestId={respondingRequestId}
              onRespondProviderRequest={onRespondProviderRequest}
            />
          </div>
        </Fragment>
      ))}
      {streaming && indicatorIndex >= items.length && (
        <WorkingIndicator label={indicatorLabel} />
      )}
    </div>
  );
});

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
