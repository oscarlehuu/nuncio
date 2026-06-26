import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventsRepository } from './events.repository';
import type { EventEmitter } from './mock-agent.service';
import { MockAgentService } from './mock-agent.service';
import { SessionsRepository } from './sessions.repository';

@Injectable()
export class PiAgentService {
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
      const pi = await import('@earendil-works/pi-coding-agent');
      const authStorage = pi.AuthStorage.create();
      const modelRegistry = pi.ModelRegistry.create(authStorage);
      const { session } = await pi.createAgentSession({
        sessionManager: pi.SessionManager.inMemory(),
        authStorage,
        modelRegistry,
        tools: ['read', 'bash', 'grep', 'find', 'ls'],
      });

      const push = (type: string, payload: unknown) => {
        const event = this.events.append(sessionId, type, payload);
        emit?.({ type, payload: event.payload });
      };

      this.sessions.updateStatus(sessionId, 'RUNNING');
      push('status', { status: 'RUNNING' });
      push('user_message', { text: prompt });

      let assistantText = '';
      const unsubscribe = session.subscribe((event: { type: string; [key: string]: unknown }) => {
        if (event.type === 'message_update') {
          const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (inner?.type === 'text_delta' && inner.delta) {
            assistantText += inner.delta;
            push('assistant_delta', { delta: inner.delta });
            this.sessions.touchPreview(sessionId, assistantText);
          }
        }
        if (event.type === 'tool_execution_start') {
          push('tool_start', { tool: event.toolName });
        }
        if (event.type === 'tool_execution_end') {
          push('tool_end', { tool: event.toolName, isError: event.isError });
        }
      });

      try {
        await session.prompt(prompt);
        push('assistant_message', { text: assistantText || '(no response)' });
        this.sessions.updateStatus(sessionId, 'IDLE');
        push('status', { status: 'IDLE' });
      } finally {
        unsubscribe();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.append(sessionId, 'error', { message });
      this.sessions.updateStatus(sessionId, 'ERROR');
      emit?.({ type: 'status', payload: { status: 'ERROR' } });
      emit?.({ type: 'error', payload: { message } });
    }
  }
}
