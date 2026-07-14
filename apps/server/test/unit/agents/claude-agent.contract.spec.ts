import { beforeEach, afterEach, describe, expect } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentProvider } from '../../../src/agents/providers/claude-agent.provider';
import type {
  ClaudeQuery,
  ClaudeSdkMessage,
  ClaudeUserMessage,
} from '../../../src/agents/providers/claude-agent.sdk';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { describeAgentProviderContract } from './provider-contract.suite';

type Script =
  | { kind: 'success'; deltas: string[]; finalText: string }
  | { kind: 'error' }
  | { kind: 'interrupt' }
  | { kind: 'midRunSteer' };

/**
 * A scriptable stand-in for the SDK `query()` handle. It mirrors the real
 * message ordering (system/init → stream_event deltas → result) so the contract
 * exercises the provider's real mapping and terminal-result classification. The
 * factory closes over a mutable `script` the harness re-arranges per scenario.
 */
class FakeClaudeQuery implements ClaudeQuery {
  private interruptRequested = false;
  /** When set by the harness, unblocks a midRunSteer stall after steerMidRun lands. */
  releaseMidRunSteer: (() => void) | null = null;

  constructor(
    private readonly getScript: () => Script,
    private readonly sessionId = 'claude-session-1',
  ) {}

  async interrupt(): Promise<void> {
    this.interruptRequested = true;
  }

  async setModel(): Promise<void> {}

  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    const script = this.getScript();
    yield { type: 'system', subtype: 'init', session_id: this.sessionId };

    if (script.kind === 'success') {
      for (const [index, delta] of script.deltas.entries()) {
        yield {
          type: 'stream_event',
          // Same uuid across deltas of one turn → no glued-text separator, so
          // the contract's coalescing assertion stays provider-agnostic.
          uuid: 'msg-1',
          event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } },
        };
      }
      yield { type: 'result', subtype: 'success', result: script.finalText };
      return;
    }

    if (script.kind === 'error') {
      // A genuine failure subtype (not an interrupt / cannot-resume) → ERROR.
      yield { type: 'result', subtype: 'error_max_turns', errors: ['exceeded max turns'] };
      return;
    }

    if (script.kind === 'midRunSteer') {
      // Stall until the harness calls steerMidRun and releases the turn.
      await new Promise<void>((resolve) => {
        this.releaseMidRunSteer = resolve;
      });
      yield { type: 'result', subtype: 'success', result: 'after mid-run steer' };
      return;
    }

    // interrupt: stall until interrupt() lands, then emit the aborted terminal
    // the SDK sends for query.interrupt() — an error subtype that must map to a
    // clean stop, not ERROR.
    for (let i = 0; i < 200 && !this.interruptRequested; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_tools',
      errors: [],
    };
  }
}

describe('ClaudeAgentProvider contract', () => {
  let module: TestingModule;
  let provider: ClaudeAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let script: Script;
  let fakeQuery: FakeClaudeQuery;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-contract-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [ClaudeAgentProvider],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = module.get(ClaudeAgentProvider);

    script = { kind: 'success', deltas: [], finalText: '' };
    fakeQuery = new FakeClaudeQuery(() => script);
    provider.queryFactory = () => fakeQuery;
    // Availability without spawning a real CLI: pretend a logged-in bundled binary.
    provider.bundledBinaryPath = '/fake/claude';
    provider.commandRunner = async () => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }),
      stderr: '',
    });
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describeAgentProviderContract('claude', () => ({
    provider,
    sessions,
    events,
    runContext: { cwd: '/tmp/project', model: 'claude:haiku' },
    createSession: (prompt) =>
      sessions.create({ prompt, provider: 'claude', model: 'claude:haiku' }),
    successDeltas: ['Claude ', 'stream 世界'],
    successFinalText: 'Claude stream 世界',
    arrangeSuccess: (deltas, finalText) => {
      script = { kind: 'success', deltas, finalText };
    },
    arrangeError: () => {
      script = { kind: 'error' };
    },
    exercisesInterrupt: true,
    arrangeAndInterrupt: async (sessionId, emit) => {
      script = { kind: 'interrupt' };
      const run = provider.run(sessionId, 'interruptible', {
        cwd: '/tmp/project',
        model: 'claude:haiku',
        emit,
      });
      // Let the run reach the stalled delta loop, then interrupt.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await provider.interrupt(sessionId);
      await run;
    },
    exercisesSteerMidRun: true,
    arrangeMidRunSteer: async (sessionId, emit) => {
      script = { kind: 'midRunSteer' };
      const run = provider.run(sessionId, 'steer while streaming', {
        cwd: '/tmp/project',
        model: 'claude:haiku',
        emit,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const delivered = await provider.steerMidRun!(sessionId, 'steer while streaming', {
        cwd: '/tmp/project',
        model: 'claude:haiku',
        emit,
      });
      expect(delivered).toBe(true);
      fakeQuery.releaseMidRunSteer?.();
      await run;
    },
  }));
});
