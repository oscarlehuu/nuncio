import type { SessionEvent } from './api';
import {
  createParserState,
  finalizeBlocks,
  stepEvent,
  type ParserState,
  type TranscriptBlock,
} from './transcript-build-blocks';

/** True only when no future event can reach back into the committed blocks. */
function isSafeBoundary(state: ParserState): boolean {
  if (state.assistantBuf !== '') return false;
  if (state.thinkingBuf !== '') return false;
  if (state.thinkingOpen) return false;
  if (state.openTools.size > 0) return false;
  if (state.pendingInteractive.size > 0) return false;
  if (state.legacyStack.length > 0) return false;
  if (state.pendingEvidenceBeforeKey) return false;
  for (const request of state.providerRequests.values()) {
    if (request.status !== 'resolved') return false;
  }
  for (const block of state.out) {
    if (block.kind === 'user_input' && !block.resolvedBy) return false;
    if (block.kind === 'user' && block.reserved) return false;
  }
  return true;
}

function hasCanonicalTransientState(state: ParserState): boolean {
  return state.assistantBuf === ''
    && state.thinkingBuf === ''
    && !state.thinkingOpen
    && state.thinkingId === ''
    && state.openTools.size === 0
    && state.pendingInteractive.size === 0
    && state.providerRequests.size === 0
    && state.legacyStack.length === 0
    && state.legacySeq === 0
    && !state.currentTurnHasThinking
    && !state.assistantBufFromDelta
    && state.assistantStartSeq === null
    && state.thinkingStartSeq === null
    && state.pendingEvidenceBeforeKey === null;
}

function isRebaseableTransition(
  event: SessionEvent,
  outputLengthBefore: number,
  state: ParserState,
): boolean {
  if (!hasCanonicalTransientState(state)) return false;
  const added = state.out.length - outputLengthBefore;
  const last = state.out.at(-1);

  if (event.type === 'status') return added === 0;
  if (event.type === 'user_message') {
    return added === 1
      && last?.kind === 'user'
      && last.key === `user-${event.seq}`
      && !last.queued
      && !last.reserved;
  }
  if (event.type === 'assistant_message') {
    return added === 1
      && last?.kind === 'assistant'
      && last.key === `assistant-${event.seq}`
      && !last.streaming;
  }
  return false;
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
    pendingEvidenceBeforeKey: state.pendingEvidenceBeforeKey,
  };
}

export class IncrementalTranscriptBuilder {
  /** Parser state folded up to (but not including) events[checkpointIndex]. */
  private checkpointState: ParserState = createParserState();
  /** Number of events folded into checkpointState. Always a safe boundary. */
  private checkpointIndex = 0;
  /** Event identity + seq snapshots validate the entire immutable checkpoint prefix. */
  private checkpointEvents: SessionEvent[] = [];
  private checkpointSeqs: number[] = [];
  /** Cumulative output size and detachability after each checkpointed event. */
  private checkpointOutputLengths: number[] = [];
  private checkpointRebaseable: boolean[] = [];
  private readonly onEventProcessed: ((event: SessionEvent) => void) | undefined;

  constructor(onEventProcessed?: (event: SessionEvent) => void) {
    this.onEventProcessed = onEventProcessed;
  }

  update(events: SessionEvent[]): TranscriptBlock[] {
    if (!this.extendsPriorPrefix(events) && !this.advanceKnownEviction(events)) {
      this.reset();
    }

    const priorCheckpointIndex = this.checkpointIndex;
    const outputLengths = this.checkpointOutputLengths.slice();
    const rebaseable = this.checkpointRebaseable.slice();
    const working = cloneParserState(this.checkpointState);
    for (let index = this.checkpointIndex; index < events.length; index += 1) {
      const event = events[index]!;
      const outputLengthBefore = working.out.length;
      const canonicalBefore = hasCanonicalTransientState(working);
      this.onEventProcessed?.(event);
      stepEvent(working, event);
      outputLengths[index] = working.out.length;
      rebaseable[index] = canonicalBefore
        && isRebaseableTransition(event, outputLengthBefore, working);
      if (isSafeBoundary(working)) {
        this.checkpointState = cloneParserState(working);
        this.checkpointIndex = index + 1;
      }
    }
    if (this.checkpointIndex !== priorCheckpointIndex) {
      this.checkpointEvents = events.slice(0, this.checkpointIndex);
      this.checkpointSeqs = this.checkpointEvents.map((event) => event.seq);
      this.checkpointOutputLengths = outputLengths.slice(0, this.checkpointIndex);
      this.checkpointRebaseable = rebaseable.slice(0, this.checkpointIndex);
    }

    return finalizeBlocks(working);
  }

  /** Drop every cached checkpoint before parsing the next event array. */
  reset(): void {
    this.checkpointState = createParserState();
    this.checkpointIndex = 0;
    this.checkpointEvents = [];
    this.checkpointSeqs = [];
    this.checkpointOutputLengths = [];
    this.checkpointRebaseable = [];
  }

  private extendsPriorPrefix(events: SessionEvent[]): boolean {
    if (this.checkpointIndex === 0) return true;
    if (events.length < this.checkpointIndex) return false;
    for (let index = 0; index < this.checkpointIndex; index += 1) {
      const event = events[index];
      if (!event || event !== this.checkpointEvents[index] || event.seq !== this.checkpointSeqs[index]) {
        return false;
      }
    }
    return true;
  }

  private advanceKnownEviction(events: SessionEvent[]): boolean {
    if (this.checkpointIndex === 0 || events.length === 0) return false;
    const evictedCount = this.checkpointEvents.indexOf(events[0]!);
    if (evictedCount <= 0) return false;

    const retainedCount = this.checkpointIndex - evictedCount;
    if (retainedCount <= 0 || events.length < retainedCount) return false;
    for (let index = 0; index < retainedCount; index += 1) {
      const priorIndex = evictedCount + index;
      const event = events[index];
      if (
        !event
        || event !== this.checkpointEvents[priorIndex]
        || event.seq !== this.checkpointSeqs[priorIndex]
        || !this.checkpointRebaseable[priorIndex]
      ) return false;
    }
    if (!hasCanonicalTransientState(this.checkpointState)) return false;

    const droppedOutputLength = this.checkpointOutputLengths[evictedCount - 1] ?? 0;
    this.checkpointState = {
      ...this.checkpointState,
      out: this.checkpointState.out.slice(droppedOutputLength),
    };
    this.checkpointIndex = retainedCount;
    this.checkpointEvents = this.checkpointEvents.slice(evictedCount);
    this.checkpointSeqs = this.checkpointSeqs.slice(evictedCount);
    this.checkpointOutputLengths = this.checkpointOutputLengths
      .slice(evictedCount)
      .map((length) => length - droppedOutputLength);
    this.checkpointRebaseable = this.checkpointRebaseable.slice(evictedCount);
    return true;
  }
}
