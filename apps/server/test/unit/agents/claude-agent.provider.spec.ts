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
    delete process.env.NUNCIO_CLAUDE_PERMISSION_MODE;
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

  describe('permission mode setting', () => {
    it('defaults to acceptEdits when unset', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('acceptEdits');
    });

    it('honours a configured mode and busts on setting change', async () => {
      settings.set('NUNCIO_CLAUDE_PERMISSION_MODE', 'plan');
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('plan');
    });

    it('falls back to acceptEdits for an unknown value (e.g. stale env override)', async () => {
      // The settings service validates the enum on write, so an out-of-band value
      // only reaches the resolver via env; guard against it there.
      process.env.NUNCIO_CLAUDE_PERMISSION_MODE = 'garbage';
      provider.bustCache();
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('acceptEdits');
    });
  });

  describe('runtime tools → in-process MCP server', () => {
    it('registers an mcpServers entry and appendSystemPrompt from context.tools', async () => {
      const create = (opts: { name: string }) => ({ type: 'sdk' as const, name: opts.name, instance: {} });
      provider.createSdkMcpServer = create as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'call the tool', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        tools: {
          systemPromptAppend: 'You have a verify tool.',
          tools: [{ name: 'verify', inputSchema: {}, execute: () => 'ok' }],
        },
      });
      expect(capturedOptions?.mcpServers?.['nuncio-runtime']).toBeDefined();
      expect(capturedOptions?.appendSystemPrompt).toBe('You have a verify tool.');
    });

    it('omits mcpServers when the session has no runtime tools', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.mcpServers).toBeUndefined();
      expect(capturedOptions?.appendSystemPrompt).toBeUndefined();
    });
  });

  describe('canUseTool → approval bridge', () => {
    /**
     * A query that invokes canUseTool during iteration and records the resolved
     * PermissionResult so the test can assert allow/deny mapping.
     */
    function approvalQuery(
      results: Array<{ toolName: string; requestId: string; input?: Record<string, unknown> }>,
      captured: { last?: unknown; all: unknown[] },
    ) {
      return ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          for (const r of results) {
            const decision = await options.canUseTool(
              r.toolName,
              r.input ?? { command: 'curl x' },
              { requestId: r.requestId, displayName: r.toolName, description: 'a path' },
            );
            captured.last = decision;
            captured.all.push(decision);
          }
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
    }

    it('approve → allow echoing the input', async () => {
      const captured: { last?: unknown; all: unknown[] } = { all: [] };
      provider.queryFactory = approvalQuery([{ toolName: 'Bash', requestId: 'sdk-1' }], captured) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const approve = async (request: unknown) => {
        // Resolve the card immediately with approve.
        void request;
        return { requestId: 'nuncio-1', decision: 'approve' as const };
      };
      await provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        requestProviderApproval: approve,
      });
      expect(captured.last).toEqual({ behavior: 'allow', updatedInput: { command: 'curl x' } });
    });

    it('deny → deny with a message', async () => {
      const captured: { last?: unknown; all: unknown[] } = { all: [] };
      provider.queryFactory = approvalQuery([{ toolName: 'Bash', requestId: 'sdk-2' }], captured) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        requestProviderApproval: async () => ({ requestId: 'n', decision: 'deny' as const }),
      });
      expect((captured.last as { behavior: string }).behavior).toBe('deny');
    });

    it('dedupes a redelivered requestId to one approval card', async () => {
      let calls = 0;
      let releaseHook!: () => void;
      const hookGate = new Promise<void>((resolve) => (releaseHook = resolve));
      const decisions: Array<{ behavior: string }> = [];
      // The SDK redelivers the same control_request BEFORE the first resolves:
      // fire both canUseTool invocations concurrently with one shared requestId.
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          const both = await Promise.all([
            options.canUseTool('Bash', { command: 'x' }, { requestId: 'dup' }),
            options.canUseTool('Bash', { command: 'x' }, { requestId: 'dup' }),
          ]);
          decisions.push(...(both as Array<{ behavior: string }>));
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      }) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        requestProviderApproval: async () => {
          calls += 1;
          await hookGate;
          return { requestId: 'n', decision: 'approve' as const };
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      releaseHook();
      await run;
      expect(calls).toBe(1);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toEqual(decisions[1]);
    });

    it('fails closed (deny) when the run has no approval hook', async () => {
      const captured: { last?: unknown; all: unknown[] } = { all: [] };
      provider.queryFactory = approvalQuery([{ toolName: 'Bash', requestId: 'sdk-3' }], captured) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'run curl', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect((captured.last as { behavior: string }).behavior).toBe('deny');
    });

    it('aborting the session denies a parked callback (fail-closed lifecycle)', async () => {
      let resolved: { behavior: string } | undefined;
      // Never-resolving approval hook so the callback parks until dispose aborts.
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          const decision = await options.canUseTool('Bash', { command: 'x' }, { requestId: 'park' });
          resolved = decision;
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      }) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        requestProviderApproval: () => new Promise(() => {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      provider.dispose(created.id);
      await run.catch(() => {});
      expect(resolved?.behavior).toBe('deny');
    });

    it('submitInteraction resolves a parked callback with an always-allow round-trip', async () => {
      let resolved: { behavior: string; updatedPermissions?: unknown[] } | undefined;
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          const decision = await options.canUseTool(
            'Bash',
            { command: 'x' },
            { requestId: 'park2', suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
          );
          resolved = decision as never;
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      }) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        // Never resolves via the card; submitInteraction settles it.
        requestProviderApproval: () => new Promise(() => {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      await provider.submitInteraction(created.id, 'park2', {
        answers: [{ questionId: 'q', selectedOptionIds: ['always'] }],
        resolvedBy: 'user',
      });
      await run;
      expect(resolved?.behavior).toBe('allow');
      expect(resolved?.updatedPermissions).toHaveLength(1);
    });

    it('submitInteraction throws for an unknown requestId', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      await expect(
        provider.submitInteraction(created.id, 'nope', { answers: [], resolvedBy: 'skip' }),
      ).rejects.toThrow();
    });

    it('interrupt denies a parked callback (the tool will not run)', async () => {
      let resolved: { behavior: string } | undefined;
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          const decision = await options.canUseTool('Bash', { command: 'x' }, { requestId: 'park3' });
          resolved = decision;
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      }) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        requestProviderApproval: () => new Promise(() => {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      await provider.interrupt(created.id);
      await run;
      expect(resolved?.behavior).toBe('deny');
    });

    it('supportsInteraction is true', () => {
      expect(provider.supportsInteraction()).toBe(true);
    });
  });
});
