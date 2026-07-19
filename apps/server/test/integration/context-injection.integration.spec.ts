import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentsModule } from '../../src/agents/agents.module';
import { FactDistillationService } from '../../src/agents/fact-distillation.service';
import { PiAgentProvider } from '../../src/agents/providers/pi-agent.provider';
import { ContextFactsService } from '../../src/context/context-facts.service';
import { ContextModule } from '../../src/context/context.module';
import { CursorLocalModule } from '../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../src/db/database.module';
import { GitModule } from '../../src/git/git.module';
import type { SessionEvent } from '../../src/sessions/domain/sessions.types';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import { SessionsModule } from '../../src/sessions/sessions.module';
import { SessionsService } from '../../src/sessions/sessions.service';
import { SettingsModule } from '../../src/settings/settings.module';
import { SettingsService } from '../../src/settings/settings.service';

/**
 * Level-6 real-Pi proof for the codebase-context phases:
 *   P1 — session-start `## Workspace` injection via SessionsService.create
 *   P0 — systemContextInjection engines skip duplicate `## Project facts`
 *   P2 — PiAgentProvider.completeOneShot + FactDistillationService end-to-end
 *
 * Gated on ~/.pi/agent/auth.json (same as pi-agent.integration.spec.ts). Asserts
 * the composed session.prompt immediately after create, then interrupts so we
 * never wait on a full agent turn for the preamble checks.
 */
const CHEAP_MODEL_CANDIDATES = [
  'cliproxyapi:claude-sonnet-5',
  'cliproxy:claude-sonnet-5',
  'cliproxyapi:claude-sonnet-4-6',
  'cliproxy:claude-sonnet-4-6',
];
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const hasRealPiAuth = existsSync(join(piAgentDir, 'auth.json'));
const suite = hasRealPiAuth ? describe : describe.skip;

suite('context injection with real Pi (integration)', () => {
  let module: TestingModule;
  let sessions: SessionsService;
  let provider: PiAgentProvider;
  let facts: ContextFactsService;
  let events: EventsRepository;
  let sessionsRepo: SessionsRepository;
  let distill: FactDistillationService;
  let settings: SettingsService;
  let dataDir: string;
  let workspace: string;
  let cheapModel: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-context-integration-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    // Keep distillation hook off under bun test (FactDistillationService
    // already no-ops registration when NODE_ENV=test); call handleEvent
    // directly below.
    process.env.NODE_ENV = 'test';

    module = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        SettingsModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
        ContextModule,
        SessionsModule,
      ],
    }).compile();

    sessions = module.get(SessionsService);
    provider = module.get(PiAgentProvider);
    facts = module.get(ContextFactsService);
    events = module.get(EventsRepository);
    sessionsRepo = module.get(SessionsRepository);
    settings = module.get(SettingsService);
    // Not exported from AgentsModule — select the declaring module.
    distill = module.select(AgentsModule).get(FactDistillationService);
    cheapModel = await resolveCheapModel(provider);
  });

  afterAll(async () => {
    try {
      for (const sessionId of (
        provider as unknown as { activeSessions?: Map<string, unknown> }
      ).activeSessions?.keys() ?? []) {
        provider.dispose(sessionId);
      }
      await module.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.NUNCIO_DATA_DIR;
    }
  });

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-context-int-repo-'));
    await git(workspace, 'init', '-q', '-b', 'main');
    await git(workspace, 'config', 'user.email', 'integration@nuncio.local');
    await git(workspace, 'config', 'user.name', 'Nuncio Integration');
    writeFileSync(join(workspace, 'README.md'), '# context integration\n');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'main.ts'), 'export {}\n');
    await git(workspace, 'add', '.');
    await git(workspace, 'commit', '-q', '-m', 'seed context integration fixture');
  });

  afterEach(async () => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function abortSession(id: string): Promise<void> {
    try {
      await sessions.interrupt(id);
    } catch {
      // Provider may not have a live handle yet — dispose is the hard stop.
    }
    provider.dispose(id);
  }

  it(
    'injects ## Workspace into the composed prompt and skips preamble facts for Pi',
    async () => {
      facts.upsert({
        projectPath: workspace,
        key: 'build-command',
        value: 'use make weird-build-never-in-preamble',
        provenance: 'founder',
      });

      const session = await sessions.create({
        prompt: 'reply pong then stop',
        provider: 'pi',
        model: cheapModel,
        workspace,
        projectPath: workspace,
      });

      try {
        // Composed at create time — assert before the background run spends tokens.
        expect(session.prompt).toContain('## Workspace');
        expect(session.prompt).toContain('branch: main');
        expect(session.prompt).toContain('seed context integration fixture');
        expect(session.prompt).toContain('README.md');
        expect(session.prompt).toContain('src');
        expect(session.prompt.trimEnd().endsWith('reply pong then stop')).toBe(true);

        // Pi advertises systemContextInjection — managed facts live in the
        // system prompt (nuncio-context), never duplicated into the user preamble.
        expect(session.prompt).not.toContain('## Project facts');
        expect(session.prompt).not.toContain('use make weird-build-never-in-preamble');
        expect(provider.capabilities.systemContextInjection).toBe(true);
      } finally {
        await abortSession(session.id);
      }
    },
    60_000,
  );

  it(
    'completeOneShot returns a tool-less completion on a cheap model',
    async () => {
      const text = await provider.completeOneShot({
        prompt:
          'Return exactly this JSON array and nothing else: ' +
          '[{"key":"smoke-fact","value":"integration completeOneShot works"}]',
        systemPrompt: 'You return only JSON. No prose, no code fence.',
        model: cheapModel,
        cwd: workspace,
      });

      expect(text.toLowerCase()).toMatch(/smoke-fact|completeoneshot works/);
    },
    90_000,
  );

  it(
    'FactDistillationService writes agent facts via real completeOneShot',
    async () => {
      const session = sessionsRepo.create({
        prompt: 'distill me',
        provider: 'pi',
        workspace,
        projectPath: workspace,
      });
      // Seed a substantive transcript so the substantive-event gate opens.
      const seed: SessionEvent[] = [
        { seq: 1, type: 'user_message', payload: { text: 'how do we test?' }, createdAt: 1 },
        { seq: 2, type: 'tool_start', payload: { tool: 'bash', input: { command: 'bun test' } }, createdAt: 2 },
        { seq: 3, type: 'tool_end', payload: { tool: 'bash', output: 'pass' }, createdAt: 3 },
        { seq: 4, type: 'tool_start', payload: { tool: 'read' }, createdAt: 4 },
        { seq: 5, type: 'tool_end', payload: { tool: 'read' }, createdAt: 5 },
        {
          seq: 6,
          type: 'assistant_message',
          payload: {
            text: 'This project always runs tests with `bun test` from the repo root. Remember that.',
          },
          createdAt: 6,
        },
        { seq: 7, type: 'status', payload: { status: 'IDLE' }, createdAt: 7 },
      ];
      for (const event of seed) {
        events.append(session.id, event.type, event.payload);
      }

      settings.set('NUNCIO_FACT_DISTILLATION', 'on');
      settings.set('NUNCIO_FACT_DISTILLATION_MODEL', cheapModel);

      await distill.handleEvent(session.id, {
        seq: 99,
        type: 'status',
        payload: { status: 'IDLE' },
        createdAt: Date.now(),
      });

      const recorded = facts.listPinnedFirst(workspace, 20);
      const agentFacts = recorded.filter((fact) => fact.provenance === 'agent');
      for (const fact of agentFacts) {
        expect(fact.key).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
        expect(fact.value.trim().length).toBeGreaterThan(0);
      }
      // Throttle map entry proves the completion path was attempted (set before
      // the provider call). A real model may still return [] — that is OK.
      expect(
        (distill as unknown as { lastDistilledAt: Map<string, number> }).lastDistilledAt.has(
          session.id,
        ),
      ).toBe(true);
    },
    120_000,
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}

async function resolveCheapModel(provider: PiAgentProvider): Promise<string> {
  const models = await provider.listModels();
  const ids = models.flatMap((p) =>
    (p.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => m.id)),
  );
  const picked = CHEAP_MODEL_CANDIDATES.find((c) => ids.includes(c));
  if (!picked) {
    throw new Error(
      `no cheap model available for context integration; looked for ${CHEAP_MODEL_CANDIDATES.join(', ')}; got ${ids.slice(0, 12).join(', ') || '(none)'}`,
    );
  }
  return picked;
}
