import { useRef } from 'react';
import type { SessionEvent } from './api';
import {
  createParserState,
  finalizeBlocks,
  stepEvent,
  type ParserState,
  type TranscriptBlock,
} from './transcript-build-blocks';

/**
 * True when `state.out` is guaranteed to never be mutated by any future
 * event (no reach-back mutation can target it): no unresolved streaming
 * buffers, no open tool calls, no pending interactive tool prompts, no
 * unresolved provider requests or user_input blocks. At this point it's
 * safe to freeze `state.out` as a checkpoint prefix.
 */
function isSafeBoundary(state: ParserState): boolean {
  if (state.assistantBuf !== '') return false;
  if (state.thinkingBuf !== '') return false;
  if (state.thinkingOpen) return false;
  if (state.openTools.size > 0) return false;
  if (state.pendingInteractive.size > 0) return false;
  if (state.legacyStack.length > 0) return false;
  for (const request of state.providerRequests.values()) {
    if (request.status !== 'resolved') return false;
  }
  for (const block of state.out) {
    if (block.kind === 'user_input' && !block.resolvedBy) return false;
  }
  return true;
}

function cloneParserState(state: ParserState): ParserState {
  return {
    out: state.out.slice(),
    assistantBuf: state.assistantBuf,
    thinkingBuf: state.thinkingBuf,
    thinkingOpen: state.thinkingOpen,
    thinkingId: state.thinkingId,
    openTools: new Map(state.openTools),
    pendingInteractive: new Map(state.pendingInteractive),
    providerRequests: new Map(state.providerRequests),
    legacyStack: state.legacyStack.slice(),
    legacySeq: state.legacySeq,
    currentTurnHasThinking: state.currentTurnHasThinking,
    assistantBufFromDelta: state.assistantBufFromDelta,
    lastSeq: state.lastSeq,
    assistantStartSeq: state.assistantStartSeq,
    thinkingStartSeq: state.thinkingStartSeq,
  };
}

export class IncrementalTranscriptBuilder {
  /** Parser state folded up to (but not including) events[checkpointIndex]. */
  private checkpointState: ParserState = createParserState();
  /** Number of events folded into checkpointState. Always a safe boundary. */
  private checkpointIndex = 0;
  /** seq of events[checkpointIndex - 1], used to validate cache extension. */
  private checkpointSeq: number | undefined;

  update(events: SessionEvent[]): TranscriptBlock[] {
    if (!this.extendsPriorPrefix(events)) {
      this.reset();
    }

    // Replay from the checkpoint through the end of `events`, advancing the
    // checkpoint itself whenever we cross a safe boundary so the next call
    // only has to replay the current (unfinished) turn.
    const working = cloneParserState(this.checkpointState);
    for (let i = this.checkpointIndex; i < events.length; i++) {
      stepEvent(working, events[i]!);
      if (isSafeBoundary(working)) {
        this.checkpointState = cloneParserState(working);
        this.checkpointIndex = i + 1;
        this.checkpointSeq = events[i]!.seq;
      }
    }

    return finalizeBlocks(working);
  }

  private extendsPriorPrefix(events: SessionEvent[]): boolean {
    if (this.checkpointIndex === 0) return true;
    if (events.length < this.checkpointIndex) return false;
    const eventAtCheckpoint = events[this.checkpointIndex - 1];
    if (!eventAtCheckpoint || eventAtCheckpoint.seq !== this.checkpointSeq) return false;
    return true;
  }

  private reset(): void {
    this.checkpointState = createParserState();
    this.checkpointIndex = 0;
    this.checkpointSeq = undefined;
  }
}

export function useTranscriptBlocks(events: SessionEvent[]): TranscriptBlock[] {
  const builderRef = useRef<IncrementalTranscriptBuilder | null>(null);
  if (!builderRef.current) {
    builderRef.current = new IncrementalTranscriptBuilder();
  }
  return builderRef.current.update(events);
}
