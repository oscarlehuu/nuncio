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
  const latestByKey = new Map<string, TranscriptBlock>();
  for (const block of blocks) latestByKey.set(block.key, block);

  const deduped: TranscriptBlock[] = [];
  const seenBlockKeys = new Set<string>();
  for (const block of blocks) {
    if (seenBlockKeys.has(block.key)) continue;
    seenBlockKeys.add(block.key);
    deduped.push(latestByKey.get(block.key) ?? block);
  }

  const grouped: RenderTranscriptBlock[] = [];
  const usedRenderKeys = new Set<string>();
  const uniqueKey = (base: string) => {
    let key = base;
    let suffix = 2;
    while (usedRenderKeys.has(key)) key = `${base}-${suffix++}`;
    usedRenderKeys.add(key);
    return key;
  };

  for (const block of deduped) {
    if (block.kind !== 'tool') {
      const key = uniqueKey(block.key);
      grouped.push(key === block.key ? block : { ...block, key });
      continue;
    }
    const previous = grouped[grouped.length - 1];
    if (previous?.kind === 'tool-group') {
      previous.blocks.push(block);
    } else {
      grouped.push({ kind: 'tool-group', key: uniqueKey(`tool-group-${block.key}`), blocks: [block] });
    }
  }
  return grouped;
}
