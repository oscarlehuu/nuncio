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
  /** How many executePrompt calls are executing concurrently right now. */
  activePrompts = 0;
  /** Set true if two turns for the same session ever overlap (a race). */
  sawOverlap = false;

  private available = true;
  private failNextTurns = 0;
  private failNextSteers = 0;
  private availabilityDelayMs = 0;

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  /** Delay isAvailable() to widen the resolve-availability window for race tests. */
  setAvailabilityDelay(ms: number): void {
    this.availabilityDelayMs = ms;
  }

  /** Reject the next `n` executePrompt calls of any kind (default 1). */
  failNext(n = 1): void {
    this.failNextTurns = n;
  }

  /** Reject the next `n` STEER executePrompt calls only (auto-steers included). */
  failNextSteer(n = 1): void {
    this.failNextSteers = n;
  }

  /** Flip availability so AgentRegistry.resolveAvailableForSession throws. */
  setAvailable(value: boolean): void {
    this.available = value;
  }

  async isAvailable(): Promise<boolean> {
    if (this.availabilityDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.availabilityDelayMs));
    }
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
    if (isSteer && this.failNextSteers > 0) {
      this.failNextSteers -= 1;
      throw new Error('controllable provider: forced steer failure');
    }
    if (this.failNextTurns > 0) {
      this.failNextTurns -= 1;
      throw new Error('controllable provider: forced turn failure');
    }
    // Overlap detection: if a turn is already executing for this provider when
    // another enters, two turns are running concurrently — a race.
    if (this.activePrompts > 0) this.sawOverlap = true;
    this.activePrompts += 1;
    try {
      await new Promise((r) => setTimeout(r, 30));
      const reply = isSteer
        ? `ack steer: ${userText.slice(0, 40)}`
        : 'ack run: controllable provider reply';
      this.pushEvent(sessionId, 'assistant_message', { text: reply }, context.emit);
    } finally {
      this.activePrompts -= 1;
    }
  }
}
