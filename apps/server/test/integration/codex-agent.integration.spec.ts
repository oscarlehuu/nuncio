import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsModule } from '../../src/agents/agents.module';
import { CodexAgentProvider } from '../../src/agents/providers/codex-agent.provider';
import { DatabaseModule } from '../../src/db/database.module';
import { SettingsModule } from '../../src/settings/settings.module';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';

const codexBin = process.env.NUNCIO_CODEX_BIN?.trim() || 'codex';
const optIn = process.env.NUNCIO_CODEX_INTEGRATION === '1';

function commandOk(args: string[]): boolean {
  const result = spawnSync(codexBin, args, { encoding: 'utf8', env: process.env });
  return result.status === 0;
}

const hasCodexLogin = optIn && commandOk(['--version']) && commandOk(['login', 'status']);
const suite = hasCodexLogin ? describe : describe.skip;

suite('CodexAgentProvider with real Codex app-server (integration)', () => {
  let module: TestingModule;
  let provider: CodexAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let workspaceDir: string;
  let testModel: string;
  const activeSessionIds = new Set<string>();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-codex-integration-'));
    workspaceDir = join(dataDir, 'workspace');
    mkdirSync(workspaceDir);
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule, AgentsModule],
    }).compile();

    provider = module.get(CodexAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    testModel = await resolveCodexTestModel(provider);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const sessionId of activeSessionIds) {
        provider?.dispose(sessionId);
      }
      await module?.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.NUNCIO_DATA_DIR;
    }
  }, 60_000);

  it('discovers real Codex models through app-server', async () => {
    expect(await provider.isAvailable()).toBe(true);
    const providers = await provider.listModels();
    const modelIds = flatModelIds(providers);
    expect(modelIds.length).toBeGreaterThan(0);
    expect(modelIds).toContain(testModel);
  }, 60_000);

  it('runs a real Codex turn, streams deltas, and resumes the stored thread', async () => {
    const created = sessions.create({
      prompt: 'Reply with exactly: NUNCIO_CODEX_OK',
      provider: 'codex',
      model: testModel,
      modelOptions: { reasoningEffort: 'low' },
    });
    activeSessionIds.add(created.id);
    const emitted: Array<{ type: string; payload: unknown; seq?: number }> = [];

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: workspaceDir,
      model: created.model,
      modelOptions: created.modelOptions,
    });

    const afterRun = sessions.findById(created.id);
    const threadId = afterRun?.providerThreadId;
    expect(threadId).toBeTruthy();
    expect(afterRun?.status).toBe('IDLE');
    expect(events.list(created.id).some((event) => event.type === 'assistant_delta')).toBe(true);
    expect(emitted.some((event) => event.type === 'assistant_delta' && typeof event.seq === 'number')).toBe(true);
    expect(finalAssistantText(created.id).toUpperCase()).toContain('NUNCIO_CODEX_OK');

    await provider.steer(created.id, 'Now reply with exactly: NUNCIO_CODEX_STEER_OK', {
      emit: (event) => emitted.push(event),
      cwd: workspaceDir,
      model: created.model,
      modelOptions: { reasoningEffort: 'low' },
    });

    expect(sessions.findById(created.id)?.providerThreadId).toBe(threadId);
    expect(events.list(created.id).some((event) => event.type === 'steer_message')).toBe(true);
    expect(finalAssistantText(created.id).toUpperCase()).toContain('NUNCIO_CODEX_STEER_OK');
  }, 180_000);

  function finalAssistantText(sessionId: string): string {
    const message = events.list(sessionId).filter((event) => event.type === 'assistant_message').at(-1);
    const payload = message?.payload as { text?: unknown } | undefined;
    return typeof payload?.text === 'string' ? payload.text : '';
  }
});

async function resolveCodexTestModel(provider: CodexAgentProvider): Promise<string> {
  const requested = process.env.NUNCIO_CODEX_TEST_MODEL?.trim();
  const models = flatModelIds(await provider.listModels());
  if (requested) {
    expect(models).toContain(requested);
    return requested;
  }
  return models.find((id) => id === 'codex:gpt-5.3-codex-spark') ?? models[0]!;
}

function flatModelIds(providers: Awaited<ReturnType<CodexAgentProvider['listModels']>>): string[] {
  return providers.flatMap((provider) =>
    (provider.groups ?? []).flatMap((group) => (group.models ?? []).map((model) => model.id)),
  );
}
