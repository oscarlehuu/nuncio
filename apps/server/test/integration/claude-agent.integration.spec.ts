import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsModule } from '../../src/agents/agents.module';
import { ClaudeAgentProvider } from '../../src/agents/providers/claude-agent.provider';
import {
  findBundledClaudeBinary,
  parseAuthStatus,
} from '../../src/agents/providers/claude-cli-resolver';
import { DatabaseModule } from '../../src/db/database.module';
import { SettingsModule } from '../../src/settings/settings.module';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';

/**
 * Opt-in integration: exercises the Claude provider against the real Agent SDK
 * (which spawns the bundled Claude Code CLI). Gated by NUNCIO_CLAUDE_INTEGRATION=1
 * and a live login — self-skips otherwise so CI stays green without credentials.
 * Uses the cheapest model (haiku), tiny prompts, and an isolated tmp workspace so
 * it never touches the real ~/.nuncio data dir or the repo.
 */
const optIn = process.env.NUNCIO_CLAUDE_INTEGRATION === '1';
const testModel = process.env.NUNCIO_CLAUDE_TEST_MODEL?.trim() || 'claude:haiku';

/**
 * Synchronous availability gate (no top-level await): an explicit
 * ANTHROPIC_API_KEY, or the bundled Claude Code binary reporting a logged-in
 * `auth status`. Mirrors how the resolver probes availability at runtime, but
 * inline so the suite gate stays a plain const like the Codex integration spec.
 */
function claudeReady(): boolean {
  if (!optIn) return false;
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  const bin = process.env.NUNCIO_CLAUDE_BIN?.trim() || findBundledClaudeBinary(process.env);
  if (!bin) return false;
  const probe = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', env: process.env });
  if (probe.status !== 0) return false;
  return parseAuthStatus(probe.stdout)?.loggedIn === true;
}

const hasClaudeLogin = claudeReady();
const suite = hasClaudeLogin ? describe : describe.skip;

suite('ClaudeAgentProvider with the real Claude Agent SDK (integration)', () => {
  let module: TestingModule;
  let provider: ClaudeAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let workspaceDir: string;
  const activeSessionIds = new Set<string>();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-integration-'));
    workspaceDir = join(dataDir, 'workspace');
    mkdirSync(workspaceDir);
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule, AgentsModule],
    }).compile();

    provider = module.get(ClaudeAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const sessionId of activeSessionIds) provider?.dispose(sessionId);
      await module?.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.NUNCIO_DATA_DIR;
    }
  }, 60_000);

  it('runs a real turn, streams deltas, and the final message matches the result text', async () => {
    const created = sessions.create({
      prompt: 'Reply with exactly: NUNCIO_CLAUDE_OK',
      provider: 'claude',
      model: testModel,
    });
    activeSessionIds.add(created.id);
    const emitted: Array<{ type: string; seq?: number }> = [];

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: workspaceDir,
      model: created.model,
    });

    const after = sessions.findById(created.id);
    expect(after?.providerThreadId).toBeTruthy();
    expect(after?.status).toBe('IDLE');
    // Deltas streamed live and were persisted.
    expect(emitted.some((e) => e.type === 'assistant_delta' && typeof e.seq === 'number')).toBe(true);
    expect(events.list(created.id).some((e) => e.type === 'assistant_delta')).toBe(true);
    // The authoritative terminal message reflects the model's reply.
    expect(finalAssistantText(created.id).toUpperCase()).toContain('NUNCIO_CLAUDE_OK');
  }, 180_000);

  it('steers a live thread into a coherent second turn on the same providerThreadId', async () => {
    const created = sessions.create({
      // A conversational fact (not an instruction to obey) so the model treats the
      // recall as ordinary context rather than a directive to resist.
      prompt: 'My favorite fruit is the banana. Just acknowledge with: OK.',
      provider: 'claude',
      model: testModel,
    });
    activeSessionIds.add(created.id);

    await provider.run(created.id, created.prompt, { cwd: workspaceDir, model: created.model });
    const threadId = sessions.findById(created.id)?.providerThreadId;
    expect(threadId).toBeTruthy();

    await provider.steer(created.id, 'What fruit did I say was my favorite? Answer in one word.', {
      cwd: workspaceDir,
      model: created.model,
    });

    // Same thread, and the second turn recalls the first turn's context.
    expect(sessions.findById(created.id)?.providerThreadId).toBe(threadId);
    expect(events.list(created.id).some((e) => e.type === 'steer_message')).toBe(true);
    expect(finalAssistantText(created.id).toUpperCase()).toContain('BANANA');
  }, 240_000);

  it('interrupts mid-turn to a clean non-ERROR landing and still takes a follow-up', async () => {
    const created = sessions.create({
      prompt:
        'Run these bash commands one at a time in order, waiting for each: sleep 2, sleep 2, sleep 2, sleep 2, sleep 2. Then reply DONE.',
      provider: 'claude',
      model: testModel,
    });
    activeSessionIds.add(created.id);

    const run = provider.run(created.id, created.prompt, { cwd: workspaceDir, model: created.model });
    // Let the turn get underway, then interrupt while it is still working.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await provider.interrupt(created.id);
    await run;

    // A clean stop: session is IDLE (not ERROR), and an interrupted event landed.
    const afterInterrupt = sessions.findById(created.id);
    expect(afterInterrupt?.status).toBe('IDLE');
    expect(events.list(created.id).some((e) => e.type === 'interrupted')).toBe(true);
    expect(events.list(created.id).some((e) => e.type === 'error')).toBe(false);

    // The query survives the interrupt: a follow-up succeeds.
    await provider.steer(created.id, 'Reply with exactly: NUNCIO_CLAUDE_AFTER_INTERRUPT', {
      cwd: workspaceDir,
      model: created.model,
    });
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(finalAssistantText(created.id).toUpperCase()).toContain('NUNCIO_CLAUDE_AFTER_INTERRUPT');
  }, 240_000);

  it('resumes a persisted thread from a brand-new provider instance (durability across restart)', async () => {
    const created = sessions.create({
      prompt: 'My favorite animal is the otter. Just acknowledge with: OK.',
      provider: 'claude',
      model: testModel,
    });
    activeSessionIds.add(created.id);

    await provider.run(created.id, created.prompt, { cwd: workspaceDir, model: created.model });
    const threadId = sessions.findById(created.id)?.providerThreadId;
    expect(threadId).toBeTruthy();

    // Simulate a daemon restart: dispose the live handle and build a NEW module +
    // provider instance sharing the same data dir. The stored providerThreadId +
    // the same cwd must resume the on-disk Claude session.
    provider.dispose(created.id);
    const freshModule = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule, AgentsModule],
    }).compile();
    try {
      const freshProvider = freshModule.get(ClaudeAgentProvider);
      const freshSessions = freshModule.get(SessionsRepository);
      const freshEvents = freshModule.get(EventsRepository);

      const reloaded = freshSessions.findById(created.id)!;
      expect(freshProvider.canResumeThread(reloaded)).toBe(true);

      await freshProvider.steer(created.id, 'What animal did I say was my favorite? Answer in one word.', {
        cwd: workspaceDir,
        model: reloaded.model,
      });

      // Same thread, context retained across the fresh instance.
      expect(freshSessions.findById(created.id)?.providerThreadId).toBe(threadId);
      expect(finalAssistantText(created.id, freshEvents).toUpperCase()).toContain('OTTER');
      freshProvider.dispose(created.id);
    } finally {
      await freshModule.close();
    }
  }, 240_000);

  function finalAssistantText(sessionId: string, repo: EventsRepository = events): string {
    const message = repo.list(sessionId).filter((event) => event.type === 'assistant_message').at(-1);
    const payload = message?.payload as { text?: unknown } | undefined;
    return typeof payload?.text === 'string' ? payload.text : '';
  }
});
