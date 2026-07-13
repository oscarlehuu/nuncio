import { beforeEach, afterEach, describe, it, expect } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentProvider } from '../../../src/agents/providers/claude-agent.provider';
import { buildAgentRuntimeEnvironment } from '../../../src/agents/runtime-environment';
import { defineCrewRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools-policy';
import {
  CLAUDE_RUNTIME_MCP_SERVER,
  type ClaudeMcpToolDefinition,
} from '../../../src/agents/tools/claude-runtime-tools.adapter';
import type {
  ClaudeQuery,
  ClaudeQueryOptions,
  ClaudeSdkMessage,
  ClaudeUserMessage,
} from '../../../src/agents/providers/claude-agent.sdk';
// ClaudeQuery is used to type the image-capture fake query below.
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

  it('strips the claude: prefix, applies configured options, and gates effort on presence', async () => {
    const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:sonnet' });
    await provider.run(created.id, 'hi', {
      cwd: '/tmp/ws',
      model: 'claude:sonnet',
      modelOptions: { effort: 'high' },
    });
    expect(capturedOptions?.model).toBe('sonnet');
    expect(capturedOptions?.permissionMode).toBe('bypassPermissions');
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

  it('returns a persisted steer to the normal queue when the live turn ends during recovery', async () => {
    let finishTurn: () => void = () => undefined;
    provider.queryFactory = () => ({
      async interrupt() {},
      async setModel() {},
      async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 't-stale-steer' };
        await new Promise<void>((resolve) => { finishTurn = resolve; });
        yield { type: 'result', subtype: 'success', result: '' };
      },
    });
    const created = sessions.create({ prompt: 'long turn', provider: 'claude', model: 'claude:haiku' });
    const run = provider.run(created.id, created.prompt, {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const originalAppend = events.append.bind(events);
    let blockReservation = true;
    events.append = ((sessionId: string, type: string, payload: unknown, notify?: boolean) => {
      if (type === 'steer_reserved' && blockReservation) throw new Error('storage unavailable');
      return originalAppend(sessionId, type, payload, notify);
    }) as EventsRepository['append'];

    const steering = provider.steerMidRun(created.id, 'queue me after recovery', {});
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishTurn();
      const retained = (provider as unknown as {
        retainedEvents: Map<string, Array<{ type: string; payload: unknown }>>;
      }).retainedEvents;
      const started = Date.now();
      while (
        !retained.get(created.id)?.some((event) =>
          event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE') &&
        Date.now() - started < 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      blockReservation = false;

      expect(await steering).toBe(false);
      await run;
      expect(events.list(created.id).some((event) => event.type === 'steer_message')).toBe(false);
      expect(events.list(created.id).some((event) => event.type === 'steer_reserved')).toBe(true);
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
    } finally {
      blockReservation = false;
      events.append = originalAppend as EventsRepository['append'];
      finishTurn();
      await Promise.allSettled([steering, run]);
    }
  });

  it('two priority steers in one turn each swallow their truncated terminal', async () => {
    // Two `priority:'now'` steers cut the in-flight turn short twice. Each
    // truncated terminal is a redirect the run must swallow; only the FINAL
    // turn's result is the real terminal. The pendingRedirects counter must
    // track both and never mis-classify the real terminal.
    provider.queryFactory = ({ prompt }) => ({
      async interrupt() {},
      async setModel() {},
      async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 't1' };
        yield {
          type: 'stream_event',
          uuid: 'm1',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } },
        };
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next(); // initial prompt
        await iterator.next(); // first steer
        yield { type: 'result', subtype: 'success', result: '' }; // first truncated redirect
        yield {
          type: 'stream_event',
          uuid: 'm2',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } },
        };
        await iterator.next(); // second steer
        yield { type: 'result', subtype: 'success', result: '' }; // second truncated redirect
        yield {
          type: 'stream_event',
          uuid: 'm3',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FINAL' } },
        };
        yield { type: 'result', subtype: 'success', result: 'FINAL' };
      },
    });
    const created = sessions.create({ prompt: 'q', provider: 'claude', model: 'claude:haiku' });
    const run = provider.run(created.id, 'first', { cwd: '/tmp/ws', model: 'claude:haiku' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await provider.steerMidRun(created.id, 'steer one', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    await provider.steerMidRun(created.id, 'steer two', {});
    await run;
    const message = events.list(created.id).findLast((event) => event.type === 'assistant_message');
    expect((message?.payload as { text: string }).text).toBe('FINAL');
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
    const failed = sessions.findById(created.id)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.providerThreadId).toBeNull();
    expect(provider.canResumeThread(failed)).toBe(false);
  });

  it('preserves a resumed thread after a transient iterator failure and retries it natively', async () => {
    const resumeOptions: Array<string | undefined> = [];
    let attempt = 0;
    provider.queryFactory = ({ options }) => {
      resumeOptions.push(options.resume);
      attempt += 1;
      if (attempt === 1) {
        return {
          async interrupt() {},
          async setModel() {},
          async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
            yield { type: 'system', subtype: 'init', session_id: 'durable-thread' };
            throw new Error('temporary Claude transport failure');
          },
        };
      }
      return new CapturingQuery('durable-thread');
    };
    const created = sessions.create({
      prompt: 'continue',
      provider: 'claude',
      model: 'claude:haiku',
      providerThreadId: 'durable-thread',
    });

    await provider.run(created.id, 'continue', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(sessions.findById(created.id)).toMatchObject({
      status: 'ERROR',
      providerThreadId: 'durable-thread',
    });

    await provider.steer(created.id, 'retry', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(resumeOptions).toEqual(['durable-thread', 'durable-thread']);
    expect(sessions.findById(created.id)).toMatchObject({
      status: 'IDLE',
      providerThreadId: 'durable-thread',
    });
  });

  describe('permission mode setting', () => {
    it('defaults to bypassPermissions when unset', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('bypassPermissions');
    });

    it('honours a configured mode and busts on setting change', async () => {
      settings.set('NUNCIO_CLAUDE_PERMISSION_MODE', 'plan');
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('plan');
    });

    it('falls back to bypassPermissions for an unknown value (e.g. stale env override)', async () => {
      // The settings service validates the enum on write, so an out-of-band value
      // only reaches the resolver via env; guard against it there.
      process.env.NUNCIO_CLAUDE_PERMISSION_MODE = 'garbage';
      provider.bustCache();
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.permissionMode).toBe('bypassPermissions');
    });

    it('an explicit read-only policy overrides global bypass and denies mutation before approval', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-claude-policy-'));
      process.env.NUNCIO_CLAUDE_PERMISSION_MODE = 'bypassPermissions';
      provider.bustCache();
      try {
        const created = sessions.create({
          prompt: 'review only',
          provider: 'claude',
          model: 'claude:haiku',
          providerThreadId: 'existing-policy-thread',
        });
        await provider.run(created.id, 'review only', {
          cwd: workspaceRoot,
          model: 'claude:haiku',
          runtimePolicy: {
            filesystem: 'read-only',
            workspaceRoot,
            network: 'disabled',
          },
          requestProviderApproval: async () => ({ requestId: 'must-not-ask', decision: 'approve' }),
        });

        const policyOptions = capturedOptions as ClaudeQueryOptions & {
          tools?: string[];
          hooks?: {
            PreToolUse?: Array<{
              hooks: Array<(input: unknown, toolUseId?: string) => Promise<Record<string, unknown>>>;
            }>;
          };
        };
        expect(provider.capabilities.runtimePolicies).toContainEqual({
          filesystem: 'read-only',
          network: 'disabled',
        });
        expect(policyOptions.permissionMode).toBe('default');
        expect(policyOptions.resume).toBe('existing-policy-thread');
        expect(policyOptions.tools).toEqual(['Read', 'Grep', 'Glob']);
        const hook = policyOptions.hooks?.PreToolUse?.[0]?.hooks[0];
        expect(hook).toBeFunction();
        const denied = await hook!({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: join(workspaceRoot, 'forbidden.txt'), content: 'no' },
        });
        expect(denied).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: 'deny',
          },
        });
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('workspace-write allows in-root edits but denies siblings, symlinks, and shell', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-claude-workspace-'));
      const sibling = mkdtempSync(join(tmpdir(), 'nuncio-claude-sibling-'));
      symlinkSync(sibling, join(workspaceRoot, 'escape'), 'dir');
      mkdirSync(join(workspaceRoot, '.git'));
      writeFileSync(join(workspaceRoot, '.git', 'config'), '[core]\n');
      try {
        const created = sessions.create({ prompt: 'build', provider: 'claude', model: 'claude:haiku' });
        await provider.run(created.id, 'build', {
          cwd: workspaceRoot,
          model: 'claude:haiku',
          runtimePolicy: {
            filesystem: 'workspace-write',
            workspaceRoot,
            network: 'disabled',
          },
        });

        const options = capturedOptions as ClaudeQueryOptions & { tools?: string[] };
        expect(options.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
        await expect(
          options.canUseTool(
            'Write',
            { file_path: join(workspaceRoot, 'inside.txt'), content: 'ok' },
            { requestId: 'inside' },
          ),
        ).resolves.toMatchObject({ behavior: 'allow' });
        await expect(
          options.canUseTool(
            'Read',
            { file_path: join(workspaceRoot, '.git', 'config') },
            { requestId: 'git-read' },
          ),
        ).resolves.toMatchObject({ behavior: 'allow' });
        await expect(
          options.canUseTool(
            'Write',
            { file_path: join(workspaceRoot, '.git', 'config'), content: 'corrupt' },
            { requestId: 'git-write' },
          ),
        ).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('Git metadata') });
        await expect(
          options.canUseTool(
            'Write',
            { file_path: join(workspaceRoot, '.git'), content: 'corrupt pointer' },
            { requestId: 'git-pointer-write' },
          ),
        ).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('Git metadata') });
        await expect(
          options.canUseTool(
            'Write',
            { file_path: join(sibling, 'outside.txt'), content: 'no' },
            { requestId: 'outside' },
          ),
        ).resolves.toMatchObject({ behavior: 'deny' });
        await expect(
          options.canUseTool(
            'Write',
            { file_path: join(workspaceRoot, 'escape', 'outside.txt'), content: 'no' },
            { requestId: 'symlink' },
          ),
        ).resolves.toMatchObject({ behavior: 'deny' });
        await expect(
          options.canUseTool('Bash', { command: 'curl example.com' }, { requestId: 'shell' }),
        ).resolves.toMatchObject({ behavior: 'deny' });
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
        rmSync(sibling, { recursive: true, force: true });
      }
    });
  });

  describe('runtime tools → in-process MCP server', () => {
    it('keeps all Nuncio runtime instructions in the system prompt and user turns exact', async () => {
      const create = (opts: { name: string }) => ({ type: 'sdk' as const, name: opts.name, instance: {} });
      provider.createSdkMcpServer = create as never;
      const receivedUserTexts: string[] = [];
      provider.queryFactory = ({ prompt, options }) => {
        capturedOptions = options;
        return {
          async interrupt() {},
          async setModel() {},
          async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
            yield { type: 'system', subtype: 'init', session_id: 'thread-runtime' };
            for await (const message of prompt) {
              const content = message.message.content;
              receivedUserTexts.push(typeof content === 'string' ? content : '');
              yield { type: 'result', subtype: 'success', result: 'ok' };
            }
          },
        };
      };
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const tools = {
        systemPromptAppend: 'You have a verify tool.',
        tools: [{ name: 'verify', inputSchema: {}, execute: () => 'ok' }],
      };
      const runtimeEnvironment = buildAgentRuntimeEnvironment({
        sessionId: created.id,
        provider: 'claude',
        model: 'claude:haiku',
        projectPath: null,
        cwd: '/tmp/ws',
        supportsInteraction: true,
        runtimeTools: tools,
      });
      const context = {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        tools,
        runtimeEnvironment,
      };
      await provider.run(created.id, 'call the tool', context);
      await provider.steer(created.id, 'continue exactly', context);
      expect(capturedOptions?.mcpServers?.['nuncio-runtime']).toBeDefined();
      expect(capturedOptions?.appendSystemPrompt).toContain('running inside Nuncio');
      expect(capturedOptions?.appendSystemPrompt).toContain('You have a verify tool.');
      expect(capturedOptions?.appendSystemPrompt).toContain('available tools: verify');
      expect(receivedUserTexts).toEqual(['call the tool', 'continue exactly']);
    });

    it('omits mcpServers when the session has no runtime tools', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(capturedOptions?.mcpServers).toBeUndefined();
      expect(capturedOptions?.appendSystemPrompt).toBeUndefined();
    });

    it('drops unrestricted runtime tools when an explicit policy is active', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-claude-no-runtime-tools-'));
      try {
        const create = (opts: { name: string }) => ({ type: 'sdk' as const, name: opts.name, instance: {} });
        provider.createSdkMcpServer = create as never;
        const created = sessions.create({ prompt: 'review', provider: 'claude', model: 'claude:haiku' });
        await provider.run(created.id, 'review', {
          cwd: workspaceRoot,
          model: 'claude:haiku',
          runtimePolicy: {
            filesystem: 'read-only',
            workspaceRoot,
            network: 'disabled',
          },
          tools: {
            systemPromptAppend: 'Open the browser.',
            tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'opened' }],
          },
        });
        expect(capturedOptions?.mcpServers).toBeUndefined();
        expect(capturedOptions?.appendSystemPrompt).toBeUndefined();
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('explicit policies allow only exact trusted Crew MCP submission names', async () => {
      for (const testCase of [
        { filesystem: 'read-only' as const, toolName: 'submit_plan', builtins: ['Read', 'Grep', 'Glob'] },
        {
          filesystem: 'workspace-write' as const,
          toolName: 'submit_build',
          builtins: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        },
      ]) {
        const workspaceRoot = mkdtempSync(join(tmpdir(), `nuncio-claude-${testCase.toolName}-`));
        const calls: Array<Record<string, unknown>> = [];
        let definitions: ClaudeMcpToolDefinition[] = [];
        try {
          provider.createSdkMcpServer = ((options: {
            name: string;
            tools: ClaudeMcpToolDefinition[];
          }) => {
            definitions = options.tools;
            return { type: 'sdk' as const, name: options.name, instance: {} };
          }) as never;
          const security = {
            network: 'disabled' as const,
            workspaceMutation: 'none' as const,
            runtimePolicies: [
              { filesystem: 'read-only' as const, network: 'disabled' as const },
              { filesystem: 'workspace-write' as const, network: 'disabled' as const },
            ],
            scope: 'crew-internal' as const,
          };
          const trusted = defineCrewRuntimeTool({
            name: testCase.toolName,
            inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
            security,
            execute: async (input: Record<string, unknown>) => {
              calls.push(input);
              return `stored ${testCase.toolName}`;
            },
          });
          const created = sessions.create({
            prompt: testCase.toolName,
            provider: 'claude',
            model: 'claude:haiku',
          });

          await provider.run(created.id, created.prompt, {
            cwd: workspaceRoot,
            model: 'claude:haiku',
            runtimePolicy: {
              filesystem: testCase.filesystem,
              workspaceRoot,
              network: 'disabled',
            },
            tools: {
              tools: [
                trusted,
                {
                  name: 'forged_submit',
                  inputSchema: {},
                  security,
                  execute: async () => 'must not run',
                },
                { name: 'browser_open', inputSchema: {}, execute: async () => 'unsafe' },
              ],
            },
          });

          const exactMcpName = `mcp__${CLAUDE_RUNTIME_MCP_SERVER}__${testCase.toolName}`;
          const options = capturedOptions as ClaudeQueryOptions & { tools?: string[] };
          expect(options.tools).toEqual([...testCase.builtins, exactMcpName]);
          expect(definitions.map((definition) => definition.name)).toEqual([testCase.toolName]);
          await expect(
            options.canUseTool(exactMcpName, { marker: testCase.toolName }, { requestId: 'crew-safe' }),
          ).resolves.toMatchObject({ behavior: 'allow' });
          await expect(
            options.canUseTool(
              `mcp__${CLAUDE_RUNTIME_MCP_SERVER}__browser_open`,
              {},
              { requestId: 'browser-unsafe' },
            ),
          ).resolves.toMatchObject({ behavior: 'deny' });

          const result = await definitions[0]!.handler({ marker: testCase.toolName });
          expect(calls).toEqual([{ marker: testCase.toolName }]);
          expect(result.content).toEqual([{ type: 'text', text: `stored ${testCase.toolName}` }]);
        } finally {
          rmSync(workspaceRoot, { recursive: true, force: true });
        }
      }
    });
  });

  describe('follow-up turn → rebuild MCP servers when the toolset changes', () => {
    /**
     * A multi-turn query: each turn consumes one prompt then emits a terminal.
     * Records every setMcpServers call so the test can assert whether a follow-up
     * turn rebuilt the toolset. `supportsSetMcpServers:false` omits the method to
     * exercise the graceful-skip path.
     */
    function multiTurnQuery(records: Array<Record<string, unknown>>, supportsSetMcpServers = true) {
      return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const promptIterator = prompt[Symbol.asyncIterator]();
        async function* turns(): AsyncGenerator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          await promptIterator.next();
          yield { type: 'result', subtype: 'success', result: 'one' };
          await promptIterator.next();
          yield { type: 'result', subtype: 'success', result: 'two' };
        }
        const gen = turns();
        const query: Record<string, unknown> = {
          async interrupt() {},
          async setModel() {},
          [Symbol.asyncIterator]() {
            return gen;
          },
        };
        if (supportsSetMcpServers) {
          query.setMcpServers = async (servers: Record<string, unknown>) => {
            records.push(servers);
          };
        }
        return query as unknown as ClaudeQuery;
      };
    }

    const toolset = (name: string) => ({
      tools: [{ name, inputSchema: {}, execute: () => 'ok' }],
    });

    it('resumes with refreshed native system instructions when runtime context changes', async () => {
      const optionRecords: ClaudeQueryOptions[] = [];
      const receivedUserTexts: string[] = [];
      provider.createSdkMcpServer = ((opts: { name: string }) => ({
        type: 'sdk' as const,
        name: opts.name,
        instance: {},
      })) as never;
      provider.queryFactory = (({ prompt, options }: {
        prompt: AsyncIterable<ClaudeUserMessage>;
        options: ClaudeQueryOptions;
      }) => {
        optionRecords.push(options);
        return {
          async interrupt() {},
          async setModel() {},
          async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
            const message = await prompt[Symbol.asyncIterator]().next();
            const content = message.value?.message.content;
            receivedUserTexts.push(typeof content === 'string' ? content : '');
            yield { type: 'system', subtype: 'init', session_id: 'thread-refresh' };
            yield { type: 'result', subtype: 'success', result: 'ok' };
          },
        };
      }) as never;

      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const firstTools = toolset('verify');
      const secondTools = toolset('deploy');
      const firstEnvironment = buildAgentRuntimeEnvironment({
        sessionId: created.id,
        provider: 'claude',
        model: 'claude:haiku',
        projectPath: null,
        cwd: '/tmp/ws',
        supportsInteraction: true,
        runtimeTools: firstTools,
      });
      const secondEnvironment = buildAgentRuntimeEnvironment({
        sessionId: created.id,
        provider: 'claude',
        model: 'claude:haiku',
        projectPath: null,
        cwd: '/tmp/ws',
        supportsInteraction: true,
        runtimeTools: secondTools,
      });

      await provider.run(created.id, 'first exact', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        tools: firstTools,
        runtimeEnvironment: firstEnvironment,
      });
      await provider.steer(created.id, 'second exact', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        tools: secondTools,
        runtimeEnvironment: secondEnvironment,
      });

      expect(optionRecords).toHaveLength(2);
      expect(optionRecords[0]?.appendSystemPrompt).toContain('available tools: verify');
      expect(optionRecords[1]?.appendSystemPrompt).toContain('available tools: deploy');
      expect(optionRecords[1]?.resume).toBe('thread-refresh');
      expect(receivedUserTexts).toEqual(['first exact', 'second exact']);
    });

    it('does not call setMcpServers when the follow-up toolset is unchanged', async () => {
      const records: Array<Record<string, unknown>> = [];
      provider.createSdkMcpServer = ((opts: { name: string }) => ({
        type: 'sdk' as const,
        name: opts.name,
        instance: {},
      })) as never;
      provider.queryFactory = multiTurnQuery(records) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const tools = toolset('verify');
      await provider.run(created.id, 'first', { cwd: '/tmp/ws', model: 'claude:haiku', tools });
      await provider.steer(created.id, 'second', { cwd: '/tmp/ws', model: 'claude:haiku', tools });
      expect(records).toHaveLength(0);
    });

    it('refreshes stable Crew MCP definitions so a follow-up executes the current closure', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-claude-crew-refresh-'));
      const records: Array<Record<string, unknown>> = [];
      const definitionBatches: ClaudeMcpToolDefinition[][] = [];
      const calls: string[] = [];
      try {
        provider.createSdkMcpServer = ((opts: {
          name: string;
          tools: ClaudeMcpToolDefinition[];
        }) => {
          definitionBatches.push(opts.tools);
          return { type: 'sdk' as const, name: opts.name, instance: {} };
        }) as never;
        provider.queryFactory = multiTurnQuery(records) as never;
        const created = sessions.create({
          prompt: 'plan',
          provider: 'claude',
          model: 'claude:haiku',
        });
        const runtimePolicy = {
          filesystem: 'read-only' as const,
          workspaceRoot,
          network: 'disabled' as const,
        };
        const crewTools = (revision: number) => ({
          tools: ['plan', 'synthesis'].map((kind) => defineCrewRuntimeTool({
            name: `submit_${kind}`,
            inputSchema: {
              type: 'object',
              properties: { contextRevision: { type: 'integer' } },
            },
            security: {
              network: 'disabled' as const,
              workspaceMutation: 'none' as const,
              runtimePolicies: [
                { filesystem: 'read-only' as const, network: 'disabled' as const },
              ],
              scope: 'crew-internal' as const,
            },
            execute: async () => {
              calls.push(`${kind}:${revision}`);
              return `${kind} revision ${revision}`;
            },
          })),
        });

        await provider.run(created.id, 'plan revision one', {
          cwd: workspaceRoot,
          model: 'claude:haiku',
          runtimePolicy,
          tools: crewTools(1),
        });
        await provider.steer(created.id, 'synthesize revision two', {
          cwd: workspaceRoot,
          model: 'claude:haiku',
          runtimePolicy,
          tools: crewTools(2),
        });

        expect(records).toHaveLength(1);
        expect(definitionBatches).toHaveLength(2);
        const synthesis = definitionBatches[1]?.find(
          (definition) => definition.name === 'submit_synthesis',
        );
        expect(await synthesis?.handler({ contextRevision: 2 })).toMatchObject({
          content: [{ type: 'text', text: 'synthesis revision 2' }],
        });
        expect(calls).toEqual(['synthesis:2']);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('rebuilds and pushes setMcpServers when the follow-up toolset changed', async () => {
      const records: Array<Record<string, unknown>> = [];
      provider.createSdkMcpServer = ((opts: { name: string }) => ({
        type: 'sdk' as const,
        name: opts.name,
        instance: {},
      })) as never;
      provider.queryFactory = multiTurnQuery(records) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'first', { cwd: '/tmp/ws', model: 'claude:haiku', tools: toolset('verify') });
      await provider.steer(created.id, 'second', { cwd: '/tmp/ws', model: 'claude:haiku', tools: toolset('deploy') });
      expect(records).toHaveLength(1);
      expect(records[0]['nuncio-runtime']).toBeDefined();
    });

    it('pushes an empty server set when the follow-up removed all tools', async () => {
      const records: Array<Record<string, unknown>> = [];
      provider.createSdkMcpServer = ((opts: { name: string }) => ({
        type: 'sdk' as const,
        name: opts.name,
        instance: {},
      })) as never;
      provider.queryFactory = multiTurnQuery(records) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'first', { cwd: '/tmp/ws', model: 'claude:haiku', tools: toolset('verify') });
      await provider.steer(created.id, 'second', { cwd: '/tmp/ws', model: 'claude:haiku' });
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({});
    });

    it('skips gracefully when the live query has no setMcpServers support', async () => {
      const records: Array<Record<string, unknown>> = [];
      provider.createSdkMcpServer = ((opts: { name: string }) => ({
        type: 'sdk' as const,
        name: opts.name,
        instance: {},
      })) as never;
      provider.queryFactory = multiTurnQuery(records, false) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'first', { cwd: '/tmp/ws', model: 'claude:haiku', tools: toolset('verify') });
      await expect(
        provider.steer(created.id, 'second', { cwd: '/tmp/ws', model: 'claude:haiku', tools: toolset('deploy') }),
      ).resolves.toBeUndefined();
      expect(records).toHaveLength(0);
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
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

    it('submitInteraction is a graceful no-op for an unknown requestId (redelivery-safe)', async () => {
      // A response redelivered after the entry settled, or for an id that never
      // existed, must NOT throw — a duplicate HTTP respond would otherwise bubble
      // as a 500 through the sessions path.
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      await expect(
        provider.submitInteraction(created.id, 'nope', { answers: [], resolvedBy: 'skip' }),
      ).resolves.toBeUndefined();
    });

    it('submitInteraction is a no-op for a session with no live handle', async () => {
      // No active session for the id at all — still must not throw.
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await expect(
        provider.submitInteraction(created.id, 'whatever', { answers: [], resolvedBy: 'skip' }),
      ).resolves.toBeUndefined();
    });

    it('submitInteraction correlates a live approval even before its nuncio id is recorded', async () => {
      // Race: the respond arrives BEFORE the approval hook's promise resolved (so
      // pending.nuncioRequestId is still unset). The single unset pending approval
      // is correlated by fallback and settled with the answer.
      let resolved: { behavior: string } | undefined;
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          const decision = await options.canUseTool('Bash', { command: 'x' }, { requestId: 'sdk-race' });
          resolved = decision;
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      }) as never;
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'run curl', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        // Never resolves via the card, so nuncioRequestId is never recorded —
        // submitInteraction must still correlate the single live approval.
        requestProviderApproval: () => new Promise(() => {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      // requestId here does not match the SDK key ('sdk-race') nor any recorded
      // nuncio id (there is none yet) — the single-unset fallback correlates it.
      await provider.submitInteraction(created.id, 'nuncio-not-yet-linked', {
        answers: [{ questionId: 'q', selectedOptionIds: ['allow'] }],
        resolvedBy: 'user',
      });
      await run;
      expect(resolved?.behavior).toBe('allow');
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

  describe('tool_start / tool_end pairing', () => {
    function toolStart(uuid: string, id: string, name: string): ClaudeSdkMessage {
      return {
        type: 'stream_event',
        uuid,
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id, name, input: { command: 'ls' } },
        },
      } as ClaudeSdkMessage;
    }
    function toolResult(id: string, over: Record<string, unknown> = {}): ClaudeSdkMessage {
      return {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, ...over }] },
      } as ClaudeSdkMessage;
    }

    it('pairs a happy tool_start with a tool_end carrying the same callId and name', async () => {
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield toolStart('m1', 'toolu_1', 'Bash');
          yield toolResult('toolu_1', { content: 'output', is_error: false });
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'run ls', { cwd: '/tmp/ws', model: 'claude:haiku' });
      const list = events.list(created.id);
      const start = list.find((e) => e.type === 'tool_start');
      const end = list.find((e) => e.type === 'tool_end');
      expect((start?.payload as { callId: string }).callId).toBe('toolu_1');
      expect(end?.payload).toEqual({ callId: 'toolu_1', tool: 'Bash', isError: false, output: 'output' });
    });

    it('maps an error tool_result to tool_end isError:true', async () => {
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield toolStart('m1', 'toolu_e', 'Bash');
          yield toolResult('toolu_e', { content: 'denied', is_error: true });
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'x', { cwd: '/tmp/ws', model: 'claude:haiku' });
      const end = events.list(created.id).find((e) => e.type === 'tool_end');
      expect(end?.payload).toEqual({ callId: 'toolu_e', tool: 'Bash', isError: true, output: 'denied' });
    });

    it('tool_end echoes the MCP-normalized name from tool_start', async () => {
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield toolStart('m1', 'toolu_m', 'mcp__nuncio-runtime__verify');
          yield toolResult('toolu_m', { content: 'ok' });
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'x', { cwd: '/tmp/ws', model: 'claude:haiku' });
      const start = events.list(created.id).find((e) => e.type === 'tool_start');
      const end = events.list(created.id).find((e) => e.type === 'tool_end');
      expect((start?.payload as { tool: string }).tool).toBe('verify');
      expect((end?.payload as { tool: string }).tool).toBe('verify');
    });

    it('seals a tool_start with no result when the turn terminates (no dangling start)', async () => {
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield toolStart('m1', 'toolu_orphan', 'Bash');
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'x', { cwd: '/tmp/ws', model: 'claude:haiku' });
      const ends = events.list(created.id).filter((e) => e.type === 'tool_end');
      expect(ends).toHaveLength(1);
      expect(ends[0].payload).toEqual({ callId: 'toolu_orphan', tool: 'Bash', isError: false });
    });

    it('a tool_result with no prior tool_start falls back to a bare tool name', async () => {
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield toolResult('toolu_lost', { content: 'result' });
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'x', { cwd: '/tmp/ws', model: 'claude:haiku' });
      const end = events.list(created.id).find((e) => e.type === 'tool_end');
      expect((end?.payload as { tool: string }).tool).toBe('tool');
    });
  });

  describe('image attachments → user MessageParam content blocks', () => {
    let capturedContent: unknown;
    function capturingContentQuery(): ClaudeQuery {
      return {
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield { type: 'result', subtype: 'success', result: 'ok' };
        },
      } as ClaudeQuery;
    }

    beforeEach(() => {
      capturedContent = undefined;
      provider.queryFactory = ({ prompt }) => {
        void (async () => {
          const iterator = prompt[Symbol.asyncIterator]();
          const first = await iterator.next();
          capturedContent = (first.value as { message?: { content?: unknown } })?.message?.content;
        })();
        return capturingContentQuery();
      };
    });

    it('keeps content a plain string when there are no attachments', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'describe this', { cwd: '/tmp/ws', model: 'claude:haiku' });
      await new Promise((r) => setTimeout(r, 10));
      expect(typeof capturedContent).toBe('string');
    });

    it('builds a text block + one image block per image attachment', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'what colors?', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        attachments: [
          { kind: 'image', mimeType: 'image/png', data: 'AAAA' },
          { kind: 'image', mimeType: 'image/jpeg', data: 'BBBB' },
        ],
      });
      await new Promise((r) => setTimeout(r, 10));
      const content = capturedContent as Array<Record<string, unknown>>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toEqual({ type: 'text', text: 'what colors?' });
      expect(content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      });
      expect(content[2]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
      });
    });

    it('ignores non-image attachment kinds and keeps content a plain string', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', {
        cwd: '/tmp/ws',
        model: 'claude:haiku',
        attachments: [{ kind: 'file', mimeType: 'text/plain', data: 'ZZ' } as never],
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(typeof capturedContent).toBe('string');
    });
  });

  describe('in-session effort change', () => {
    it('pushes a changed effort level via applyFlagSettings on setModel', async () => {
      const applied: Array<{ effortLevel?: string }> = [];
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async applyFlagSettings(settings: { effortLevel?: string }) {
          applied.push(settings);
        },
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield { type: 'result', subtype: 'success', result: 'ok' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:sonnet' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:sonnet' });
      await provider.setModel(created.id, 'claude:sonnet', { effort: 'high' });
      expect(applied).toEqual([{ effortLevel: 'high' }]);
    });

    it("clamps 'max' to 'xhigh' for the mid-session settings channel", async () => {
      const applied: Array<{ effortLevel?: string }> = [];
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async applyFlagSettings(settings: { effortLevel?: string }) {
          applied.push(settings);
        },
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield { type: 'result', subtype: 'success', result: 'ok' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:opus[1m]' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:opus[1m]' });
      await provider.setModel(created.id, 'claude:opus[1m]', { effort: 'max' });
      expect(applied).toEqual([{ effortLevel: 'xhigh' }]);
    });

    it('does not throw on setModel when the query has no applyFlagSettings', async () => {
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'hi', { cwd: '/tmp/ws', model: 'claude:haiku' });
      await expect(
        provider.setModel(created.id, 'claude:sonnet', { effort: 'high' }),
      ).resolves.toBeUndefined();
    });
  });

  it('declares images capability true', () => {
    expect(provider.capabilities.images).toBe(true);
  });

  it('steers a live query into a second turn (generator survives turn-end, no re-finalize)', async () => {
    // The SDK Query is a single-pass AsyncGenerator: a turn ends on its `result`,
    // but the generator must keep yielding for the next steer. Driving it with a
    // stable iterator (not a fresh `for await` per turn) is what keeps it alive —
    // a `for await` loop finalizes the generator on break, so the second turn
    // would silently produce nothing. This fake is ONE real AsyncGenerator whose
    // `[Symbol.asyncIterator]` returns `this` — a generator finalized on turn 1
    // would return done when re-iterated for turn 2, which is exactly the
    // regression this guards.
    provider.queryFactory = ({ prompt }) => {
      const promptIterator = prompt[Symbol.asyncIterator]();
      async function* turns(): AsyncGenerator<ClaudeSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 't1' };
        await promptIterator.next(); // consume the initial prompt
        yield {
          type: 'stream_event',
          uuid: 'm1',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FIRST' } },
        };
        yield { type: 'result', subtype: 'success', result: 'FIRST' };
        // Turn 1 ended; the generator stays suspended here until the steer arrives.
        await promptIterator.next(); // the steer message
        yield {
          type: 'stream_event',
          uuid: 'm2',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SECOND' } },
        };
        yield { type: 'result', subtype: 'success', result: 'SECOND' };
      }
      const gen = turns();
      return {
        async interrupt() {},
        async setModel() {},
        [Symbol.asyncIterator]() {
          return gen;
        },
      } as ClaudeQuery;
    };
    const created = sessions.create({ prompt: 'go', provider: 'claude', model: 'claude:haiku' });
    await provider.run(created.id, 'go', { cwd: '/tmp/ws', model: 'claude:haiku' });
    expect(finalMessageText(created.id)).toBe('FIRST');

    await provider.steer(created.id, 'now the second', { cwd: '/tmp/ws', model: 'claude:haiku' });
    // The second turn actually produced output — the generator was not finalized
    // when the first turn ended.
    expect(finalMessageText(created.id)).toBe('SECOND');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  function finalMessageText(sessionId: string): string {
    const message = events.list(sessionId).findLast((event) => event.type === 'assistant_message');
    return (message?.payload as { text?: string })?.text ?? '';
  }

  describe('subprocess audit — dispose aborts every session handle', () => {
    /**
     * Install one factory that parks EVERY run on a never-resolving turn and
     * routes the per-run AbortController by cwd (unique per session here) into a
     * shared registry. A single factory avoids the reassign-race where a later
     * factory assignment shadows an earlier run's factory after its first await.
     */
    function installParkingFactory(onAbort: (key: string) => void): void {
      provider.queryFactory = ({ options }: { options: ClaudeQueryOptions }) => {
        const key = options.cwd;
        options.abortController.signal.addEventListener('abort', () => onAbort(key), { once: true });
        return {
          async interrupt() {},
          async setModel() {},
          async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
            yield { type: 'system', subtype: 'init', session_id: key };
            await new Promise<void>((resolve) => {
              options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        } as ClaudeQuery;
      };
    }

    it('disposing N concurrent sessions fires every abort controller', async () => {
      const N = 4;
      const aborted = new Set<string>();
      installParkingFactory((key) => aborted.add(key));
      const created = Array.from({ length: N }, (_, i) =>
        sessions.create({ prompt: `p${i}`, provider: 'claude', model: 'claude:haiku' }),
      );
      const runs = created.map((session, i) =>
        provider.run(session.id, 'go', { cwd: `/tmp/ws-${i}`, model: 'claude:haiku' }),
      );

      // Let every run reach its parked turn (handle registered).
      await new Promise((r) => setTimeout(r, 30));
      for (const session of created) provider.dispose(session.id);
      await Promise.all(runs.map((run) => run.catch(() => {})));

      expect(aborted.size).toBe(N);
      for (let i = 0; i < N; i += 1) expect(aborted.has(`/tmp/ws-${i}`)).toBe(true);
    });

    it('double-dispose is idempotent (second call is a safe no-op)', async () => {
      let abortCount = 0;
      installParkingFactory(() => (abortCount += 1));
      const created = sessions.create({ prompt: 'p', provider: 'claude', model: 'claude:haiku' });
      const run = provider.run(created.id, 'go', { cwd: '/tmp/ws-solo', model: 'claude:haiku' });
      await new Promise((r) => setTimeout(r, 20));

      provider.dispose(created.id);
      expect(() => provider.dispose(created.id)).not.toThrow();
      await run.catch(() => {});
      // The single live AbortController fired exactly once; the second dispose,
      // finding no handle, did not re-abort or throw.
      expect(abortCount).toBe(1);
    });

    it('onModuleDestroy disposes every remaining active session', async () => {
      const aborted = new Set<string>();
      installParkingFactory((key) => aborted.add(key));
      const created = Array.from({ length: 3 }, (_, i) =>
        sessions.create({ prompt: `p${i}`, provider: 'claude', model: 'claude:haiku' }),
      );
      const runs = created.map((session, i) =>
        provider.run(session.id, 'go', { cwd: `/tmp/md-${i}`, model: 'claude:haiku' }),
      );
      await new Promise((r) => setTimeout(r, 30));

      provider.onModuleDestroy();
      await Promise.all(runs.map((run) => run.catch(() => {})));
      expect(aborted.size).toBe(3);
    });
  });

  describe('payload truncation — oversized tool output survives the event cap', () => {
    it('a tool_end output past the event-layer cap lands truncated, not thrown', async () => {
      // The Claude provider passes raw tool output through; the ceiling is
      // enforced when the event is persisted (MAX_EVENT_PAYLOAD_BYTES). A huge
      // output must flow through pushEvent without throwing and land truncated.
      const huge = 'x'.repeat(200 * 1024);
      provider.queryFactory = () => ({
        async interrupt() {},
        async setModel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          yield { type: 'system', subtype: 'init', session_id: 't1' };
          yield {
            type: 'stream_event',
            uuid: 'm1',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: 'toolu_big', name: 'Bash', input: {} },
            },
          } as ClaudeSdkMessage;
          yield {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: huge }] },
          } as ClaudeSdkMessage;
          yield { type: 'result', subtype: 'success', result: 'done' };
        },
      });
      const created = sessions.create({ prompt: 'hi', provider: 'claude', model: 'claude:haiku' });
      await provider.run(created.id, 'run a big command', { cwd: '/tmp/ws', model: 'claude:haiku' });

      // The run completed (no throw) and reached its terminal.
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
      // The event layer replaces a payload past MAX_EVENT_PAYLOAD_BYTES with a
      // { truncated, preview } stub, so the oversized tool_end lands truncated
      // rather than bloating the log or throwing.
      const end = events.list(created.id).find((e) => e.type === 'tool_end');
      const payload = end?.payload as { truncated?: boolean; preview?: string };
      expect(payload.truncated).toBe(true);
      expect(typeof payload.preview).toBe('string');
      expect(new TextEncoder().encode(payload.preview!).byteLength).toBeLessThanOrEqual(128 * 1024);
    });
  });
});
