import { HttpException } from '@nestjs/common';
import type { ModelProviderDto } from '../models/models.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import type {
  AgentCapabilities,
  AgentProvider,
  AgentRunContext,
  EventEmitter,
} from './agents.types';
import { eventImagesFromAttachments } from './agents.attachments';

export class AgentRunCancelledError extends Error {
  constructor(message = 'Agent run cancelled.') {
    super(message);
    this.name = 'AgentRunCancelledError';
  }
}

/** A buffered event append failed but remains retained for a later retry. */
export class RetainedEventFlushError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RetainedEventFlushError';
  }
}

/** Streamed token events that are safe to merge by concatenating `delta`. */
const COALESCED_EVENT_TYPES = new Set(['assistant_delta', 'thinking_delta']);
/** Quiet-stream flush: buffered deltas reach persistence/subscribers within this window. */
const DELTA_FLUSH_MS = 100;
/** Flush before a merged payload can approach the 4KB event truncation limit. */
const DELTA_FLUSH_MAX_CHARS = 2000;
/** Hard aggregate bound while durable storage is unavailable. */
const RETAINED_EVENT_MAX_BYTES = 256 * 1024;
/** Sidebar/session-list preview is useful live, but must not write SQLite per token. */
const PREVIEW_FLUSH_MS = 250;

interface DeltaBuffer {
  type: string;
  /** Non-delta payload fields (e.g. thinkingId) — must match for events to merge. */
  base: Record<string, unknown>;
  delta: string;
  emit?: EventEmitter;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RetainedEvent {
  type: string;
  payload: unknown;
  emit?: EventEmitter;
  /** FSM settlement that must succeed before this terminal event can commit. */
  settleStatus?: 'IDLE' | 'ERROR';
}

interface PreviewBuffer {
  preview: string;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout>;
}

function coalescableDelta(type: string, payload: unknown): string | null {
  if (!COALESCED_EVENT_TYPES.has(type)) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const delta = (payload as Record<string, unknown>).delta;
  return typeof delta === 'string' ? delta : null;
}

function payloadBase(payload: unknown): Record<string, unknown> {
  const { delta: _delta, ...base } = payload as Record<string, unknown>;
  return base;
}

function sameBase(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function terminalStatus(type: string, payload: unknown): 'IDLE' | 'ERROR' | undefined {
  if (type !== 'status' || typeof payload !== 'object' || payload === null) return undefined;
  const status = (payload as { status?: unknown }).status;
  return status === 'IDLE' || status === 'ERROR' ? status : undefined;
}

export abstract class BaseAgentProvider implements AgentProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly capabilities: AgentCapabilities = {
    interrupt: false,
    modelSwitch: 'none',
    effortSwitch: 'none',
    images: false,
    steerWhileRunning: false,
  };

  constructor(
    protected readonly sessions: SessionsRepository,
    protected readonly events: EventsRepository,
  ) {}

  abstract isAvailable(): Promise<boolean>;
  abstract listModels(): Promise<ModelProviderDto[]>;

  async run(sessionId: string, prompt: string, context: AgentRunContext): Promise<void> {
    await this.runOrSteer(sessionId, prompt, false, context);
  }

  async steer(sessionId: string, message: string, context: AgentRunContext): Promise<void> {
    await this.runOrSteer(sessionId, message, true, context);
  }

  dispose(sessionId: string): void {
    let teardownError: unknown;
    try {
      this.flushPendingEvents(sessionId);
    } catch (error) {
      teardownError = error;
    }
    try {
      this.flushPreview(sessionId);
    } catch (error) {
      teardownError ??= error;
    }
    try {
      // Providers may need to persist terminal cleanup (for example tool_end)
      // while the current run emitter is still valid.
      if (this.prepareRuntimeDispose(sessionId)) this.flushPendingEvents(sessionId);
    } catch (error) {
      teardownError ??= error;
    }
    this.invalidateRun(sessionId);
    try {
      this.disposeRuntime(sessionId);
    } catch (error) {
      teardownError ??= error;
    }
    if (teardownError) throw teardownError;
  }

  /** Release engine-specific handles after the shared tail flush + run fence. */
  protected disposeRuntime(_sessionId: string): void {}

  /** Persist engine-specific terminal events before the shared run fence. */
  protected prepareRuntimeDispose(_sessionId: string): boolean {
    return false;
  }

  /** Make every callback carrying the current run's guarded emitter stale. */
  invalidateRun(sessionId: string): void {
    this.runGenerations.set(sessionId, (this.runGenerations.get(sessionId) ?? 0) + 1);
  }

  /**
   * Provider-neutral stop acknowledgement. Interrupt-capable adapters must
   * first await their SDK/transport acknowledgement; only then is the local
   * handle detached. Adapters without interrupt support treat synchronous
   * dispose as their stop acknowledgement.
   */
  async quiesce(sessionId: string): Promise<void> {
    const provider = this as AgentProvider;
    if (this.capabilities.interrupt) {
      if (!provider.interrupt) {
        throw new Error(`Provider ${this.id} declares interrupt support without implementing it.`);
      }
      await provider.interrupt(sessionId);
    }
    this.dispose(sessionId);
  }

  /** Default no-op; providers that cache availability/models override this. */
  bustCache(): void {}

  protected abstract executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void>;

  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private readonly retainedEvents = new Map<string, RetainedEvent[]>();
  private readonly retainedEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly previewBuffers = new Map<string, PreviewBuffer>();
  private readonly runGenerations = new Map<string, number>();
  private readonly guardedEmitters = new WeakMap<
    EventEmitter,
    { sessionId: string; generation: number; upstream?: EventEmitter }
  >();

  protected pushEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
    if (!this.isEmitterCurrent(sessionId, emit)) return;
    const acceptedEmit = this.acceptedEmitter(emit);
    const incomingDelta = coalescableDelta(type, payload);
    if (incomingDelta !== null && incomingDelta.length > DELTA_FLUSH_MAX_CHARS) {
      const base = payloadBase(payload);
      for (let offset = 0; offset < incomingDelta.length; offset += DELTA_FLUSH_MAX_CHARS) {
        this.pushEvent(sessionId, type, {
          ...base,
          delta: incomingDelta.slice(offset, offset + DELTA_FLUSH_MAX_CHARS),
        }, emit);
      }
      return;
    }
    if (this.retainedEvents.get(sessionId)?.length) {
      this.retainEvent(sessionId, type, payload, acceptedEmit);
      return;
    }
    const delta = coalescableDelta(type, payload);
    if (delta === null) {
      // Non-delta events flush first so transcript ordering is preserved.
      try {
        this.flushDeltas(sessionId);
      } catch {
        // The event was accepted from the current SDK generation. Keep it
        // behind the earlier delta and retry without misclassifying a transient
        // repository failure as a provider failure.
        this.retainEvent(sessionId, type, payload, acceptedEmit);
        return;
      }
      let event;
      try {
        event = this.persistEvent(sessionId, type, payload, terminalStatus(type, payload));
        if (!event) return;
      } catch {
        this.retainEvent(sessionId, type, payload, acceptedEmit);
        return;
      }
      emit?.(event);
      return;
    }

    const base = payloadBase(payload);
    const buffered = this.deltaBuffers.get(sessionId);
    if (buffered && (buffered.type !== type || !sameBase(buffered.base, base))) {
      try {
        this.flushDeltas(sessionId);
      } catch {
        this.retainEvent(sessionId, type, payload, acceptedEmit);
        return;
      }
    }

    const current = this.deltaBuffers.get(sessionId);
    if (!current) {
      const next: DeltaBuffer = {
        type,
        base,
        delta,
        // The callback was accepted while this generation was current. Keep
        // its upstream fan-out so a later persistence retry can still deliver
        // the committed row even if dispose has fenced new SDK callbacks.
        emit: acceptedEmit,
        timer: null,
      };
      this.deltaBuffers.set(sessionId, next);
      this.scheduleDeltaFlush(sessionId, next);
      if (next.delta.length >= DELTA_FLUSH_MAX_CHARS) {
        try {
          this.flushDeltas(sessionId);
        } catch {
          // The bounded active chunk remains retryable.
        }
      }
      return;
    }
    if (current.delta.length >= DELTA_FLUSH_MAX_CHARS) {
      // A full chunk whose append is retrying owns the earlier transcript
      // position. Queue later bytes behind it instead of growing one unbounded
      // in-memory/event payload during a prolonged repository outage.
      this.retainEvent(sessionId, type, payload, acceptedEmit);
      return;
    }
    current.delta += delta;
    current.emit = acceptedEmit ?? current.emit;
    if (current.delta.length >= DELTA_FLUSH_MAX_CHARS) {
      try {
        this.flushDeltas(sessionId);
      } catch {
        // flushDeltas retained this exact buffer and armed its retry.
      }
    }
  }

  /**
   * Synchronously flush this session's coalescing buffer so any deltas held for
   * the quiet-stream window are persisted (and fanned out) NOW, before an
   * out-of-band event (e.g. a task digest) is appended at a later seq. No-op
   * when nothing is buffered. Engine-neutral — the buffer lives on the base.
   */
  flushPendingEvents(sessionId: string): void {
    this.flushDeltas(sessionId);
    this.flushRetainedEvents(sessionId);
  }

  pendingEventSessionIds(): string[] {
    return [...new Set([...this.deltaBuffers.keys(), ...this.retainedEvents.keys()])];
  }

  /** Shutdown-only: stop retained tails from retrying against a closing database. */
  cancelPendingEventRetries(sessionId?: string): void {
    if (sessionId !== undefined) {
      const buffered = this.deltaBuffers.get(sessionId);
      if (buffered?.timer) clearTimeout(buffered.timer);
      this.deltaBuffers.delete(sessionId);
      const retainedTimer = this.retainedEventTimers.get(sessionId);
      if (retainedTimer) clearTimeout(retainedTimer);
      this.retainedEventTimers.delete(sessionId);
      this.retainedEvents.delete(sessionId);
      return;
    }
    for (const buffered of this.deltaBuffers.values()) {
      if (buffered.timer) clearTimeout(buffered.timer);
    }
    this.deltaBuffers.clear();
    for (const timer of this.retainedEventTimers.values()) clearTimeout(timer);
    this.retainedEventTimers.clear();
    this.retainedEvents.clear();
  }

  /** Persist + emit any buffered delta for the session as a single merged event. */
  protected flushDeltas(sessionId: string): void {
    const buffered = this.deltaBuffers.get(sessionId);
    if (!buffered) return;
    if (buffered.timer) clearTimeout(buffered.timer);
    buffered.timer = null;
    let event;
    try {
      event = this.events.append(sessionId, buffered.type, {
        ...buffered.base,
        delta: buffered.delta,
      });
      if (event.seq <= 0) {
        throw new Error('Buffered event append did not commit');
      }
    } catch (error) {
      // Keep the exact buffer in place. Timer and synchronous failures are both
      // retryable; deletion happens only after append has committed.
      if (this.deltaBuffers.get(sessionId) === buffered) {
        this.scheduleDeltaFlush(sessionId, buffered);
      }
      throw new RetainedEventFlushError(error);
    }
    if (this.deltaBuffers.get(sessionId) === buffered) {
      this.deltaBuffers.delete(sessionId);
    }
    // append already committed; always fan it out even if an append test hook
    // synchronously installed the session's next buffer.
    buffered.emit?.(event);
  }

  private scheduleDeltaFlush(sessionId: string, buffered: DeltaBuffer): void {
    if (buffered.timer) clearTimeout(buffered.timer);
    buffered.timer = setTimeout(() => {
      buffered.timer = null;
      try {
        this.flushPendingEvents(sessionId);
      } catch {
        // The failed stage retained its exact queue and scheduled the retry.
      }
    }, DELTA_FLUSH_MS);
  }

  private retainEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
    const queue = this.retainedEvents.get(sessionId) ?? [];
    const delta = coalescableDelta(type, payload);
    const last = queue.at(-1);
    const lastDelta = last ? coalescableDelta(last.type, last.payload) : null;
    const active = this.deltaBuffers.get(sessionId);
    const activeBytes = active
      ? this.retainedEventBytes({
          type: active.type,
          payload: { ...active.base, delta: active.delta },
          emit: active.emit,
        })
      : 0;
    const retainedBytes = activeBytes +
      queue.reduce((total, event) => total + this.retainedEventBytes(event), 0);
    if (
      delta !== null &&
      last &&
      lastDelta !== null &&
      last.type === type &&
      sameBase(payloadBase(last.payload), payloadBase(payload)) &&
      lastDelta.length + delta.length <= DELTA_FLUSH_MAX_CHARS
    ) {
      const merged = { ...payloadBase(last.payload), delta: lastDelta + delta };
      const nextBytes = retainedBytes - this.retainedEventBytes(last) +
        this.retainedEventBytes({ ...last, payload: merged });
      if (nextBytes > RETAINED_EVENT_MAX_BYTES) this.stopForRetainedOverflow(sessionId, emit);
      last.payload = merged;
      last.emit = emit ?? last.emit;
    } else {
      const retained = { type, payload, emit, settleStatus: terminalStatus(type, payload) };
      if (retainedBytes + this.retainedEventBytes(retained) > RETAINED_EVENT_MAX_BYTES) {
        this.stopForRetainedOverflow(sessionId, emit);
      }
      queue.push(retained);
    }
    this.retainedEvents.set(sessionId, queue);
    this.scheduleRetainedEventFlush(sessionId);
  }

  private retainedEventBytes(event: RetainedEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify([event.type, event.payload]) ?? '');
    } catch {
      return RETAINED_EVENT_MAX_BYTES + 1;
    }
  }

  private stopForRetainedOverflow(sessionId: string, emit?: EventEmitter): never {
    const message = `Retained event buffer exceeded ${RETAINED_EVENT_MAX_BYTES} bytes`;
    const buffered = this.deltaBuffers.get(sessionId);
    if (buffered?.timer) clearTimeout(buffered.timer);
    this.deltaBuffers.delete(sessionId);
    const retainedTimer = this.retainedEventTimers.get(sessionId);
    if (retainedTimer) clearTimeout(retainedTimer);
    this.retainedEventTimers.delete(sessionId);
    const pending: RetainedEvent[] = [];
    if (buffered) {
      pending.push({
        type: buffered.type,
        payload: { ...buffered.base, delta: buffered.delta },
        emit: buffered.emit,
      });
    }
    pending.push(...(this.retainedEvents.get(sessionId) ?? []));
    try {
      this.sessions.updateStatus(sessionId, 'ERROR');
    } catch {
      // Storage/session state may already be unavailable; fencing still bounds memory.
    }
    pending.push(
      { type: 'error', payload: { message }, emit },
      { type: 'status', payload: { status: 'ERROR' }, emit, settleStatus: 'ERROR' },
    );
    this.retainedEvents.set(sessionId, pending);
    this.scheduleRetainedEventFlush(sessionId);
    this.invalidateRun(sessionId);
    try {
      this.disposeRuntime(sessionId);
    } catch {
      // The overflow error below is the durable-storage failure signal.
    }
    throw new Error(message);
  }

  private flushRetainedEvents(sessionId: string): void {
    const queue = this.retainedEvents.get(sessionId);
    if (!queue?.length) return;
    const timer = this.retainedEventTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retainedEventTimers.delete(sessionId);
    while (queue.length) {
      const retained = queue[0]!;
      let event;
      try {
        event = this.persistEvent(
          sessionId,
          retained.type,
          retained.payload,
          retained.settleStatus,
        );
        if (!event) {
          queue.shift();
          continue;
        }
      } catch (error) {
        this.scheduleRetainedEventFlush(sessionId);
        throw new RetainedEventFlushError(error);
      }
      queue.shift();
      try {
        retained.emit?.(event);
      } catch {
        // The row is durable; a disconnected live listener will recover it by
        // cursor replay and must not poison the persistence queue.
      }
    }
    this.retainedEvents.delete(sessionId);
  }

  private persistEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    settleStatus?: 'IDLE' | 'ERROR',
  ) {
    if (!settleStatus) {
      const event = this.events.append(sessionId, type, payload);
      if (event.seq <= 0) throw new Error('Event append did not commit');
      return event;
    }

    let event: ReturnType<EventsRepository['append']> | null = null;
    this.events.transaction(() => {
      const current = this.sessions.findById(sessionId);
      if (!current || (current.status !== 'RUNNING' && current.status !== settleStatus)) return;
      if (current.status === 'RUNNING') this.sessions.updateStatus(sessionId, settleStatus);
      const persisted = this.events.append(sessionId, type, payload, false);
      if (persisted.seq <= 0) throw new Error('Terminal event append did not commit');
      event = persisted;
    });
    if (event) this.events.notifyPersisted(sessionId, event);
    return event;
  }

  private scheduleRetainedEventFlush(sessionId: string): void {
    const current = this.retainedEventTimers.get(sessionId);
    if (current) return;
    const timer = setTimeout(() => {
      this.retainedEventTimers.delete(sessionId);
      try {
        this.flushPendingEvents(sessionId);
      } catch {
        // The failed stage retained its exact queue and scheduled the retry.
      }
    }, DELTA_FLUSH_MS);
    this.retainedEventTimers.set(sessionId, timer);
  }

  /** Update the session-list preview without turning every raw token into a DB write. */
  protected touchPreview(sessionId: string, preview: string, emit?: EventEmitter): void {
    if (!this.isEmitterCurrent(sessionId, emit)) return;
    const buffered = this.previewBuffers.get(sessionId);
    if (buffered) {
      buffered.preview = preview;
      buffered.dirty = true;
      return;
    }
    this.sessions.touchPreview(sessionId, preview);
    this.previewBuffers.set(sessionId, {
      preview,
      dirty: false,
      timer: setTimeout(() => {
        try {
          this.flushPreview(sessionId);
        } catch {
          this.previewBuffers.delete(sessionId);
        }
      }, PREVIEW_FLUSH_MS),
    });
  }

  private flushPreview(sessionId: string): void {
    const buffered = this.previewBuffers.get(sessionId);
    if (!buffered) return;
    clearTimeout(buffered.timer);
    this.previewBuffers.delete(sessionId);
    if (buffered.dirty) this.sessions.touchPreview(sessionId, buffered.preview);
  }

  /**
   * Separator to prefix onto a new assistant-message segment so it starts a
   * fresh paragraph. Providers whose stream splits one turn into discrete
   * segments — e.g. Codex `agentMessage` items — call this at each boundary;
   * appending the next segment verbatim would otherwise run sentences together
   * (`…end.Start…`). Token-delta providers (Pi, Cursor) stream one continuous
   * message and never need it. Returns '' at the very start, or when the text
   * already ends in a blank line.
   */
  protected paragraphBoundary(accumulated: string): string {
    if (accumulated.length === 0) return '';
    const trailing = /\n*$/.exec(accumulated)?.[0].length ?? 0;
    return trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
  }

  private async runOrSteer(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    // Starting a replacement run fences every callback from the previous SDK
    // turn. Flush its already-accepted tail first so fencing never loses text.
    this.flushPendingEvents(sessionId);
    const generation = (this.runGenerations.get(sessionId) ?? 0) + 1;
    this.runGenerations.set(sessionId, generation);
    const runContext = this.guardRunContext(sessionId, generation, context);
    try {
      if (this.sessions.findById(sessionId)?.status !== 'RUNNING') {
        this.sessions.updateStatus(sessionId, 'RUNNING');
        this.pushEvent(sessionId, 'status', { status: 'RUNNING' }, runContext.emit);
      }
      const images = eventImagesFromAttachments(runContext.attachments);
      // steerMeta (e.g. an auto-steer's origin/retryId) is stamped onto the
      // steer_message so consumers classify it explicitly, never by adjacency.
      const steerMeta =
        isSteer
          ? { ...(runContext.steerOrigin ? { origin: runContext.steerOrigin } : {}), ...(runContext.steerMeta ?? {}) }
          : undefined;
      this.pushEvent(
        sessionId,
        isSteer ? 'steer_message' : 'user_message',
        { text, ...(images ? { images } : {}), ...(steerMeta ?? {}) },
        runContext.emit,
      );
      // Never let the SDK perform workspace side effects before the initiating
      // input is reconstructable from the durable event log.
      await this.waitForPendingEvents(sessionId);
      if (!this.isRunCurrent(sessionId, generation)) return;

      await this.executePrompt(sessionId, text, isSteer, runContext);
      if (!this.isRunCurrent(sessionId, generation)) return;
      this.flushPreview(sessionId);

      // The session may have been deleted (e.g. user deleted an archived
      // session) while the agent loop was in flight. Silently no-op instead of
      // throwing "Session not found" out of run() — that would escape as an
      // unhandled rejection and crash the process.
      const current = this.sessions.findById(sessionId);
      if (!current || current.status !== 'RUNNING') return;
      this.pushEvent(sessionId, 'status', { status: 'IDLE' }, runContext.emit);
      await this.waitForPendingEvents(sessionId);
      if (!this.isRunCurrent(sessionId, generation)) return;
      const settled = this.sessions.findById(sessionId);
      if (settled?.status === 'RUNNING') this.sessions.updateStatus(sessionId, 'IDLE');
    } catch (error) {
      if (!this.isRunCurrent(sessionId, generation)) return;
      this.flushPreview(sessionId);
      if (error instanceof AgentRunCancelledError) return;
      await this.handleError(sessionId, error, runContext.emit);
    }
  }

  /** Do not let post-turn work overtake terminal events retained during an outage. */
  protected async waitForPendingEvents(sessionId: string): Promise<void> {
    const generation = this.runGenerations.get(sessionId);
    while (this.pendingEventSessionIds().includes(sessionId)) {
      if (generation !== undefined && !this.isRunCurrent(sessionId, generation)) {
        throw new AgentRunCancelledError();
      }
      try {
        this.flushPendingEvents(sessionId);
      } catch (error) {
        if (!(error instanceof RetainedEventFlushError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, DELTA_FLUSH_MS));
      }
    }
    if (generation !== undefined && !this.isRunCurrent(sessionId, generation)) {
      throw new AgentRunCancelledError();
    }
  }

  /** Snapshot the currently executing turn so provider-specific awaits can revalidate it. */
  protected currentRunGeneration(sessionId: string): number | undefined {
    return this.runGenerations.get(sessionId);
  }

  /** True only while the same shared provider turn still owns this session. */
  protected isCurrentRunGeneration(sessionId: string, generation: number | undefined): boolean {
    return generation !== undefined && this.isRunCurrent(sessionId, generation);
  }

  private guardRunContext(
    sessionId: string,
    generation: number,
    context: AgentRunContext,
  ): AgentRunContext {
    const upstream = context.emit;
    const guarded: EventEmitter = (event) => {
      if (this.isRunCurrent(sessionId, generation)) upstream?.(event);
    };
    this.guardedEmitters.set(guarded, { sessionId, generation, upstream });
    return { ...context, emit: guarded };
  }

  private acceptedEmitter(emit?: EventEmitter): EventEmitter | undefined {
    if (!emit) return undefined;
    return this.guardedEmitters.get(emit)?.upstream ?? emit;
  }

  private isRunCurrent(sessionId: string, generation: number): boolean {
    return this.runGenerations.get(sessionId) === generation;
  }

  private isEmitterCurrent(sessionId: string, emit?: EventEmitter): boolean {
    if (!emit) return true;
    const guard = this.guardedEmitters.get(emit);
    return !guard ||
      (guard.sessionId === sessionId && this.isRunCurrent(sessionId, guard.generation));
  }

  private async handleError(sessionId: string, error: unknown, emit?: EventEmitter): Promise<void> {
    if (error instanceof HttpException) {
      const session = this.sessions.findById(sessionId);
      if (session?.status === 'RUNNING') {
        try {
          this.pushEvent(sessionId, 'status', { status: 'IDLE' }, emit);
          await this.waitForPendingEvents(sessionId);
          if (this.sessions.findById(sessionId)?.status === 'RUNNING') {
            this.sessions.updateStatus(sessionId, 'IDLE');
          }
        } catch {
          /* session deleted mid-run */
        }
      }
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Same race guard as runOrSteer: if the session row is gone (deleted mid-run),
    // there is nothing to update and no event bus to push to. Logging the error
    // here would just spam — the original failure already happened upstream.
    if (!this.sessions.findById(sessionId)) return;
    this.pushEvent(sessionId, 'status', { status: 'ERROR' }, emit);
    this.pushEvent(sessionId, 'error', { message }, emit);
    await this.waitForPendingEvents(sessionId);
    if (this.sessions.findById(sessionId)?.status === 'RUNNING') {
      this.sessions.updateStatus(sessionId, 'ERROR');
    }
  }

}
