import { useMemo } from 'react';
import type { SessionEvent } from '@nuncio/core/api';
import {
  createParserState,
  finalizeBlocks,
  stepEvent,
  type TranscriptBlock,
} from '@nuncio/core/transcript-build-blocks';

/** Rebuilds the block list from the event log; fine for phone-sized transcripts. */
export function useTranscriptBlocks(events: SessionEvent[]): TranscriptBlock[] {
  return useMemo(() => {
    const state = createParserState();
    for (const event of events) stepEvent(state, event);
    return finalizeBlocks(state);
  }, [events]);
}
