import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderSearch,
  Globe,
  List,
  Pencil,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react-native';
import type { TranscriptBlock } from '@nuncio/core/transcript-build-blocks';
import { MarkdownText } from './markdown-text';
import { PlanBlockView } from './plan-block-view';
import { QuestionCard } from './question-card';
import {
  type RenderTranscriptBlock,
  toolIconForVerb,
  type ToolIconName,
} from '../lib/session-ui';

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

function ToolIcon({ name, color }: { name: ToolIconName; color: string }) {
  const props = { color, size: 15, strokeWidth: 1.8 };
  switch (name) {
    case 'file':
      return <FileText {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'terminal':
      return <Terminal {...props} />;
    case 'pencil':
      return <Pencil {...props} />;
    case 'globe':
      return <Globe {...props} />;
    case 'folder':
      return <FolderSearch {...props} />;
    case 'list':
      return <List {...props} />;
    default:
      return <Sparkles {...props} />;
  }
}

function ToolStatus({ status }: Pick<ToolBlock, 'status'>) {
  if (status === 'running') return <ActivityIndicator size="small" color="#60a5fa" />;
  if (status === 'error') return <X color="#f5605b" size={15} strokeWidth={2.5} />;
  return <Check color="#4ade80" size={15} strokeWidth={2.5} />;
}

function ToolRow({ block }: { block: ToolBlock }) {
  const iconColor = block.status === 'error' ? '#f5605b' : block.status === 'running' ? '#60a5fa' : '#9ca3af';
  return (
    <View className="flex-row items-center gap-2.5 py-2">
      <View className="h-7 w-7 items-center justify-center rounded-md bg-background">
        <ToolIcon name={toolIconForVerb(block.summary.verb)} color={iconColor} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
          {block.summary.verb}
        </Text>
        {block.summary.subject ? (
          <Text className="mt-0.5 font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
            {block.summary.subject}
            {block.summary.context ?? ''}
          </Text>
        ) : null}
      </View>
      <ToolStatus status={block.status} />
    </View>
  );
}

function ToolCluster({ blocks }: { blocks: ToolBlock[] }) {
  return (
    <View className="my-2 rounded-xl border border-border/60 bg-card px-3">
      {blocks.map((block, index) => (
        <View key={block.key} className={index > 0 ? 'border-t border-border/50' : undefined}>
          <ToolRow block={block} />
        </View>
      ))}
    </View>
  );
}

function ThinkingRow({ block }: { block: Extract<TranscriptBlock, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((value) => !value)} className="my-1 flex-row gap-2 rounded-lg px-1 py-2">
      {open ? <ChevronDown color="#83868b" size={15} /> : <ChevronRight color="#83868b" size={15} />}
      <View className="flex-1">
        <Text className="text-xs font-medium text-muted-foreground">
          {block.streaming ? 'Thinking…' : 'Thinking'}
        </Text>
        {open ? (
          <Text className="mt-1 text-xs leading-5 text-muted-foreground">{block.text}</Text>
        ) : (
          <Text className="mt-0.5 text-[11px] text-muted-foreground/70" numberOfLines={1}>
            {block.text || 'Tap to expand internal reasoning'}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function NoticeCard({
  icon,
  title,
  detail,
  tone = 'neutral',
}: {
  icon: 'alert' | 'question' | 'shield';
  title: string;
  detail?: string;
  tone?: 'neutral' | 'danger';
}) {
  const color = tone === 'danger' ? '#f5605b' : '#9ca3af';
  const Icon = icon === 'alert' ? AlertCircle : icon === 'question' ? CircleHelp : ShieldAlert;
  return (
    <View className={`my-2 flex-row gap-3 rounded-xl border px-3 py-3 ${tone === 'danger' ? 'border-destructive/60 bg-destructive/10' : 'border-border/60 bg-card'}`}>
      <Icon color={color} size={17} />
      <View className="flex-1">
        <Text className={`text-sm font-medium ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>
          {title}
        </Text>
        {detail ? <Text className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</Text> : null}
      </View>
    </View>
  );
}

export function TranscriptBlockView({
  block,
  sessionId = null,
  canRespond = false,
  sessionLoaded = true,
  sessionRunning = true,
}: {
  block: RenderTranscriptBlock;
  sessionId?: string | null;
  canRespond?: boolean;
  sessionLoaded?: boolean;
  sessionRunning?: boolean;
}) {
  if (block.kind === 'tool-group') return <ToolCluster blocks={block.blocks} />;

  switch (block.kind) {
    case 'user':
      return (
        <View className="my-2 max-w-[88%] self-end rounded-2xl rounded-br-md bg-primary px-4 py-3">
          <Text className="text-sm leading-5 text-primary-foreground">{block.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View className="my-2 px-1">
          <MarkdownText text={block.text} />
          {block.streaming ? <Text className="text-sm text-primary">▍</Text> : null}
        </View>
      );
    case 'tool':
      return <ToolRow block={block} />;
    case 'thinking':
      return <ThinkingRow block={block} />;
    case 'error':
      return <NoticeCard icon="alert" title="Agent error" detail={block.message} tone="danger" />;
    case 'user_input':
      return (
        <QuestionCard
          block={block}
          sessionId={sessionId}
          canRespond={canRespond}
          sessionLoaded={sessionLoaded}
          sessionRunning={sessionRunning}
        />
      );
    case 'plan':
      return <PlanBlockView items={block.items} />;
    case 'provider_request':
      return (
        <NoticeCard
          icon="shield"
          title={block.status === 'pending' ? 'Approval requested' : `Request ${block.decision ?? 'resolved'}`}
          detail={block.status === 'pending' ? 'Respond from the web app for now.' : undefined}
        />
      );
    case 'cursor-context':
      return <NoticeCard icon="shield" title="Context loaded" detail={block.summary} />;
    case 'interrupted':
      return <NoticeCard icon="alert" title="Run interrupted" />;
    default:
      return null;
  }
}
