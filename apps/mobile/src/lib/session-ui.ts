import type { SessionStatus } from '@nuncio/core/api';
import type { TranscriptBlock } from '@nuncio/core/transcript-build-blocks';

export type ToolIconName =
  | 'file'
  | 'search'
  | 'terminal'
  | 'pencil'
  | 'globe'
  | 'folder'
  | 'list'
  | 'sparkles';

export function toolIconForVerb(verb: string): ToolIconName {
  const normalized = verb.toLowerCase();
  if (normalized.includes('read')) return 'file';
  if (normalized.includes('grep') || normalized.includes('search')) return 'search';
  if (normalized.includes('ran') || normalized.includes('run')) return 'terminal';
  if (normalized.includes('edit') || normalized.includes('wrote')) return 'pencil';
  if (normalized.includes('fetch')) return 'globe';
  if (normalized.includes('found')) return 'folder';
  if (normalized.includes('list')) return 'list';
  return 'sparkles';
}

export type StatusBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export function statusBadgeVariant(status: SessionStatus): StatusBadgeVariant {
  if (status === 'ERROR') return 'destructive';
  if (status === 'RUNNING') return 'default';
  if (status === 'ARCHIVED') return 'outline';
  return 'secondary';
}

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;
export type RenderTranscriptBlock =
  | TranscriptBlock
  | { kind: 'tool-group'; key: string; blocks: ToolBlock[] };

export function groupTranscriptBlocks(blocks: TranscriptBlock[]): RenderTranscriptBlock[] {
  const grouped: RenderTranscriptBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      grouped.push(block);
      continue;
    }
    const previous = grouped[grouped.length - 1];
    if (previous?.kind === 'tool-group') {
      previous.blocks.push(block);
    } else {
      grouped.push({ kind: 'tool-group', key: `tool-group-${block.key}`, blocks: [block] });
    }
  }
  return grouped;
}
