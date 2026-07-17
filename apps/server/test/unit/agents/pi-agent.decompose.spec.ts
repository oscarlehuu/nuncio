import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configurePiSdkMock } from './pi-sdk.mock';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

/**
 * Pi provider `decompose`: one bounded, tool-less, in-memory model call that
 * splits a multitask goal into independent subtasks. These specs pin the
 * parse/retry/fallback paths and the isolation of the completion, driving the
 * shared Pi SDK module mock so nothing hits a real model.
 */

// Per createAgentSession call (one per attempt): the assistant text getLastAssistantText
// returns, and an optional error prompt() should throw. Indexed by attempt.
let attemptTexts: string[] = [];
let attemptPromptErrors: Array<Error | null> = [];

let promptCalls: Array<{ text: string; options: unknown }> = [];
let createSessionOptions: Array<Record<string, unknown>> = [];
let lastLoaderOptions: Record<string, unknown> | null = null;
let inMemoryCalls: Array<{ cwd?: string }> = [];
let disposeCalls = 0;

function registryModel(provider = 'anthropic', id = 'model-1') {
  return { provider, id, name: `Model ${id}`, reasoning: true, thinkingLevelMap: {} };
}

configurePiSdkMock({
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({ kind: 'settings-manager' }) },
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      lastLoaderOptions = options;
    }
    async reload() {
      /* no-op */
    }
  },
  defineTool: (tool: unknown) => tool,
  ModelRegistry: {
    create: () => ({
      getError: () => undefined,
      getAvailable: () => [],
      getProviderDisplayName: (provider: string) => provider,
      // Resolve any provider:id the caller asks for so we can assert the model
      // that reaches createAgentSession is the inherited one.
      find: (provider: string, id: string) => registryModel(provider, id),
    }),
  },
  SessionManager: {
    inMemory: (cwd?: string) => {
      inMemoryCalls.push({ cwd });
      return { kind: 'in-memory', cwd };
    },
  },
  createAgentSession: (options: Record<string, unknown>) => {
    const attempt = createSessionOptions.length;
    createSessionOptions.push(options);
    return {
      session: {
        prompt: async (text: string, opts?: unknown) => {
          promptCalls.push({ text, options: opts });
          const err = attemptPromptErrors[attempt];
          if (err) throw err;
        },
        getLastAssistantText: () => attemptTexts[attempt] ?? '',
        dispose: () => {
          disposeCalls += 1;
        },
      },
    };
  },
  getAgentDir: () => '/tmp/fake-pi',
});

function validSplit(count: number): string {
  const subtasks = Array.from({ length: count }, (_, i) => ({
    scope: `Scope ${i + 1}`,
    prompt: `Self-contained instructions for subtask ${i + 1}.`,
    files: [`src/area-${i + 1}.ts`],
  }));
  return JSON.stringify({ subtasks, nonOverlap: 'Disjoint files, no ordering.' });
}

describe('PiAgentProvider.decompose', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-decompose-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();
    provider = module.get(PiAgentProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    attemptTexts = [];
    attemptPromptErrors = [];
    promptCalls = [];
    createSessionOptions = [];
    lastLoaderOptions = null;
    inMemoryCalls = [];
    disposeCalls = 0;
    provider.bustCache();
  });

  it('splits a goal from a clean JSON reply on the first attempt', async () => {
    attemptTexts = [validSplit(3)];

    const result = await provider.decompose({ goal: 'Build the widget', maxSubtasks: 5 });

    expect(result.subtasks).toHaveLength(3);
    expect(result.subtasks[0]).toEqual({
      scope: 'Scope 1',
      prompt: 'Self-contained instructions for subtask 1.',
      files: ['src/area-1.ts'],
    });
    expect(result.nonOverlap).toBe('Disjoint files, no ordering.');
    expect(promptCalls).toHaveLength(1);
    expect(disposeCalls).toBe(1);
  });

  it('parses JSON wrapped in a ```json fence', async () => {
    attemptTexts = ['```json\n' + validSplit(2) + '\n```'];

    const result = await provider.decompose({ goal: 'Fenced goal', maxSubtasks: 5 });

    expect(result.subtasks).toHaveLength(2);
    expect(promptCalls).toHaveLength(1);
  });

  it('parses JSON embedded in surrounding prose', async () => {
    attemptTexts = [`Here is the split you asked for:\n${validSplit(2)}\nLet me know if that works.`];

    const result = await provider.decompose({ goal: 'Prose goal', maxSubtasks: 5 });

    expect(result.subtasks).toHaveLength(2);
    expect(promptCalls).toHaveLength(1);
  });

  it('clamps an over-cap split down to the requested maximum', async () => {
    attemptTexts = [validSplit(5)];

    const result = await provider.decompose({ goal: 'Too many', maxSubtasks: 3 });

    expect(result.subtasks).toHaveLength(3);
    // The prompt asks for the clamped range, not the raw cap.
    expect(promptCalls[0]?.text).toContain('between 2 and 3');
  });

  it('retries once on unparseable output and recovers, with a stricter reminder', async () => {
    attemptTexts = ['I cannot produce that.', validSplit(2)];

    const result = await provider.decompose({ goal: 'Recoverable', maxSubtasks: 5 });

    expect(result.subtasks).toHaveLength(2);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[0]?.text).not.toContain('previous reply was not');
    expect(promptCalls[1]?.text).toContain('previous reply was not');
    expect(disposeCalls).toBe(2);
  });

  it('retries when the model call itself throws, then succeeds', async () => {
    attemptPromptErrors = [new Error('no auth configured'), null];
    attemptTexts = ['', validSplit(2)];

    const result = await provider.decompose({ goal: 'Flaky first call', maxSubtasks: 5 });

    expect(result.subtasks).toHaveLength(2);
    expect(promptCalls).toHaveLength(2);
    // Even the failed attempt's session must be disposed.
    expect(disposeCalls).toBe(2);
  });

  it('throws a clean error when both attempts are unparseable (no crash)', async () => {
    attemptTexts = ['garbage one', 'garbage two'];

    await expect(provider.decompose({ goal: 'Hopeless', maxSubtasks: 5 })).rejects.toThrow(
      /could not decompose the goal/i,
    );
    expect(promptCalls).toHaveLength(2);
    expect(disposeCalls).toBe(2);
  });

  it('throws when the split has fewer than the minimum independent subtasks', async () => {
    attemptTexts = [validSplit(1), validSplit(1)];

    await expect(provider.decompose({ goal: 'Only one', maxSubtasks: 5 })).rejects.toThrow(
      /could not decompose the goal/i,
    );
    expect(promptCalls).toHaveLength(2);
  });

  it('throws when the model call fails on every attempt', async () => {
    attemptPromptErrors = [new Error('provider down'), new Error('provider down')];

    await expect(provider.decompose({ goal: 'Down', maxSubtasks: 5 })).rejects.toThrow(
      /could not decompose the goal/i,
    );
    expect(promptCalls).toHaveLength(2);
    expect(disposeCalls).toBe(2);
  });

  it('runs the completion on the inherited model, tool-less and in-memory', async () => {
    attemptTexts = [validSplit(2)];

    await provider.decompose({
      goal: 'Model check',
      maxSubtasks: 5,
      model: 'anthropic:claude-opus-4-8',
      cwd: '/tmp/worktree',
    });

    const options = createSessionOptions[0]!;
    expect(options.model).toMatchObject({ provider: 'anthropic', id: 'claude-opus-4-8' });
    expect(options.noTools).toBe('all');
    expect(options.customTools).toBeUndefined();
    expect((options.sessionManager as { kind: string }).kind).toBe('in-memory');
    expect(options.cwd).toBe('/tmp/worktree');
    expect(inMemoryCalls[0]?.cwd).toBe('/tmp/worktree');
    expect(lastLoaderOptions?.noExtensions).toBe(true);
    expect(lastLoaderOptions?.noContextFiles).toBe(true);
    expect((lastLoaderOptions?.appendSystemPrompt as string[])[0]).toContain(
      'task-decomposition planner',
    );
  });

  it('omits the model when none is inherited so the SDK default applies', async () => {
    attemptTexts = [validSplit(2)];

    await provider.decompose({ goal: 'No model', maxSubtasks: 5, model: null });

    expect(createSessionOptions[0]!.model).toBeUndefined();
  });
});
