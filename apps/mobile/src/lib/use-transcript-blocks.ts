import { useRef } from 'react';
import type { SessionEvent } from '@nuncio/core/api';
import { IncrementalTranscriptBuilder } from '@nuncio/core/incremental-transcript-builder';
import type { TranscriptBlock } from '@nuncio/core/transcript-build-blocks';

export function useTranscriptBlocks(events: SessionEvent[]): TranscriptBlock[] {
  const builderRef = useRef<IncrementalTranscriptBuilder | null>(null);
  if (!builderRef.current) builderRef.current = new IncrementalTranscriptBuilder();
  return builderRef.current.update(events);
}
