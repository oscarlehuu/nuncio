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

/** Streamed token events that are safe to merge by concatenating `delta`. */
const COALESCED_EVENT_TYPES = new Set(['assistant_delta', 'thinking_delta']);
/** Quiet-stream flush: buffered deltas reach persistence/subscribers within this window. */
const DELTA_FLUSH_MS = 100;
/** Flush before a merged payload can approach the 4KB event truncation limit. */
const DELTA_FLUSH_MAX_CHARS = 2000;
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

  /** Make every callback carrying the current run's guarded emitter stale. */
  invalidateRun(sessionId: string): void {
    this.runGenerations.set(sessionId, (this.runGenerations.get(sessionId) ?? 0) + 1);
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
  private readonly previewBuffers = new Map<string, PreviewBuffer>();
  private readonly runGenerations = new Map<string, number>();
  private readonly guardedEmitters = new WeakMap<
    EventEmitter,
    { sessionId: string; generation: number }
  >();

  protected pushEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
    if (!this.isEmitterCurrent(sessionId, emit)) return;
    const delta = coalescableDelta(type, payload);
    if (delta === null) {
      // Non-delta events flush first so transcript ordering is preserved.
      this.flushDeltas(sessionId);
      const event = this.events.append(sessionId, type, payload);
      emit?.(event);
      return;
    }

    const base = payloadBase(payload);
    const buffered = this.deltaBuffers.get(sessionId);
    if (buffered && (buffered.type !== type || !sameBase(buffered.base, base))) {
      this.flushDeltas(sessionId);
    }

    const current = this.deltaBuffers.get(sessionId);
    if (!current) {
      const next: DeltaBuffer = {
        type,
        base,
        delta,
        emit,
        timer: null,
      };
      this.deltaBuffers.set(sessionId, next);
      this.scheduleDeltaFlush(sessionId, next);
      return;
    }
    current.delta += delta;
    current.emit = emit ?? current.emit;
    if (current.delta.length >= DELTA_FLUSH_MAX_CHARS) {
      this.flushDeltas(sessionId);
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
  }

  /** Shutdown-only: stop retained tails from retrying against a closing database. */
  cancelPendingEventRetries(sessionId?: string): void {
    if (sessionId !== undefined) {
      const buffered = this.deltaBuffers.get(sessionId);
      if (buffered?.timer) clearTimeout(buffered.timer);
      this.deltaBuffers.delete(sessionId);
      return;
    }
    for (const buffered of this.deltaBuffers.values()) {
      if (buffered.timer) clearTimeout(buffered.timer);
    }
    this.deltaBuffers.clear();
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
    } catch (error) {
      // Keep the exact buffer in place. Timer and synchronous failures are both
      // retryable; deletion happens only after append has committed.
      if (this.deltaBuffers.get(sessionId) === buffered) {
        this.scheduleDeltaFlush(sessionId, buffered);
      }
      throw error;
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
        this.flushDeltas(sessionId);
      } catch {
        // flushDeltas retained the buffer and scheduled the bounded retry.
      }
    }, DELTA_FLUSH_MS);
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
      this.sessions.updateStatus(sessionId, 'RUNNING');
      this.pushEvent(sessionId, 'status', { status: 'RUNNING' }, runContext.emit);
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

      await this.executePrompt(sessionId, text, isSteer, runContext);
      if (!this.isRunCurrent(sessionId, generation)) return;
      this.flushPreview(sessionId);

      // The session may have been deleted (e.g. user deleted an archived
      // session) while the agent loop was in flight. Silently no-op instead of
      // throwing "Session not found" out of run() — that would escape as an
      // unhandled rejection and crash the process.
      const current = this.sessions.findById(sessionId);
      if (!current || current.status !== 'RUNNING') return;
      this.sessions.updateStatus(sessionId, 'IDLE');
      this.pushEvent(sessionId, 'status', { status: 'IDLE' }, runContext.emit);
    } catch (error) {
      if (!this.isRunCurrent(sessionId, generation)) return;
      this.flushPreview(sessionId);
      if (error instanceof AgentRunCancelledError) return;
      this.handleError(sessionId, error, runContext.emit);
    } finally {
      if (this.isRunCurrent(sessionId, generation)) this.invalidateRun(sessionId);
    }
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
    this.guardedEmitters.set(guarded, { sessionId, generation });
    return { ...context, emit: guarded };
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

  private handleError(sessionId: string, error: unknown, emit?: EventEmitter): void {
    if (error instanceof HttpException) {
      const session = this.sessions.findById(sessionId);
      if (session?.status === 'RUNNING') {
        try {
          this.sessions.updateStatus(sessionId, 'IDLE');
          this.pushEvent(sessionId, 'status', { status: 'IDLE' }, emit);
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
    this.sessions.updateStatus(sessionId, 'ERROR');
    this.pushEvent(sessionId, 'status', { status: 'ERROR' }, emit);
    this.pushEvent(sessionId, 'error', { message }, emit);
  }
}
