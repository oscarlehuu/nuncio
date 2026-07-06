import { beforeEach, afterEach, describe, it, expect } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentProvider } from '../../../src/agents/providers/claude-agent.provider';
import type {
  ClaudeQuery,
  ClaudeQueryOptions,
  ClaudeSdkMessage,
} from '../../../src/agents/providers/claude-agent.sdk';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';

/** Query that emits a minimal success turn and records the options it was built with. */
class CapturingQuery implements ClaudeQuery {
  constructor(private readonly sessionId: string) {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    yield { type: 'system', subtype: 'init', session_id: this.sessionId };
    yield { type: 'result', subtype: 'success', result: 'ok' };
  }
}

describe('ClaudeAgentProvider', () => {
  let module: TestingModule;
  let provider: ClaudeAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let settings: SettingsService;
  let dataDir: string;
  let capturedOptions: ClaudeQueryOptions | undefined;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [ClaudeAgentProvider],
    }).compile();
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    settings = module.get(SettingsService);
    provider = module.get(ClaudeAgentProvider);
    provider.bundledBinaryPath = '/fake/claude';
    capturedOptions = undefined;
    provider.queryFactory = ({ options }) => {
      capturedOptions = options;
      return new CapturingQuery('thread-xyz');
    };
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NUNCIO_CLAUDE_BIN;
  });

  it('is available when ANTHROPIC_API_KEY is set (no CLI probe)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    provider.bustCache();
    provider.commandRunner = async () => {
      throw new Error('should not probe when an API key is present');
    };
    expect(await provider.isAvailable()).toBe(true);
  });

  it('is available when the resolver reports logged in', async () => {
    provider.commandRunner = async () => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: '',
    });
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('is unavailable when not logged in and no API key', async () => {
    provider.commandRunner = async () => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
    });
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('strips the claude: prefix, sets founder options, and gates effort on presence', async () => {
    const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:sonnet' });
    await provider.run(created.id, 'hi', {
      cwd: '/tmp/ws',
      model: 'claude:sonnet',
      modelOptions: { effort: 'high' },
    });
    expect(capturedOptions?.model).toBe('sonnet');
    expect(capturedOptions?.permissionMode).toBe('acceptEdits');
    expect(capturedOptions?.settingSources).toEqual([]);
    expect(capturedOptions?.includePartialMessages).toBe(true);
    expect(capturedOptions?.effort).toBe('high');
    expect(capturedOptions?.cwd).toBe('/tmp/ws');
  });

  it('omits effort when no effort option is present (model-gated)', async () => {
    const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
    await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(capturedOptions?.effort).toBeUndefined();
  });

  it('injects ANTHROPIC_API_KEY into env only when set', async () => {
    const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
    await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(capturedOptions?.env).toBeUndefined();

    settings.set('ANTHROPIC_API_KEY', 'sk-live');
    const second = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
    await provider.run(second.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(capturedOptions?.env?.ANTHROPIC_API_KEY).toBe('sk-live');
  });

  it('persists the SDK session_id as providerThreadId and can resume it', async () => {
    const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
    expect(provider.canResumeThread(created)).toBe(false);
    await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    const after = sessions.findById(created.id)!;
    expect(after.providerThreadId).toBe('thread-xyz');
    expect(provider.canResumeThread(after)).toBe(true);
  });

  it('passes resume=providerThreadId when the session already has a thread', async () => {
    const created = sessions.create({
      prompt: 'hi',
      provider: 'claude',
      model: 'claude:haiku',
      providerThreadId: 'prior-thread',
    });
    await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(capturedOptions?.resume).toBe('prior-thread');
  });

  it('a live steer redirect is not treated as the run terminal', async () => {
    // The turn stalls until a priority steer is pushed into the prompt iterable;
    // then it emits the truncated turn's terminal (redirect) followed by the
    // fresh turn's delta + real terminal. The run must resolve on the SECOND
    // result, carrying the redirected answer.
    provider.queryFactory = ({ prompt }) => ({
      async interrupt() {},
      async setModel() {},
      async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 't1' };
        yield {
          type: 'stream_event',
          uuid: 'm1',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'blue' } },
        };
        // Wait for the steer message before ending the first (truncated) turn.
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next(); // the initial prompt
        await iterator.next(); // the steer (priority 'now')
        yield { type: 'result', subtype: 'success', result: '' }; // truncated redirect
        yield {
          type: 'stream_event',
          uuid: 'm2',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PURPLE' } },
        };
        yield { type: 'result', subtype: 'success', result: 'PURPLE' };
      },
    });
    const created = sessions.create({ prompt: 'color?', provider: 'claude', model: 'claude:haiku' });
    const run = provider.run(created.id, 'name a color', { cwd: '/tmp/ws', model: 'claude:haiku' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const steered = await provider.steerMidRun(created.id, 'make it purple', {});
    await run;
    expect(steered).toBe(true);
    const message = events.list(created.id).findLast((event) => event.type === 'assistant_message');
    expect((message?.payload as { text: string }).text).toBe('PURPLE');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('surfaces a clean cannot-resume error when the workspace moved', async () => {
    provider.queryFactory = () => ({
      async interrupt() {},
      async setModel() {},
      async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 't1' };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['No conversation found with session ID: t1'],
        };
      },
    });
    const created = sessions.create({
      prompt: 'hi',
      provider: 'claude',
      model: 'claude:haiku',
      providerThreadId: 't1',
    });
    await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(sessions.findById(created.id)?.status).toBe('ERROR');
  });
});
