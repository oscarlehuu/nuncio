import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

let availableModelCount = 0;
let fakeSessionFile = '/tmp/fake-pi/session.jsonl';
let promptCalls: Array<{ text: string; options: unknown }> = [];
let promptBehavior: ((text: string, options?: unknown) => Promise<void>) | null = null;
let isStreaming = false;
const abortMock = mock(async () => undefined);
const setModelMock = mock(async (_model: unknown) => undefined);
const setThinkingLevelMock = mock((_level: unknown) => undefined);

function registryModel(provider = 'anthropic', id = 'model-1') {
  return {
    provider,
    id,
    name: `Model ${id}`,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
  };
}

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getAvailable: () => Array.from({ length: availableModelCount }, (_, i) => ({
        provider: 'anthropic',
        id: `model-${i}`,
        name: `Model ${i}`,
      })),
      getProviderDisplayName: (provider: string) => provider,
      find: (provider: string, id: string) => (provider === 'anthropic' ? registryModel(provider, id) : undefined),
    }),
  },
  SessionManager: {
    open: (path: string, sessionDir: undefined, cwd?: string) => ({ kind: 'open', path, sessionDir, cwd }),
  },
  createAgentSession: () => ({
    session: {
      sessionFile: fakeSessionFile,
      get model() {
        return registryModel();
      },
      get thinkingLevel() {
        return 'medium';
      },
      get isStreaming() {
        return isStreaming;
      },
      subscribe: () => () => {},
      prompt: async (text: string, options?: unknown) => {
        promptCalls.push({ text, options });
        await promptBehavior?.(text, options);
      },
      abort: abortMock,
      setModel: setModelMock,
      setThinkingLevel: setThinkingLevelMock,
    },
  }),
  getAgentDir: () => '/tmp/fake-pi',
}));

describe('PiAgentProvider', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    availableModelCount = 0;
    fakeSessionFile = '/tmp/fake-pi/session.jsonl';
    promptCalls = [];
    promptBehavior = null;
    isStreaming = false;
    abortMock.mockClear();
    setModelMock.mockClear();
    setThinkingLevelMock.mockClear();
    provider.bustCache();
  });

  it('declares Pi live-switch and image capabilities', () => {
    expect(provider.capabilities).toEqual({
      interrupt: true,
      modelSwitch: 'in-session',
      effortSwitch: 'in-session',
      images: true,
    });
  });

  it('is unavailable when the Pi registry has no models', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is available when the Pi registry reports models', async () => {
    availableModelCount = 1;
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('dispose is a no-op for an unknown session', () => {
    expect(() => provider.dispose('no-such-session')).not.toThrow();
  });

  it('interrupt calls abort on an active session and no-ops without one', async () => {
    await provider.interrupt('no-such-session');
    expect(abortMock).not.toHaveBeenCalled();

    const created = sessions.create({ prompt: 'interrupt me', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.interrupt(created.id);
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an idle interrupt swallow the next prompt failure', async () => {
    const created = sessions.create({ prompt: 'prime session', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.interrupt(created.id);
    promptBehavior = async () => {
      throw new Error('real prompt failure');
    };

    await provider.run(created.id, 'next prompt fails', { emit: () => {} });

    expect(sessions.findById(created.id)?.status).toBe('ERROR');
  });

  it('treats an interrupt during streaming as a clean cancel', async () => {
    let rejectPrompt: (error: Error) => void = () => undefined;
    const promptStarted = new Promise<void>((resolve) => {
      promptBehavior = async () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
          resolve();
        });
    });
    isStreaming = true;
    const created = sessions.create({ prompt: 'streaming prompt', provider: 'pi' });

    const runPromise = provider.run(created.id, created.prompt, { emit: () => {} });
    await promptStarted;
    await provider.interrupt(created.id);
    rejectPrompt(new Error('aborted by user'));
    await runPromise;

    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('setModel resolves the model and applies thinking level on an active session', async () => {
    const created = sessions.create({ prompt: 'switch model', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.setModel(created.id, 'anthropic:model-1', { thinkingLevel: 'high' });

    expect(setModelMock).toHaveBeenCalledTimes(1);
    expect(setModelMock.mock.calls[0]?.[0]).toMatchObject({ provider: 'anthropic', id: 'model-1' });
    expect(setThinkingLevelMock).toHaveBeenCalledWith('high');
  });

  it('setModel no-ops without an active session', async () => {
    await provider.setModel('no-such-session', 'anthropic:model-1', { thinkingLevel: 'high' });
    expect(setModelMock).not.toHaveBeenCalled();
    expect(setThinkingLevelMock).not.toHaveBeenCalled();
  });

  it('passes image attachments to Pi prompt options', async () => {
    const created = sessions.create({ prompt: 'describe image', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      attachments: [
        { kind: 'image', mimeType: 'image/png', data: 'base64-data' },
      ],
    });

    expect(promptCalls[0]).toEqual({
      text: created.prompt,
      options: { images: [{ type: 'image', mimeType: 'image/png', data: 'base64-data' }] },
    });
  });

  it('omits image options when there are no attachments', async () => {
    const created = sessions.create({ prompt: 'no image', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(promptCalls[0]).toEqual({ text: created.prompt, options: undefined });
  });

  it('persists the Pi session file after creating an agent session', async () => {
    fakeSessionFile = '/tmp/fake-pi/persisted-session.jsonl';
    const created = sessions.create({ prompt: 'persist session file', provider: 'pi' });
    const originalUpdate = sessions.updateProviderRuntimeState.bind(sessions);
    const updateSpy = mock((...args: Parameters<SessionsRepository['updateProviderRuntimeState']>) =>
      originalUpdate(...args),
    );
    sessions.updateProviderRuntimeState = updateSpy as SessionsRepository['updateProviderRuntimeState'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });

      expect(updateSpy).toHaveBeenCalledWith(created.id, { providerThreadId: fakeSessionFile });
      expect(sessions.findById(created.id)?.providerThreadId).toBe(fakeSessionFile);
    } finally {
      sessions.updateProviderRuntimeState = originalUpdate;
    }
  });
});
