import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGitAsync(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('SessionsService default workspace confinement (task-03)', () => {
  let service: SessionsService;
  let events: EventsRepository;
  let registry: AgentRegistry;
  let dataDir: string;
  let repoPath: string;
  let restorePi: () => void;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-confine-data-'));
    repoPath = mkdtempSync(join(tmpdir(), 'nuncio-confine-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_ENGINES_SHOW_LEGACY = '1';
    configureSimulatedCursorEnv();
    await initRepo(repoPath);

    const module: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    events = module.get(EventsRepository);
    registry = module.get(AgentRegistry);

    // Make the Nuncio Engine "available" without real Pi auth and no-op its run
    // so create() resolves the policy but never launches a real agent loop.
    const pi = registry.get('pi');
    const availableSpy = jest.spyOn(pi, 'isAvailable').mockResolvedValue(true);
    const runSpy = jest.spyOn(pi, 'run').mockResolvedValue(undefined);
    restorePi = () => {
      availableSpy.mockRestore();
      runSpy.mockRestore();
    };
  });

  afterAll(async () => {
    restorePi();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
    delete process.env.NUNCIO_ENGINES_SHOW_LEGACY;
    delete process.env.NUNCIO_ENGINE_WORKSPACE_CONFINEMENT;
  });

  function runtimePolicyEvents(id: string) {
    return events.list(id).filter((event) => event.type === 'runtime_policy');
  }

  it('leaves a Nuncio Engine project session unconfined by default (full machine access)', async () => {
    const session = await service.create({ prompt: 'edit here', provider: 'pi', projectPath: repoPath });

    expect(session.runtimePolicy ?? null).toBeNull();
    expect(runtimePolicyEvents(session.id)).toHaveLength(0);
  });

  it('leaves an ad-hoc session with no workspace unconfined', async () => {
    const session = await service.create({ prompt: 'just chat', provider: 'pi' });
    expect(session.runtimePolicy ?? null).toBeNull();
    expect(runtimePolicyEvents(session.id)).toHaveLength(0);
  });

  it('lets an explicit runtime policy win without emitting a default notice', async () => {
    const session = await service.create({
      prompt: 'hermetic run',
      provider: 'pi',
      projectPath: repoPath,
      runtimePolicy: {
        filesystem: 'read-only',
        network: 'disabled',
        workspaceRoot: repoPath,
      },
    });

    expect(session.runtimePolicy).toMatchObject({ filesystem: 'read-only' });
    expect(runtimePolicyEvents(session.id)).toHaveLength(0);
  });

  it('confines to workspace-write when the opt-in setting is on', async () => {
    process.env.NUNCIO_ENGINE_WORKSPACE_CONFINEMENT = 'on';
    try {
      const session = await service.create({ prompt: 'hermetic', provider: 'pi', projectPath: repoPath });

      expect(session.runtimePolicy).toEqual({
        filesystem: 'workspace-write',
        workspaceRoot: realpathSync(repoPath),
        network: 'disabled',
      });

      const notices = runtimePolicyEvents(session.id);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({
        filesystem: 'workspace-write',
        workspaceRoot: realpathSync(repoPath),
        source: 'default',
      });
      expect(typeof (notices[0].payload as { shellSandboxEnforced: boolean }).shellSandboxEnforced).toBe('boolean');
    } finally {
      delete process.env.NUNCIO_ENGINE_WORKSPACE_CONFINEMENT;
    }
  });

  it('does not confine legacy vendor-engine sessions', async () => {
    const session = await service.create({ prompt: 'cursor task', provider: 'cursor', projectPath: repoPath });
    expect(session.runtimePolicy ?? null).toBeNull();
    expect(runtimePolicyEvents(session.id)).toHaveLength(0);
  });
});
