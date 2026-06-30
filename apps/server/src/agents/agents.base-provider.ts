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

export class AgentRunCancelledError extends Error {
  constructor(message = 'Agent run cancelled.') {
    super(message);
    this.name = 'AgentRunCancelledError';
  }
}

export abstract class BaseAgentProvider implements AgentProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly capabilities: AgentCapabilities = {
    interrupt: false,
    modelSwitch: 'none',
    effortSwitch: 'none',
    images: false,
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

  protected pushEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
    const event = this.events.append(sessionId, type, payload);
    emit?.({ type, payload: event.payload });
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
      this.pushEvent(sessionId, isSteer ? 'steer_message' : 'user_message', { text }, context.emit);

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
