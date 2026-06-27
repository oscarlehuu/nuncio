import type { ModelProviderDto } from '../models/models.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import type { AgentProvider, AgentRunContext, EventEmitter } from './agents.types';

export abstract class BaseAgentProvider implements AgentProvider {
  abstract readonly id: string;
  abstract readonly name: string;

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

      this.sessions.updateStatus(sessionId, 'IDLE');
      this.pushEvent(sessionId, 'status', { status: 'IDLE' }, context.emit);
    } catch (error) {
      this.handleError(sessionId, error, context.emit);
    }
  }

  private handleError(sessionId: string, error: unknown, emit?: EventEmitter): void {
    const message = error instanceof Error ? error.message : String(error);
    this.events.append(sessionId, 'error', { message });
    this.sessions.updateStatus(sessionId, 'ERROR');
    emit?.({ type: 'status', payload: { status: 'ERROR' } });
    emit?.({ type: 'error', payload: { message } });
  }
}
