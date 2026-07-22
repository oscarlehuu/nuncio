import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import type { AgentProvider } from '../../../src/agents/agents.types';
import { RetainedEventFlushError } from '../../../src/agents/agents.base-provider';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { GitModule } from '../../../src/git/git.module';
import { GitService } from '../../../src/git/git.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { registerSessionEventHook } from '../../../src/sessions/domain/session-event-hooks';
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

describe('SessionsService lifecycle (phase 3)', () => {
  let service: SessionsService;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let registry: AgentRegistry;
  let database: DatabaseService;
  let git: GitService;
  let dataDir: string;
  let repoPath: string;
  let workspacesDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-svc-test-'));
    repoPath = mkdtempSync(join(tmpdir(), 'nuncio-svc-repo-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-svc-ws-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    // Simulated Cursor is this suite's default engine, so the legacy engines are shown.
    process.env.NUNCIO_ENGINES_SHOW_LEGACY = '1';
    configureSimulatedCursorEnv();
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;
    await initRepo(repoPath);

    const module: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    registry = module.get(AgentRegistry);
    database = module.get(DatabaseService);
    git = module.get(GitService);
  });

  afterAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
    delete process.env.NUNCIO_ENGINES_SHOW_LEGACY;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  function seedSession(
    status: 'IDLE' | 'PAUSED' | 'RUNNING' | 'ARCHIVED' | 'ERROR',
    verifyOwner: 'session' | 'crew' = 'session',
  ) {
    const created = sessions.create({
      prompt: 'Lifecycle test session',
      provider: 'cursor',
      verifyOwner,
    });
    sessions.updateStatus(created.id, 'RUNNING');
    if (status === 'RUNNING') return created.id;
    if (status === 'ERROR') {
      sessions.updateStatus(created.id, 'ERROR');
      return created.id;
    }
    sessions.updateStatus(created.id, 'IDLE');
    if (status === 'IDLE') return created.id;
    if (status === 'PAUSED') {
      sessions.updateStatus(created.id, 'PAUSED');
      return created.id;
    }
    sessions.updateStatus(created.id, 'ARCHIVED');
    return created.id;
  }

  function seedArchivedWithEvents(): string {
    const id = seedSession('ARCHIVED');
    events.append(id, 'user_message', { text: 'original prompt' });
    events.append(id, 'assistant_message', { text: 'a response' });
    return id;
  }

  it('steer requires IDLE or PAUSED session', async () => {
    const idleId = seedSession('IDLE');
    const pausedId = seedSession('PAUSED');

    await expect(service.steer(idleId, 'Continue with tests')).resolves.toMatchObject({
      status: 'IDLE',
    });
    await expect(service.steer(pausedId, 'Resume from pause')).resolves.toMatchObject({
      status: 'IDLE',
    });
  });

  it('continues an existing settled session with context and waits for that exact session', async () => {
    for (const status of ['IDLE', 'PAUSED', 'ERROR'] as const) {
      const id = seedSession(status);
      const beforeIds = service.list(true).map((session) => session.id).sort();

      const continued = await service.continueExistingSession(id, {
        prompt: `continue ${status.toLowerCase()}`,
        contextBrief: { goal: `Crew ${status.toLowerCase()} goal` },
      });

      expect(continued.id).toBe(id);
      expect(continued.status).toBe('IDLE');
      expect(service.list(true).map((session) => session.id).sort()).toEqual(beforeIds);
      const continuation = events.list(id).filter((event) => event.type === 'steer_message').at(-1);
      expect(continuation?.payload).toEqual(expect.objectContaining({
        text: expect.stringContaining(`Crew ${status.toLowerCase()} goal`),
      }));
    }
  });

  it('refuses generic continuation while the existing session is still running', async () => {
    const id = seedSession('RUNNING');
    await expect(service.continueExistingSession(id, { prompt: 'race the current turn' }))
      .rejects.toThrow('Cannot continue session in status RUNNING');
  });

  it('queues a steer while the session is RUNNING instead of rejecting', async () => {
    const id = seedSession('RUNNING');
    const result = await service.steer(id, 'Not yet');
    expect(result.status).toBe('RUNNING');
    expect(events.list(id).some((e) => e.type === 'steer_queued')).toBe(true);
  });

  it('rejects steer when session is ARCHIVED', async () => {
    const id = seedSession('ARCHIVED');
    await expect(service.steer(id, 'Too late')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('archive transitions IDLE and PAUSED sessions to ARCHIVED', () => {
    const idleId = seedSession('IDLE');
    const pausedId = seedSession('PAUSED');

    expect(service.archive(idleId).status).toBe('ARCHIVED');
    expect(service.archive(pausedId).status).toBe('ARCHIVED');
    expect(service.get(idleId)?.status).toBe('ARCHIVED');
    expect(service.get(pausedId)?.status).toBe('ARCHIVED');
  });

  it('does not notify status hooks when the surrounding transaction rolls back', () => {
    const id = seedSession('IDLE');
    const seen: string[] = [];
    const off = registerSessionEventHook((sessionId, event) => {
      if (sessionId === id && event.type === 'status') seen.push((event.payload as { status: string }).status);
    });
    const originalTransaction = database.transaction.bind(database);
    database.transaction = ((fn: () => unknown) => originalTransaction(() => {
      fn();
      throw new Error('commit failed');
    })) as DatabaseService['transaction'];
    try {
      expect(() => (service as unknown as { transition: (sessionId: string, status: 'PAUSED') => void })
        .transition(id, 'PAUSED')).toThrow('commit failed');
      expect(sessions.findById(id)?.status).toBe('IDLE');
      expect(seen).toEqual([]);
    } finally {
      database.transaction = originalTransaction as DatabaseService['transaction'];
      off();
    }
  });

  it('aborts an active verifier before pausing an IDLE session', () => {
    const id = seedSession('IDLE');
    const controller = new AbortController();
    const internals = service as unknown as {
      verifierControllers: Map<string, AbortController>;
    };
    internals.verifierControllers.set(id, controller);

    expect(service.pause(id).status).toBe('PAUSED');
    expect(controller.signal.aborted).toBe(true);

    internals.verifierControllers.delete(id);
  });

  it('rejects archive when session is RUNNING', () => {
    const id = seedSession('RUNNING');
    expect(() => service.archive(id)).toThrow(BadRequestException);
  });

  it('list excludes archived sessions by default', () => {
    const activeId = seedSession('IDLE');
    const archivedId = seedSession('IDLE');
    service.archive(archivedId);

    const listed = service.list();
    expect(listed.some((s) => s.id === activeId)).toBe(true);
    expect(listed.some((s) => s.id === archivedId)).toBe(false);
    expect(listed.every((s) => s.status !== 'ARCHIVED')).toBe(true);
  });

  it('list includes archived when includeArchived is true', () => {
    const archivedId = seedSession('IDLE');
    service.archive(archivedId);

    const listed = service.list(true);
    expect(listed.some((s) => s.id === archivedId && s.status === 'ARCHIVED')).toBe(true);
  });

  it('hides Crew member sessions from public lists while keeping detail readable', () => {
    const activeCrewId = seedSession('IDLE', 'crew');
    const archivedCrewId = seedSession('ARCHIVED', 'crew');

    expect(service.list().map((session) => session.id)).not.toContain(activeCrewId);
    expect(service.list(true).map((session) => session.id)).not.toContain(activeCrewId);
    expect(service.list(true).map((session) => session.id)).not.toContain(archivedCrewId);
    expect(service.get(activeCrewId)).toMatchObject({
      id: activeCrewId,
      verifyOwner: 'crew',
    });
    expect(service.get(archivedCrewId)).toMatchObject({
      id: archivedCrewId,
      verifyOwner: 'crew',
    });
  });

  it('rejects public mutations for Crew-owned sessions but allows internal continuation', async () => {
    const crewId = seedSession('IDLE', 'crew');
    const archivedCrewId = seedSession('ARCHIVED', 'crew');
    const message = 'Crew-owned sessions are read-only outside Crew controls';

    await expect(service.steer(crewId, 'bypass the Crew stage')).rejects.toThrow(message);
    await expect(service.interrupt(crewId)).rejects.toThrow(message);
    await expect(service.setSessionModel(crewId, 'cursor:other')).rejects.toThrow(message);
    await expect(service.respondInteraction(crewId, 'request', {
      answers: [],
      resolvedBy: 'skip',
    })).rejects.toThrow(message);
    expect(() => service.respondProviderRequest(crewId, 'request', 'approve')).toThrow(message);
    expect(() => service.pause(crewId)).toThrow(message);
    expect(() => service.archive(crewId)).toThrow(message);
    expect(() => service.rename(crewId, 'renamed outside Crew')).toThrow(message);
    expect(() => service.refreshTranscript(crewId)).toThrow(message);
    expect(() => service.restore(archivedCrewId)).toThrow(message);
    expect(() => service.delete(archivedCrewId)).toThrow(message);

    await expect(service.continueExistingSession(crewId, {
      prompt: 'continue through the trusted Crew runner',
      origin: 'crew-member-task',
    })).resolves.toMatchObject({ id: crewId, status: 'IDLE', verifyOwner: 'crew' });
  });

  it('quiesces a Crew-owned running session through the internal owner seam', async () => {
    const crewId = seedSession('RUNNING', 'crew');
    const provider = registry.get('cursor');
    const disposeSpy = jest.spyOn(provider, 'dispose');
    try {
      await expect(service.quiesceCrewSession(crewId)).resolves.toMatchObject({
        id: crewId,
        status: 'IDLE',
        verifyOwner: 'crew',
      });
      expect(disposeSpy).toHaveBeenCalledWith(crewId);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it('keeps a Crew session running until the provider acknowledges quiescence', async () => {
    const crewId = seedSession('RUNNING', 'crew');
    const provider = registry.get('cursor');
    let acknowledge: (() => void) | undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const quiesceSpy = jest.spyOn(provider, 'quiesce').mockImplementation(async () => acknowledgement);
    try {
      let settled = false;
      const quiescing = service.quiesceCrewSession(crewId).then((session) => {
        settled = true;
        return session;
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(service.get(crewId)?.status).toBe('RUNNING');
      expect(events.list(crewId).some((event) => event.type === 'interrupted')).toBe(false);

      acknowledge?.();
      await expect(quiescing).resolves.toMatchObject({ status: 'IDLE' });
    } finally {
      quiesceSpy.mockRestore();
    }
  });

  it('fences a Crew member whose initial provider start is still resolving', async () => {
    const provider = registry.get('cursor');
    let releaseProvider: ((value: AgentProvider) => void) | undefined;
    const providerReady = new Promise<AgentProvider>((resolve) => {
      releaseProvider = resolve;
    });
    const resolveSpy = jest.spyOn(registry, 'resolveAvailableForSession')
      .mockReturnValue(providerReady);
    const runSpy = jest.spyOn(provider, 'run');
    try {
      const created = await service.create({
        prompt: 'Crew start must not escape cancellation',
        provider: 'cursor',
        verifyOwner: 'crew',
      });

      await service.quiesceCrewSession(created.id);
      releaseProvider?.(provider);
      await service.awaitRun(created.id);

      expect(runSpy).not.toHaveBeenCalled();
      expect(events.list(created.id).some((event) => event.type === 'user_message')).toBe(false);
      expect(service.get(created.id)?.status).toBe('CREATED');
    } finally {
      resolveSpy.mockRestore();
      runSpy.mockRestore();
    }
  });

  it('fences a Crew continuation that is still resolving its provider', async () => {
    const crewId = seedSession('IDLE', 'crew');
    const provider = registry.get('cursor');
    let releaseProvider: ((value: AgentProvider) => void) | undefined;
    const providerReady = new Promise<AgentProvider>((resolve) => {
      releaseProvider = resolve;
    });
    const resolveSpy = jest.spyOn(registry, 'resolveAvailableForSession')
      .mockReturnValue(providerReady);
    const steerSpy = jest.spyOn(provider, 'steer');
    try {
      const continuation = service.continueExistingSession(crewId, {
        prompt: 'Do not start after the owner has quiesced this continuation',
        origin: 'crew-member-task',
      });
      await Promise.resolve();

      await service.quiesceCrewSession(crewId);
      releaseProvider?.(provider);
      await expect(continuation).resolves.toMatchObject({ status: 'IDLE' });

      expect(steerSpy).not.toHaveBeenCalled();
      expect(events.list(crewId).some((event) => event.type === 'steer_message')).toBe(false);
    } finally {
      resolveSpy.mockRestore();
      steerSpy.mockRestore();
    }
  });

  it('propagates provider quiescence failure without claiming the Crew session stopped', async () => {
    const crewId = seedSession('RUNNING', 'crew');
    const provider = registry.get('cursor');
    const quiesceSpy = jest.spyOn(provider, 'quiesce').mockRejectedValue(
      new Error('provider did not acknowledge stop'),
    );
    try {
      await expect(service.quiesceCrewSession(crewId)).rejects.toThrow(
        'provider did not acknowledge stop',
      );
      expect(service.get(crewId)?.status).toBe('RUNNING');
      expect(events.list(crewId).some((event) => event.type === 'interrupted')).toBe(false);
    } finally {
      quiesceSpy.mockRestore();
    }
  });

  it('list returns a session from an unregistered provider with capabilities disabled', () => {
    const ghost = sessions.create({
      id: 'ghost-open',
      prompt: 'stale test run',
      provider: 'ghost-provider',
    });

    const listed = service.list();
    const dto = listed.find((s) => s.id === ghost.id);

    expect(dto).toMatchObject({
      id: ghost.id,
      provider: 'ghost-provider',
      providerAvailable: false,
      supportsInteraction: false,
      supportsInterrupt: false,
      supportsSteerWhileRunning: false,
      supportsImages: false,
      pendingInput: false,
    });
  });

  it('archived list returns a session from an unregistered provider with capabilities disabled', () => {
    const ghost = sessions.create({
      id: 'ghost-archived',
      prompt: 'archived stale test run',
      provider: 'ghost-provider',
    });
    sessions.updateStatus(ghost.id, 'RUNNING');
    sessions.updateStatus(ghost.id, 'IDLE');
    sessions.updateStatus(ghost.id, 'ARCHIVED');

    expect(service.list().some((s) => s.id === ghost.id)).toBe(false);

    const listed = service.list(true);
    const dto = listed.find((s) => s.id === ghost.id);

    expect(dto).toMatchObject({
      id: ghost.id,
      status: 'ARCHIVED',
      provider: 'ghost-provider',
      providerAvailable: false,
    });
  });

  it('provider-required actions still reject a session from an unregistered provider', async () => {
    const ghost = sessions.create({
      id: 'ghost-action',
      prompt: 'action needs provider',
      provider: 'ghost-provider',
    });

    await expect(service.steer(ghost.id, 'resume this')).rejects.toMatchObject({
      response: { message: 'Unknown agent provider ghost-provider' },
      status: 400,
    });
  });

  it('archives a persisted session whose provider is no longer registered', () => {
    const ghost = sessions.create({
      id: 'ghost-lifecycle',
      prompt: 'old provider session',
      provider: 'ghost-provider',
    });
    sessions.updateStatus(ghost.id, 'RUNNING');
    sessions.updateStatus(ghost.id, 'IDLE');

    expect(service.archive(ghost.id).status).toBe('ARCHIVED');
  });

  it('retries an unknown-provider archive when its status write fails transiently', async () => {
    const ghost = sessions.create({
      id: 'ghost-lifecycle-retry',
      prompt: 'old provider retry',
      provider: 'ghost-provider',
    });
    sessions.updateStatus(ghost.id, 'RUNNING');
    sessions.updateStatus(ghost.id, 'IDLE');
    const originalAppend = events.append.bind(events);
    let archiveFailures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'status' && (payload as { status?: string }).status === 'ARCHIVED' && archiveFailures-- > 0) {
        throw new Error('archive status temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      expect(service.archive(ghost.id).status).toBe('IDLE');
      const started = Date.now();
      while (service.get(ghost.id)?.status !== 'ARCHIVED' && Date.now() - started < 1_500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(ghost.id)?.status).toBe('ARCHIVED');
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }
  });

  describe('restore', () => {
    it('transitions an ARCHIVED session back to IDLE', () => {
      const id = seedSession('ARCHIVED');
      const restored = service.restore(id);
      expect(restored.status).toBe('IDLE');
      expect(service.get(id)?.status).toBe('IDLE');
    });

    it('emits a status event when restoring', () => {
      const id = seedSession('ARCHIVED');
      const before = service.getEvents(id).length;
      service.restore(id);
      const after = service.getEvents(id);
      expect(after.length).toBeGreaterThan(before);
      const last = after[after.length - 1];
      expect(last.type).toBe('status');
      expect(last.payload).toEqual({ status: 'IDLE' });
    });

    it('repairs stale worktree metadata before restoring an archived session', () => {
      const missingWorktree = join(workspacesDir, 'removed-worktree');
      mkdirSync(missingWorktree, { recursive: true });
      const created = sessions.create({
        prompt: 'Restore after merge cleanup',
        provider: 'cursor',
        projectPath: repoPath,
        workspace: missingWorktree,
        worktreePath: missingWorktree,
        branch: 'feat/pr-head',
        runtimePolicy: {
          filesystem: 'workspace-write',
          network: 'disabled',
          workspaceRoot: missingWorktree,
        },
      });
      sessions.updateStatus(created.id, 'RUNNING');
      sessions.updateStatus(created.id, 'IDLE');
      sessions.updateStatus(created.id, 'ARCHIVED');

      const restored = service.restore(created.id);

      expect(restored).toMatchObject({
        status: 'IDLE',
        workspace: repoPath,
        worktreePath: null,
        branch: null,
      });
      expect(restored.runtimePolicy?.workspaceRoot).toBe(repoPath);
    });

    it('detaches stale PR ownership when restoring an archived former owner', () => {
      const former = sessions.create({
        prompt: 'former PR owner',
        provider: 'cursor',
        projectPath: repoPath,
        pullRequestNumber: 92,
        forgeProvider: 'github',
        pullRequestUrl: 'https://github.com/octo/nuncio/pull/92',
        pullRequestState: 'merged',
        forgeStatus: 'merged',
      });
      sessions.updateStatus(former.id, 'RUNNING');
      sessions.updateStatus(former.id, 'IDLE');
      sessions.updateStatus(former.id, 'ARCHIVED');
      const replacement = sessions.create({
        prompt: 'replacement PR owner',
        provider: 'cursor',
        projectPath: repoPath,
        pullRequestNumber: 92,
        forgeProvider: 'github',
      });

      const restored = service.restore(former.id);

      expect(restored).toMatchObject({
        status: 'IDLE',
        forgeProvider: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        pullRequestState: null,
        forgeStatus: 'none',
      });
      expect(sessions.findById(replacement.id)?.pullRequestNumber).toBe(92);
    });

    it('rejects restore on a non-archived session', () => {
      const idleId = seedSession('IDLE');
      const pausedId = seedSession('PAUSED');
      expect(() => service.restore(idleId)).toThrow(BadRequestException);
      expect(() => service.restore(pausedId)).toThrow(BadRequestException);
    });

    it('rejects restore on a missing session', () => {
      expect(() => service.restore('nope')).toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('permanently removes an archived session and its events', async () => {
      const id = await seedArchivedWithEvents();
      expect(service.get(id)).not.toBeNull();
      expect(events.list(id).length).toBeGreaterThan(0);

      await service.delete(id);

      expect(service.get(id)).toBeNull();
      expect(events.list(id)).toHaveLength(0);
    });

    it('rejects delete on a non-archived session (must archive first)', async () => {
      const idleId = seedSession('IDLE');
      const runningId = seedSession('RUNNING');
      await expect(service.delete(idleId)).rejects.toThrow(BadRequestException);
      await expect(service.delete(runningId)).rejects.toThrow(BadRequestException);
    });

    it('rejects delete on a missing session', async () => {
      await expect(service.delete('nope')).rejects.toThrow(NotFoundException);
    });

    it('disposes the agent handle before deleting', async () => {
      const id = await seedArchivedWithEvents();
      const provider = registry.get('cursor');
      const disposeSpy = jest.spyOn(provider, 'dispose');
      await service.delete(id);
      expect(disposeSpy).toHaveBeenCalledWith(id);
      disposeSpy.mockRestore();
    });

    it('surfaces a permanent media cleanup failure instead of retrying forever', async () => {
      const id = await seedArchivedWithEvents();
      const internals = service as unknown as { media?: { deleteSession: (sessionId: string) => void } };
      const originalMedia = internals.media;
      let cleanupCalls = 0;
      internals.media = { deleteSession: () => {
        cleanupCalls += 1;
        throw new Error('immutable media directory');
      } };
      try {
        const deleting = service.delete(id).then(
          () => null,
          (error: unknown) => error,
        );
        const started = Date.now();
        while (!events.list(id).some((event) => event.type === 'error') && Date.now() - started < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(events.list(id)).toContainEqual(expect.objectContaining({
          type: 'error',
          payload: expect.objectContaining({ message: expect.stringContaining('immutable media directory') }),
        }));
        expect(await deleting).toEqual(
          expect.objectContaining({ message: expect.stringContaining('immutable media directory') }),
        );
        const callsAfterSurface = cleanupCalls;
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(cleanupCalls).toBe(callsAfterSurface);
      } finally {
        internals.media = originalMedia;
      }
    });

    it('bounds the HTTP delete wait while retained cleanup continues in the background', async () => {
      const id = await seedArchivedWithEvents();
      let storageBlocked = true;
      const provider = {
        id: 'delete-retry',
        name: 'Delete retry',
        capabilities: {
          interrupt: false,
          modelSwitch: 'none',
          effortSwitch: 'none',
          images: false,
          steerWhileRunning: false,
        },
        isAvailable: async () => true,
        listModels: async () => [],
        run: async () => undefined,
        steer: async () => undefined,
        quiesce: async () => undefined,
        dispose: () => {
          if (storageBlocked) throw new RetainedEventFlushError(new Error('storage unavailable'));
        },
        bustCache: () => undefined,
      } as AgentProvider;
      const originalResolve = registry.resolveForSession.bind(registry);
      registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
      const internals = service as unknown as { deleteRetryWaitMs?: number };
      internals.deleteRetryWaitMs = 25;

      const deleting = service.delete(id).then(
        () => 'deleted' as const,
        (error: unknown) => error,
      );
      const outcome = await Promise.race([
        deleting,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 80)),
      ]);

      try {
        expect(outcome).not.toBe('hung');
        expect(outcome).toEqual(expect.objectContaining({
          message: expect.stringContaining('still pending'),
        }));
        expect(service.get(id)).not.toBeNull();
      } finally {
        storageBlocked = false;
        const started = Date.now();
        while (service.get(id) && Date.now() - started < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        registry.resolveForSession = originalResolve;
      }
      expect(service.get(id)).toBeNull();
    });
  });

  it('delegates lifecycle teardown once to provider-owned disposal', () => {
    const id = seedSession('IDLE');
    const calls: string[] = [];
    const provider = {
      id: 'ordered',
      name: 'Ordered',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => calls.push('dispose'),
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];

    try {
      service.archive(id);
      expect(calls).toEqual(['dispose']);
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('finishes the lifecycle transition after a retained tail retries successfully', async () => {
    const id = seedSession('IDLE');
    const calls: string[] = [];
    let remainingFailures = 1;
    const provider = {
      id: 'flush-failure',
      name: 'Flush failure',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        calls.push('dispose');
        if (remainingFailures-- > 0) {
          throw new RetainedEventFlushError(new Error('temporary sqlite failure'));
        }
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];

    try {
      expect(service.archive(id).status).toBe('IDLE');
      expect(calls).toEqual(['dispose']);
      expect(service.get(id)?.status).toBe('IDLE');
      const started = Date.now();
      while (service.get(id)?.status !== 'ARCHIVED' && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(id)?.status).toBe('ARCHIVED');
      expect(calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('replaces a pending pause retry with a newer archive request', async () => {
    const id = seedSession('IDLE');
    let storageAvailable = false;
    const provider = {
      id: 'latest-lifecycle-intent',
      name: 'Latest lifecycle intent',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        if (!storageAvailable) throw new RetainedEventFlushError(new Error('tail pending'));
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    try {
      expect(service.pause(id).status).toBe('IDLE');
      expect(service.archive(id).status).toBe('IDLE');
      storageAvailable = true;
      const started = Date.now();
      while (service.get(id)?.status !== 'ARCHIVED' && Date.now() - started < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(id)?.status).toBe('ARCHIVED');
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('flushes and fences retained IDLE events before pausing', async () => {
    const id = seedSession('IDLE');
    let disposeCalls = 0;
    const provider = {
      id: 'idle-pause-retry',
      name: 'Idle pause retry',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        disposeCalls += 1;
        if (disposeCalls === 1) throw new RetainedEventFlushError(new Error('idle tail pending'));
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];

    try {
      expect(service.pause(id).status).toBe('IDLE');
      const started = Date.now();
      while (service.get(id)?.status !== 'PAUSED' && Date.now() - started < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(disposeCalls).toBeGreaterThanOrEqual(2);
      expect(service.get(id)?.status).toBe('PAUSED');
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('retries pause completion when status persistence fails after runtime disposal', async () => {
    const id = seedSession('RUNNING');
    let disposeCalls = 0;
    const provider = {
      id: 'pause-transition-retry',
      name: 'Pause transition retry',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        disposeCalls += 1;
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    const originalAppend = events.append.bind(events);
    let pauseAppendFailures = 1;
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'status' && (payload as { status?: string }).status === 'PAUSED' && pauseAppendFailures-- > 0) {
        throw new Error('pause status temporarily failed');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      expect(() => service.pause(id)).not.toThrow();
      expect(service.get(id)?.status).toBe('RUNNING');
      const started = Date.now();
      while (service.get(id)?.status !== 'PAUSED' && Date.now() - started < 1_500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(id)?.status).toBe('PAUSED');
      expect(disposeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      registry.resolveForSession = originalResolve;
    }
  });

  it('surfaces a permanent provider disposal failure instead of retrying forever', async () => {
    const id = seedSession('IDLE');
    let calls = 0;
    const provider = {
      id: 'broken-runtime',
      name: 'Broken runtime',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        calls += 1;
        throw new Error('runtime cannot dispose');
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];

    try {
      expect(() => service.archive(id)).toThrow('runtime cannot dispose');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toBe(1);
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('surfaces a permanent provider failure that follows a retained-tail retry', async () => {
    const id = seedSession('IDLE');
    let calls = 0;
    const provider = {
      id: 'retry-then-broken',
      name: 'Retry then broken',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        calls += 1;
        if (calls === 1) throw new RetainedEventFlushError(new Error('tail still pending'));
        throw new Error('runtime failed after retry');
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];

    try {
      expect(service.archive(id).status).toBe('IDLE');
      const started = Date.now();
      while (service.get(id)?.status !== 'ERROR' && Date.now() - started < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(id)?.status).toBe('ERROR');
      expect(events.list(id)).toContainEqual(
        expect.objectContaining({
          type: 'error',
          payload: expect.objectContaining({ message: expect.stringContaining('runtime failed after retry') }),
        }),
      );
    } finally {
      registry.resolveForSession = originalResolve;
    }
  });

  it('retries an atomic lifecycle transition when its status event append fails', async () => {
    const id = seedSession('IDLE');
    let disposeCalls = 0;
    const provider = {
      id: 'transition-retry',
      name: 'Transition retry',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => undefined,
      quiesce: async () => undefined,
      dispose: () => {
        disposeCalls += 1;
        if (disposeCalls === 1) throw new RetainedEventFlushError(new Error('tail still pending'));
      },
      bustCache: () => undefined,
    } as AgentProvider;
    const originalResolve = registry.resolveForSession.bind(registry);
    const originalAppend = events.append.bind(events);
    let statusAppendFailures = 1;
    registry.resolveForSession = (() => provider) as AgentRegistry['resolveForSession'];
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'status' && (payload as { status?: string }).status === 'ARCHIVED' && statusAppendFailures-- > 0) {
        throw new Error('status append temporarily failed');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      expect(service.archive(id).status).toBe('IDLE');
      const started = Date.now();
      while (service.get(id)?.status !== 'ARCHIVED' && Date.now() - started < 1_500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(service.get(id)?.status).toBe('ARCHIVED');
      expect(events.list(id).filter(
        (event) => event.type === 'status' && (event.payload as { status?: string }).status === 'ARCHIVED',
      )).toHaveLength(1);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      registry.resolveForSession = originalResolve;
    }
  });

  describe('per-session provider selection', () => {
    it('defaults to cursor when provider omitted and cursor is available', async () => {
      const session = await service.create({ prompt: 'default provider task' });
      expect(session.provider).toBe('cursor');
      await waitForIdle(service, session.id);
    });

    it('stores an explicit cursor provider', async () => {
      const session = await service.create({ prompt: 'explicit cursor task', provider: 'cursor' });
      expect(session.provider).toBe('cursor');
      await waitForIdle(service, session.id);
    });

    it('rejects an unknown provider', async () => {
      await expect(
        service.create({ prompt: 'bad provider', provider: 'missing' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unavailable provider', async () => {
      const piProvider = registry.get('pi');
      const availableSpy = jest.spyOn(piProvider, 'isAvailable').mockResolvedValue(false);
      try {
        await expect(
          service.create({ prompt: 'pi without auth', provider: 'pi' }),
        ).rejects.toThrow(BadRequestException);
      } finally {
        availableSpy.mockRestore();
      }
    });
  });

  describe('provider capabilities', () => {
    function stubProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
      return {
        id: 'stub',
        name: 'Stub',
        capabilities: { interrupt: false, modelSwitch: 'none', effortSwitch: 'none', images: false, steerWhileRunning: false },
        isAvailable: async () => true,
        listModels: async () => [],
        run: async () => undefined,
        steer: async () => undefined,
        quiesce: async () => undefined,
        dispose: () => undefined,
        bustCache: () => undefined,
        ...overrides,
      };
    }

    it('interrupt rejects providers without interrupt support', async () => {
      const id = seedSession('RUNNING');
      const originalResolve = registry.resolveForSession.bind(registry);
      registry.resolveForSession = (() => stubProvider({ id: 'plain' })) as AgentRegistry['resolveForSession'];

      try {
        await expect(service.interrupt(id)).rejects.toThrow(BadRequestException);
      } finally {
        registry.resolveForSession = originalResolve;
      }
    });

    it('interrupt calls capable providers without disposing the session', async () => {
      const id = seedSession('RUNNING');
      const interrupt = jest.fn(async () => undefined);
      const dispose = jest.fn();
      const originalResolve = registry.resolveForSession.bind(registry);
      registry.resolveForSession = (() =>
        stubProvider({
          id: 'capable',
          capabilities: { interrupt: true, modelSwitch: 'none', effortSwitch: 'none', images: false, steerWhileRunning: false },
          interrupt,
          dispose,
        })) as AgentRegistry['resolveForSession'];

      try {
        await service.interrupt(id);
        expect(interrupt).toHaveBeenCalledWith(id);
        expect(dispose).not.toHaveBeenCalled();
        expect(service.get(id)?.status).toBe('RUNNING');
      } finally {
        registry.resolveForSession = originalResolve;
      }
    });

    it('persists model changes and live-switches when the provider supports it', async () => {
      const id = seedSession('IDLE');
      const setModel = jest.fn(async () => undefined);
      const originalResolve = registry.resolveForSession.bind(registry);
      registry.resolveForSession = (() =>
        stubProvider({
          id: 'capable',
          capabilities: {
            interrupt: false,
            modelSwitch: 'in-session',
            effortSwitch: 'in-session',
            images: false,
            steerWhileRunning: false,
          },
          setModel,
        })) as AgentRegistry['resolveForSession'];

      try {
        const updated = await service.setSessionModel(id, 'provider:model-b', { thinkingLevel: 'high' });
        expect(updated.model).toBe('provider:model-b');
        expect(updated.modelOptions).toEqual({ thinkingLevel: 'high' });
        expect(setModel).toHaveBeenCalledWith(id, 'provider:model-b', { thinkingLevel: 'high' });
      } finally {
        registry.resolveForSession = originalResolve;
      }
    });

    it('does not persist an in-session model change when live-switching fails', async () => {
      const id = seedSession('IDLE');
      sessions.updateModel(id, 'provider:model-a', { thinkingLevel: 'low' });
      const setModel = jest.fn(async () => {
        throw new Error('live switch failed');
      });
      const originalResolve = registry.resolveForSession.bind(registry);
      registry.resolveForSession = (() =>
        stubProvider({
          id: 'capable',
          capabilities: {
            interrupt: false,
            modelSwitch: 'in-session',
            effortSwitch: 'in-session',
            images: false,
            steerWhileRunning: false,
          },
          setModel,
        })) as AgentRegistry['resolveForSession'];

      try {
        await expect(
          service.setSessionModel(id, 'provider:model-b', { thinkingLevel: 'high' }),
        ).rejects.toThrow('live switch failed');
        expect(sessions.findById(id)?.model).toBe('provider:model-a');
        expect(sessions.findById(id)?.modelOptions).toEqual({ thinkingLevel: 'low' });
      } finally {
        registry.resolveForSession = originalResolve;
      }
    });
  });

  describe('workspace worktree integration', () => {
    it('uses the selected project directly when worktree is not requested', async () => {
      const session = await service.create({
        prompt: 'Inspect auth middleware',
        provider: 'cursor',
        projectPath: repoPath,
        baseBranch: 'main',
      });

      expect(session.projectPath).toBe(repoPath);
      expect(session.workspace).toBe(repoPath);
      expect(session.baseBranch).toBe('main');
      expect(session.worktreePath).toBeNull();
      expect(session.branch).toBeNull();

      await waitForIdle(service, session.id);
    });

    it('creates a session with worktree when explicitly requested', async () => {
      const session = await service.create({
        prompt: 'Fix auth middleware',
        provider: 'cursor',
        projectPath: repoPath,
        baseBranch: 'main',
        useWorktree: true,
      });

      expect(session.projectPath).toBe(repoPath);
      expect(session.workspace).toBeNull();
      expect(session.baseBranch).toBe('main');
      expect(session.worktreePath).toBe(join(workspacesDir, session.id));
      expect(session.branch).toBe(`nuncio/${session.id}-fix-auth-middleware`);

      await waitForIdle(service, session.id);
    });

    it('uses an internally reserved id for the session and its worktree', async () => {
      const session = await service.create({
        id: 'reserved',
        prompt: 'Recover issue delivery',
        provider: 'cursor',
        projectPath: repoPath,
        baseBranch: 'main',
        useWorktree: true,
      });

      expect(session.id).toBe('reserved');
      expect(session.worktreePath).toBe(join(workspacesDir, 'reserved'));
      expect(session.branch).toBe('nuncio/reserved-recover-issue-delivery');
      await waitForIdle(service, session.id);
    });

    it('persists the resolved default base branch for worktree sessions when omitted', async () => {
      const session = await service.create({
        prompt: 'Fix diff review',
        provider: 'cursor',
        projectPath: repoPath,
        useWorktree: true,
      });

      expect(session.baseBranch).toBe('main');
      expect(session.worktreePath).toBe(join(workspacesDir, session.id));
      expect(session.branch).toBe(`nuncio/${session.id}-fix-diff-review`);

      await waitForIdle(service, session.id);
    });

    it('configures an adopted source branch upstream before starting the session', async () => {
      const original = git.setWorktreeUpstream.bind(git);
      const calls: Array<[string, string, string]> = [];
      git.setWorktreeUpstream = async (...args) => {
        calls.push(args);
      };
      let worktreePath: string | null = null;
      try {
        const session = await service.create({
          prompt: 'Continue pull request',
          provider: 'cursor',
          projectPath: repoPath,
          baseBranch: 'main',
          useWorktree: true,
          pushBranch: 'feat/pr-head',
          upstreamBranch: 'origin/feat/pr-head',
        });
        worktreePath = session.worktreePath;
        expect(calls).toEqual([[
          session.worktreePath!,
          `nuncio/${session.id}-continue-pull-request`,
          'origin/feat/pr-head',
        ]]);
        expect(session.branch).toBe('feat/pr-head');
        await waitForIdle(service, session.id);
      } finally {
        git.setWorktreeUpstream = original;
        if (worktreePath) await git.removeWorktree(repoPath, worktreePath);
      }
    });

    it('does not persist a session when worktree creation fails', async () => {
      const before = service.list(true).length;
      await expect(
        service.create({
          prompt: 'Broken workspace',
          provider: 'cursor',
          projectPath: '/definitely/not/a/git/repo',
          baseBranch: 'main',
          useWorktree: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(service.list(true).length).toBe(before);
    });

    it('removes a newly created worktree when active PR ownership rejects the insert', async () => {
      sessions.create({
        prompt: 'existing PR owner',
        provider: 'cursor',
        projectPath: repoPath,
        pullRequestNumber: 91,
      });
      const before = readdirSync(workspacesDir).sort();

      await expect(service.create({
        prompt: 'stale adoption request',
        provider: 'cursor',
        projectPath: repoPath,
        baseBranch: 'main',
        useWorktree: true,
        pullRequestNumber: 91,
      })).rejects.toThrow('UNIQUE constraint failed');

      expect(readdirSync(workspacesDir).sort()).toEqual(before);
    });
  });
});

async function waitForIdle(service: SessionsService, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = service.get(id);
    if (session?.status === 'IDLE' || session?.status === 'ERROR') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
