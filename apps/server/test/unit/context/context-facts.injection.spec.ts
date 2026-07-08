import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { ContextModule } from '../../../src/context/context.module';
import { ContextFactsService } from '../../../src/context/context-facts.service';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('project fact injection into new sessions', () => {
  let module: TestingModule;
  let sessions: SessionsService;
  let facts: ContextFactsService;
  let events: EventsRepository;
  let settings: SettingsService;
  let dataDir: string;
  let workspace: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-fact-inject-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule, ContextModule, SettingsModule],
        providers: [SessionsService],
      }),
    ).compile();
    sessions = module.get(SessionsService);
    facts = module.get(ContextFactsService);
    events = module.get(EventsRepository);
    settings = module.get(SettingsService);
  });

  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-fact-ws-'));
    // projectPath triggers git.listBranches → needs a real repo.
    await git(workspace, 'init', '-q', '-b', 'main');
    await git(workspace, 'config', 'user.email', 'test@example.com');
    await git(workspace, 'config', 'user.name', 'Test');
    await git(workspace, 'commit', '-q', '--allow-empty', '-m', 'init');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  async function firstUserMessage(sessionId: string): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const msg = events.list(sessionId).find((e) => e.type === 'user_message');
      if (msg) return (msg.payload as { text: string }).text;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no user_message');
  }

  it('injects the project facts header into a new session on a project with facts', async () => {
    facts.upsert({ projectPath: workspace, key: 'build-command', value: 'use make weird-build', provenance: 'founder' });
    const session = await sessions.create({ prompt: 'do the task', provider: 'cursor', workspace, projectPath: workspace });
    const text = await firstUserMessage(session.id);
    expect(text).toContain('## Project facts (managed by nuncio)');
    expect(text).toContain('**build-command**: use make weird-build');
    expect(text.trimEnd().endsWith('do the task')).toBe(true); // prompt stays last
  });

  it('injects no header for a fact-less project', async () => {
    const session = await sessions.create({ prompt: 'plain task', provider: 'cursor', workspace, projectPath: workspace });
    const text = await firstUserMessage(session.id);
    expect(text).not.toContain('## Project facts');
    expect(text).toContain('plain task');
  });

  it('the kill-switch (inject=off) disables injection', async () => {
    settings.set('NUNCIO_CONTEXT_FACTS_INJECT', 'off');
    try {
      facts.upsert({ projectPath: workspace, key: 'gotcha', value: 'x', provenance: 'founder' });
      const session = await sessions.create({ prompt: 'task', provider: 'cursor', workspace, projectPath: workspace });
      const text = await firstUserMessage(session.id);
      expect(text).not.toContain('## Project facts');
    } finally {
      settings.set('NUNCIO_CONTEXT_FACTS_INJECT', 'on');
    }
  });
});
