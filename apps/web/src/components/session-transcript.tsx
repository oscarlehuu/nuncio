import { Fragment, memo, useMemo } from 'react';
import type { ProviderRequestDecision, SessionEvent } from '../lib/api';
import {
  buildTranscriptBlocks,
  workingIndicatorLabel,
  type TranscriptBlock,
} from '../lib/transcript-build-blocks';
import { ThinkingBlock } from './transcript-blocks/thinking-block';
import { ToolGroup, type ToolGroupTool } from './transcript-blocks/tool-group';
import { CursorContextBlock } from './transcript-blocks/cursor-context-block';
import { ProviderRequestCard } from './provider-request-card';
import {
  AssistantBubble,
  ErrorBlock,
  UserBubble,
} from './transcript-blocks/transcript-bubbles';

interface TranscriptProps {
  events: SessionEvent[];
  streaming?: boolean;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
}

type RenderItem =
  | { type: 'block'; block: TranscriptBlock }
  | { type: 'tool-group'; tools: ToolGroupTool[] };

function groupConsecutiveTools(blocks: TranscriptBlock[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === 'tool') {
      const tools: ToolGroupTool[] = [];
      while (i < blocks.length && blocks[i].kind === 'tool') {
        const t = blocks[i] as Extract<TranscriptBlock, { kind: 'tool' }>;
        tools.push({
          callId: t.callId,
          tool: t.tool,
          status: t.status,
          summary: t.summary,
          ...(t.input !== undefined ? { input: t.input } : {}),
          ...(t.output !== undefined ? { output: t.output } : {}),
        });
        i++;
      }
      out.push({ type: 'tool-group', tools });
    } else {
      out.push({ type: 'block', block });
      i++;
    }
  }
  return out;
}

export function WorkingIndicator({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted-foreground"
      data-testid="working-indicator"
    >
      <span className="size-1.5 rounded-full bg-primary animate-pulse shrink-0" />
      <span>{label}</span>
    </div>
  );
}

function UserBlock({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[90%] px-3 py-2 rounded-[12px_12px_4px_12px] text-[14px] leading-relaxed bg-muted/25 text-foreground/90">
        <UserBubble text={text} />
      </div>
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="text-[14px] leading-relaxed text-foreground">
      <AssistantBubble text={text} streaming={streaming} />
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="text-[14px] text-destructive">
      <ErrorBlock message={message} />
    </div>
  );
}

function RenderItemView({
  item,
  streaming,
  respondingRequestId,
  onRespondProviderRequest,
}: {
  item: RenderItem;
  streaming?: boolean;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: TranscriptProps['onRespondProviderRequest'];
}) {
  if (item.type === 'tool-group') {
    return <ToolGroup tools={item.tools} />;
  }
  const block = item.block;
  switch (block.kind) {
    case 'user':
      return <UserBlock text={block.text} />;
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
    case 'provider_request':
      return (
        <ProviderRequestCard
          request={block}
          responding={respondingRequestId === block.requestId}
          onRespond={onRespondProviderRequest}
        />
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

export const Transcript = memo(function Transcript({
  events,
  streaming,
  respondingRequestId,
  onRespondProviderRequest,
}: TranscriptProps) {
  const blocks = useMemo(() => buildTranscriptBlocks(events), [events]);
  const items = useMemo(() => groupConsecutiveTools(blocks), [blocks]);
  const indicatorLabel = workingIndicatorLabel(blocks, streaming ?? false);

  const indicatorIndex = useMemo(() => {
    if (!streaming) return -1;
    let lastUser = -1;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'block' && item.block.kind === 'user') lastUser = i;
    }
    return lastUser === -1 ? items.length : lastUser + 1;
  }, [items, streaming]);

  return (
    <div className="flex flex-col gap-1.5 py-2">
      {items.map((item, i) => (
        <Fragment key={`item-${i}`}>
          {i === indicatorIndex && <WorkingIndicator label={indicatorLabel} />}
          <RenderItemView
            item={item}
            streaming={streaming}
            respondingRequestId={respondingRequestId}
            onRespondProviderRequest={onRespondProviderRequest}
          />
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
