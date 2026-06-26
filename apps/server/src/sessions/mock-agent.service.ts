import { Injectable } from '@nestjs/common';
import { EventsRepository } from './events.repository';
import { SessionsRepository } from './sessions.repository';

export type EventEmitter = (event: { type: string; payload: unknown }) => void;

@Injectable()
export class MockAgentService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
  ) {}

  async run(sessionId: string, prompt: string, emit?: EventEmitter): Promise<void> {
    await this.streamReply(sessionId, prompt, emit, false);
  }

  async steer(sessionId: string, message: string, emit?: EventEmitter): Promise<void> {
    await this.streamReply(sessionId, message, emit, true);
  }

  private async streamReply(
    sessionId: string,
    userText: string,
    emit: EventEmitter | undefined,
    isSteer: boolean,
  ): Promise<void> {
    const push = (type: string, payload: unknown) => {
      const event = this.events.append(sessionId, type, payload);
      emit?.({ type, payload: event.payload });
    };

    this.sessions.updateStatus(sessionId, 'RUNNING');
    push('status', { status: 'RUNNING' });

    if (isSteer) {
      push('steer_message', { text: userText });
    } else {
      push('user_message', { text: userText });
    }

    const reply = isSteer
      ? `Steer received: "${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}". Continuing in mock mode.`
      : 'I received your task. In mock mode (Pi auth not configured), I simulate agent output. ' +
        'Connect ~/.pi/agent/auth.json to use the real Pi harness.';

    for (let i = 0; i < reply.length; i += 8) {
      const delta = reply.slice(i, i + 8);
      push('assistant_delta', { delta });
      this.sessions.touchPreview(sessionId, reply.slice(0, i + 8));
      await sleep(30);
    }

    push('assistant_message', { text: reply });
    this.sessions.updateStatus(sessionId, 'IDLE');
    push('status', { status: 'IDLE' });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
