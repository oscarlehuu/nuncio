import { Injectable } from '@nestjs/common';
import type { ModelProviderDto } from '../../src/models/models.types';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../../src/agents/agents.types';
import { BaseAgentProvider } from '../../src/agents/agents.base-provider';

/** Test-only Cursor stand-in: simulates token streaming without the real SDK. */
@Injectable()
export class SimulatedCursorAgentProvider extends BaseAgentProvider {
  readonly id = 'cursor';
  readonly name = 'Cursor';

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
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }],
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
      ? `Steer received: "${userText.slice(0, 60)}${userText.length > 60 ? '...' : ''}". Continuing.`
      : 'Task received. Simulated cursor agent response for tests.';

    for (let i = 0; i < reply.length; i += 8) {
      const delta = reply.slice(i, i + 8);
      this.pushEvent(sessionId, 'assistant_delta', { delta }, context.emit);
      this.sessions.touchPreview(sessionId, reply.slice(0, i + 8));
      await sleep(10);
    }

    this.pushEvent(sessionId, 'assistant_message', { text: reply }, context.emit);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
