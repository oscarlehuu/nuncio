import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventsRepository } from './events.repository';
import type { EventEmitter } from './mock-agent.service';
import { MockAgentService } from './mock-agent.service';
import { SessionsRepository } from './sessions.repository';

type PiSessionHandle = {
  prompt: (text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => Promise<void>;
  unsubscribe: () => void;
  resetAssistantText: () => void;
  getAssistantText: () => string;
};

@Injectable()
export class PiAgentService {
  private readonly activeSessions = new Map<string, PiSessionHandle>();

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly mockAgent: MockAgentService,
  ) {}

  hasPiAuth(): boolean {
    const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    return existsSync(join(agentDir, 'auth.json'));
  }

  async run(sessionId: string, prompt: string, emit?: EventEmitter): Promise<void> {
    if (process.env.NUNCIO_FORCE_MOCK === '1' || !this.hasPiAuth()) {
      return this.mockAgent.run(sessionId, prompt, emit);
    }

    try {
      let handle = this.activeSessions.get(sessionId);
      if (!handle) {
        handle = await this.createPiSession(sessionId, emit);
        this.activeSessions.set(sessionId, handle);
      }
      await this.executePrompt(sessionId, prompt, handle, emit, false);
    } catch (error) {
      this.handleError(sessionId, error, emit);
    }
  }

  async steer(sessionId: string, message: string, emit?: EventEmitter): Promise<void> {
    if (process.env.NUNCIO_FORCE_MOCK === '1' || !this.hasPiAuth()) {
      return this.mockAgent.steer(sessionId, message, emit);
    }

    const handle = this.activeSessions.get(sessionId);
    if (!handle) {
      return this.mockAgent.steer(sessionId, message, emit);
    }

    try {
      await this.executePrompt(sessionId, message, handle, emit, true);
    } catch (error) {
      this.handleError(sessionId, error, emit);
    }
  }

  dispose(sessionId: string): void {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    handle.unsubscribe();
    this.activeSessions.delete(sessionId);
  }

  private async createPiSession(sessionId: string, emit?: EventEmitter): Promise<PiSessionHandle> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const authStorage = pi.AuthStorage.create();
    const modelRegistry = pi.ModelRegistry.create(authStorage);
    const { session } = await pi.createAgentSession({
      sessionManager: pi.SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      tools: ['read', 'bash', 'grep', 'find', 'ls'],
    });

    let assistantText = '';
    const unsubscribe = session.subscribe((event: { type: string; [key: string]: unknown }) => {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === 'text_delta' && inner.delta) {
          assistantText += inner.delta;
          this.pushEvent(sessionId, 'assistant_delta', { delta: inner.delta }, emit);
          this.sessions.touchPreview(sessionId, assistantText);
        }
      }
      if (event.type === 'tool_execution_start') {
        this.pushEvent(sessionId, 'tool_start', { tool: event.toolName }, emit);
      }
      if (event.type === 'tool_execution_end') {
        this.pushEvent(sessionId, 'tool_end', { tool: event.toolName, isError: event.isError }, emit);
      }
    });

    return {
      prompt: (text, options) => session.prompt(text, options),
      unsubscribe,
      resetAssistantText: () => {
        assistantText = '';
      },
      getAssistantText: () => assistantText,
    };
  }

  private async executePrompt(
    sessionId: string,
    text: string,
    handle: PiSessionHandle,
    emit: EventEmitter | undefined,
    isSteer: boolean,
  ): Promise<void> {
    handle.resetAssistantText();
    this.sessions.updateStatus(sessionId, 'RUNNING');
    this.pushEvent(sessionId, 'status', { status: 'RUNNING' }, emit);

    if (isSteer) {
      this.pushEvent(sessionId, 'steer_message', { text }, emit);
    } else {
      this.pushEvent(sessionId, 'user_message', { text }, emit);
    }

    await handle.prompt(text, isSteer ? { streamingBehavior: 'steer' } : undefined);
    this.pushEvent(
      sessionId,
      'assistant_message',
      { text: handle.getAssistantText() || '(no response)' },
      emit,
    );
    this.sessions.updateStatus(sessionId, 'IDLE');
    this.pushEvent(sessionId, 'status', { status: 'IDLE' }, emit);
  }

  private pushEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    emit?: EventEmitter,
  ): void {
    const event = this.events.append(sessionId, type, payload);
    emit?.({ type, payload: event.payload });
  }

  private handleError(sessionId: string, error: unknown, emit?: EventEmitter): void {
    const message = error instanceof Error ? error.message : String(error);
    this.events.append(sessionId, 'error', { message });
    this.sessions.updateStatus(sessionId, 'ERROR');
    emit?.({ type: 'status', payload: { status: 'ERROR' } });
    emit?.({ type: 'error', payload: { message } });
  }
}
