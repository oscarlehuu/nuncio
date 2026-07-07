import { Injectable } from '@nestjs/common';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';

/**
 * Zero-credential fallback engine. Registered ONLY when the operator opts in with
 * `NUNCIO_FORCE_MOCK=1` (see `AgentsModule`) so it never appears in a normal boot
 * or the real model picker. Its purpose is deterministic, offline lifecycle
 * exercise — the scripted level-5 UI smoke drives create → stream → steer →
 * archive against it without touching a real provider or network.
 */
@Injectable()
export class MockAgentProvider extends BaseAgentProvider {
  readonly id = 'mock';
  readonly name = 'Mock';

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return [
      {
        id: this.id,
        name: this.name,
        sub: 'Local fallback agent',
        icon: 'M',
        groups: [
          {
            id: 'mock',
            name: 'Mock',
            sub: 'No external auth required',
            models: [
              {
                id: 'mock:default',
                name: 'Mock Agent',
                sub: 'Simulated response stream',
                badge: 'local',
              },
            ],
          },
        ],
      },
    ];
  }

  protected async executePrompt(
    sessionId: string,
    userText: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const reply = isSteer
      ? `Steer received: "${userText.slice(0, 60)}${userText.length > 60 ? '...' : ''}". Continuing in mock mode.`
      : 'I received your task. In mock mode (agent auth not configured), I simulate agent output. ' +
        'Configure a real provider to use an agent SDK harness.';

    for (let i = 0; i < reply.length; i += 8) {
      const delta = reply.slice(i, i + 8);
      this.pushEvent(sessionId, 'assistant_delta', { delta }, context.emit);
      this.touchPreview(sessionId, reply.slice(0, i + 8));
      await sleep(30);
    }

    this.pushEvent(sessionId, 'assistant_message', { text: reply }, context.emit);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
