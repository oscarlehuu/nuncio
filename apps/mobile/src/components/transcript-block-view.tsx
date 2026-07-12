import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TranscriptBlock } from '@nuncio/core/transcript-build-blocks';
import { MarkdownText } from './markdown-text';
import { PlanBlockView } from './plan-block-view';
import { QuestionCard } from './question-card';

function ToolRow({ block }: { block: Extract<TranscriptBlock, { kind: 'tool' }> }) {
  const color =
    block.status === 'error' ? 'text-destructive' : block.status === 'running' ? 'text-ring' : 'text-muted-foreground';
  return (
    <View className="my-1 rounded-lg border border-border bg-card px-3 py-2">
      <Text className={`text-xs ${color}`} numberOfLines={2}>
        {block.status === 'running' ? '⏳' : block.status === 'error' ? '✕' : '✓'} {block.summary.verb}
        {block.summary.subject ? ` ${block.summary.subject}` : ''}
        {block.summary.context ?? ''}
      </Text>
    </View>
  );
}

function ThinkingRow({ block }: { block: Extract<TranscriptBlock, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((v) => !v)} className="my-1 px-1">
      <Text className="text-xs italic text-muted-foreground">
        {open ? block.text : `Thinking${block.streaming ? '…' : ` (${block.text.length} chars — tap to expand)`}`}
      </Text>
    </Pressable>
  );
}

export function TranscriptBlockView({
  block,
  sessionId = null,
  canRespond = false,
  sessionLoaded = true,
}: {
  block: TranscriptBlock;
  sessionId?: string | null;
  canRespond?: boolean;
  sessionLoaded?: boolean;
}) {
  switch (block.kind) {
    case 'user':
      return (
        <View className="my-1.5 self-end rounded-2xl bg-secondary px-4 py-2" style={{ maxWidth: '85%' }}>
          <Text className="text-foreground">{block.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View className="my-1.5 px-1">
          <MarkdownText text={block.text} />
          {block.streaming ? <Text className="text-xs text-muted-foreground">▍</Text> : null}
        </View>
      );
    case 'tool':
      return <ToolRow block={block} />;
    case 'thinking':
      return <ThinkingRow block={block} />;
    case 'error':
      return (
        <View className="my-1.5 rounded-lg border border-destructive px-3 py-2">
          <Text className="text-sm text-destructive">{block.message}</Text>
        </View>
      );
    case 'user_input':
      return (
        <QuestionCard
          block={block}
          sessionId={sessionId}
          canRespond={canRespond}
          sessionLoaded={sessionLoaded}
        />
      );
    case 'plan':
      return <PlanBlockView items={block.items} />;
    case 'provider_request':
      return (
        <View className="my-1.5 rounded-lg border border-border bg-card px-3 py-2">
          <Text className="text-sm text-foreground">
            {block.status === 'pending'
              ? 'Approval requested — respond from the web app for now.'
              : `Request ${block.decision ?? 'resolved'}`}
          </Text>
        </View>
      );
    case 'cursor-context':
      return (
        <View className="my-1.5 rounded-lg border border-border bg-card px-3 py-2">
          <Text className="text-xs text-muted-foreground">{block.summary}</Text>
        </View>
      );
    default:
      return null;
  }
}
