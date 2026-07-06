import { Injectable } from '@nestjs/common';
import type { ModelProviderDto } from '../../src/models/models.types';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../../src/agents/agents.types';
import { BaseAgentProvider } from '../../src/agents/agents.base-provider';

/**
 * Test-only agent whose behaviour the test controls turn-by-turn:
 *  - counts every executePrompt (run + steer) so a test can prove the provider
 *    actually ran after an auto-steer (not just that a steer_message was logged);
 *  - can be armed to REJECT the next executePrompt, exercising the loop's
 *    provider-failure path;
 *  - can be flipped unavailable so re-resolution for an auto-steer fails.
 *
 * Registered under an existing provider id (default 'cursor') via
 * `overrideProvider`, so it flows through AgentRegistry unchanged (ADR-004: no
 * engine-specific branch — the loop cannot tell this apart from a real engine).
 */
@Injectable()
export class ControllableAgentProvider extends BaseAgentProvider {
  readonly id = 'cursor';
  readonly name = 'Cursor (controllable)';

  /** Count of executePrompt calls (run + steer). */
  promptRuns = 0;
  /** Count of steer-driven executePrompt calls only. */
  steerRuns = 0;

  private available = true;
  private failNextTurns = 0;

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  /** Reject the next `n` executePrompt calls (default 1). */
  failNext(n = 1): void {
    this.failNextTurns = n;
  }

  /** Flip availability so AgentRegistry.resolveAvailableForSession throws. */
  setAvailable(value: boolean): void {
    this.available = value;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return [
      {
        id: this.id,
        name: this.name,
        groups: [{ id: 'cursor', name: 'Cursor', models: [{ id: 'cursor:test', name: 'Test' }] }],
      },
    ];
  }

  protected async executePrompt(
    sessionId: string,
    userText: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    this.promptRuns += 1;
    if (isSteer) this.steerRuns += 1;
    if (this.failNextTurns > 0) {
      this.failNextTurns -= 1;
      throw new Error('controllable provider: forced turn failure');
    }
    const reply = isSteer
      ? `ack steer: ${userText.slice(0, 40)}`
      : 'ack run: controllable provider reply';
    this.pushEvent(sessionId, 'assistant_message', { text: reply }, context.emit);
  }
}
