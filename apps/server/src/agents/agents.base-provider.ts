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

interface DeltaBuffer {
  type: string;
  /** Non-delta payload fields (e.g. thinkingId) — must match for events to merge. */
  base: Record<string, unknown>;
  delta: string;
  emit?: EventEmitter;
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

  dispose(_sessionId: string): void {}

  /** Default no-op; providers that cache availability/models override this. */
  bustCache(): void {}

  protected abstract executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void>;

  private readonly deltaBuffers = new Map<string, DeltaBuffer>();

  protected pushEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
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
      this.deltaBuffers.set(sessionId, {
        type,
        base,
        delta,
        emit,
        timer: setTimeout(() => {
          try {
            this.flushDeltas(sessionId);
          } catch {
            // Shutdown race: the database can close while a quiet-stream flush
            // timer is still pending. Synchronous flushes still throw loudly.
            this.deltaBuffers.delete(sessionId);
          }
        }, DELTA_FLUSH_MS),
      });
      return;
    }
    current.delta += delta;
    current.emit = emit ?? current.emit;
    if (current.delta.length >= DELTA_FLUSH_MAX_CHARS) {
      this.flushDeltas(sessionId);
    }
  }

  /** Persist + emit any buffered delta for the session as a single merged event. */
  protected flushDeltas(sessionId: string): void {
    const buffered = this.deltaBuffers.get(sessionId);
    if (!buffered) return;
    clearTimeout(buffered.timer);
    this.deltaBuffers.delete(sessionId);
    const event = this.events.append(sessionId, buffered.type, {
      ...buffered.base,
      delta: buffered.delta,
    });
    buffered.emit?.(event);
  }

  private async runOrSteer(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    try {
      this.sessions.updateStatus(sessionId, 'RUNNING');
      this.pushEvent(sessionId, 'status', { status: 'RUNNING' }, context.emit);
      const images = eventImagesFromAttachments(context.attachments);
      this.pushEvent(
        sessionId,
        isSteer ? 'steer_message' : 'user_message',
        { text, ...(images ? { images } : {}) },
        context.emit,
      );

      await this.executePrompt(sessionId, text, isSteer, context);

      // The session may have been deleted (e.g. user deleted an archived
      // session) while the agent loop was in flight. Silently no-op instead of
      // throwing "Session not found" out of run() — that would escape as an
      // unhandled rejection and crash the process.
      if (!this.sessions.findById(sessionId)) return;
      this.sessions.updateStatus(sessionId, 'IDLE');
      this.pushEvent(sessionId, 'status', { status: 'IDLE' }, context.emit);
    } catch (error) {
      if (error instanceof AgentRunCancelledError) return;
      this.handleError(sessionId, error, context.emit);
    }
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
