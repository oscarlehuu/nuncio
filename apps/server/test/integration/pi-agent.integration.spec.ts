import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider } from '../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../src/db/database.module';
import { GitService } from '../../src/git/git.service';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';

// Gate the suite on the same agent dir the Pi SDK resolves (PI_CODING_AGENT_DIR
// or ~/.pi/agent). Skips entirely in CI / machines without real Pi auth, so the
// Pi SDK native module is never loaded there.
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const hasRealPiAuth = existsSync(join(piAgentDir, 'auth.json'));
const suite = hasRealPiAuth ? describe : describe.skip;

suite('PiAgentProvider with real Pi auth (integration)', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let previousForceMock: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-integration-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousForceMock = process.env.NUNCIO_FORCE_MOCK;
    delete process.env.NUNCIO_FORCE_MOCK;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousForceMock === undefined) delete process.env.NUNCIO_FORCE_MOCK;
    else process.env.NUNCIO_FORCE_MOCK = previousForceMock;
  });

  it('reports availability when Pi auth is configured', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('lists real models from the Pi registry', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((p) => p.id === 'pi')).toBe(true);
  });

  // Real LLM call — uses the configured Pi credentials. Minimal prompt to keep
  // cost/latency low; the agent's bash/read tools are available but a "reply
  // pong" prompt should not invoke them.
  it(
    'runs a real prompt and reaches IDLE',
    async () => {
      const created = sessions.create({ prompt: 'Reply with the single word: pong', provider: 'pi' });

      await provider.run(created.id, created.prompt, { emit: () => {} });

      const all = events.list(created.id);
      expect(all.some((e) => e.type === 'user_message')).toBe(true);
      expect(all.some((e) => e.type === 'assistant_message')).toBe(true);
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
    },
    60_000,
  );

  // Real LLM call — proves the Pi SDK actually honors `cwd` + `SessionManager.inMemory(cwd)`
  // and runs its tools inside the worktree. Drops a uniquely-named marker file in the
  // worktree, asks the agent to `ls` the current directory, and asserts the marker
  // filename appears in the streamed events. This is the only test that exercises the
  // real Phase 4 cwd path end-to-end (GitService worktree → Pi cwd → tool execution).
  it(
    'runs a real Pi session inside a git worktree and operates in its cwd',
    async () => {
      const workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-cwd-ws-'));
      process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;
      const git = new GitService();

      const repoDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-cwd-repo-'));
      mkdirSync(repoDir, { recursive: true });
      await runGitAsync(repoDir, ['init', '-b', 'main']);
      writeFileSync(join(repoDir, 'README.md'), '# cwd proof\n');
      await runGitAsync(repoDir, ['add', 'README.md']);
      await runGitAsync(repoDir, ['commit', '-m', 'init']);

      const sessionId = 'picide01';
      const marker = `NUNCIO_CWD_MARKER_${sessionId}.txt`;
      let worktreePath = '';
      try {
        const worktree = await git.createWorktree(repoDir, 'main', sessionId, 'cwd-proof');
        worktreePath = worktree.worktreePath;
        writeFileSync(join(worktreePath, marker), 'proof\n');

        const created = sessions.create({
          id: sessionId,
          prompt: `Run \`ls\` in the current directory and reply with the exact file list, nothing else.`,
          provider: 'pi',
        });

        const emitted: { type: string; payload: unknown }[] = [];
        await provider.run(created.id, created.prompt, {
          emit: (event) => emitted.push(event),
          cwd: worktreePath,
        });

        const all = events.list(created.id);
        const blob = JSON.stringify(
          all.map((e) => ({ type: e.type, payload: e.payload })),
        ) + JSON.stringify(emitted.map((e) => ({ type: e.type, payload: e.payload })));

        expect(blob).toContain(marker);
        expect(sessions.findById(created.id)?.status).toBe('IDLE');
      } finally {
        try {
          await git.removeWorktree(repoDir, worktreePath);
        } catch {
          // best-effort
        }
        rmSync(workspacesDir, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
        delete process.env.NUNCIO_WORKSPACES_DIR;
      }
    },
    120_000,
  );
});

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}
