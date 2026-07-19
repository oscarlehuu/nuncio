import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import type { AgentCapabilities } from '../../../src/agents/agents.types';
import { ContextModule } from '../../../src/context/context.module';
import { ContextFactsService } from '../../../src/context/context-facts.service';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { SimulatedCursorAgentProvider } from '../../helpers/simulated-cursor-agent.provider';
import { configureSimulatedCursorEnv } from '../../helpers/simulated-cursor-app';

/**
 * Test double for an engine that injects the managed Nuncio project context
 * into its own system prompt (like the Pi engine): the session layer must not
 * duplicate the facts block into the user preamble for its non-policy sessions.
 */
@Injectable()
class SimulatedSystemContextProvider extends SimulatedCursorAgentProvider {
  override readonly capabilities: AgentCapabilities = {
    interrupt: false,
    modelSwitch: 'none',
    effortSwitch: 'none',
    images: false,
    steerWhileRunning: false,
    systemContextInjection: true,
    runtimePolicies: [{ filesystem: 'workspace-write', network: 'disabled' }],
  };
}

describe('project facts dedupe for system-context engines', () => {
  let module: TestingModule;
  let sessions: SessionsService;
  let facts: ContextFactsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-fact-dedupe-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule, ContextModule, SettingsModule],
      providers: [SessionsService],
    })
      .overrideProvider(CursorAgentProvider)
      .useClass(SimulatedSystemContextProvider)
      .compile();
    sessions = module.get(SessionsService);
    facts = module.get(ContextFactsService);
    events = module.get(EventsRepository);
  });

  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-fact-dedupe-ws-'));
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

  it('skips the preamble facts block on a solo session (system prompt owns the facts)', async () => {
    facts.upsert({ projectPath: workspace, key: 'build-command', value: 'use make weird-build', provenance: 'founder' });
    const session = await sessions.create({ prompt: 'do the task', provider: 'cursor', workspace, projectPath: workspace });
    const text = await firstUserMessage(session.id);
    expect(text).not.toContain('## Project facts');
    expect(text).not.toContain('use make weird-build');
    expect(text.trimEnd().endsWith('do the task')).toBe(true);
  });

  it('keeps the preamble facts block on a runtime-policy session (hermetic loader has no managed context)', async () => {
    facts.upsert({ projectPath: workspace, key: 'gotcha', value: 'policy sessions still need facts', provenance: 'founder' });
    const session = await sessions.create({
      prompt: 'policy task',
      provider: 'cursor',
      workspace,
      projectPath: workspace,
      runtimePolicy: { filesystem: 'workspace-write', network: 'disabled', workspaceRoot: workspace },
    });
    const text = await firstUserMessage(session.id);
    expect(text).toContain('## Project facts (managed by nuncio)');
    expect(text).toContain('policy sessions still need facts');
  });
});
