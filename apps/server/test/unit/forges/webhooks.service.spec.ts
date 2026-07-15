import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhooksService } from '../../../src/forges/webhooks/webhooks.service';
import type { CreateSessionDto } from '../../../src/sessions/domain/sessions.types';
import type { ForgeIssueWebhookEvent } from '../../../src/forges/forges.types';

const KNOWN_PATH = '/projects/nuncio';

function makeEvent(overrides: Partial<ForgeIssueWebhookEvent> = {}): ForgeIssueWebhookEvent {
  return {
    provider: 'github',
    deliveryId: 'delivery-1',
    kind: 'issue',
    action: 'opened',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 7,
    title: 'Implement the rate limiter',
    body: 'Throttle requests please',
    labels: ['nuncio'],
    ...overrides,
  };
}

describe('WebhooksService (Phase 4)', () => {
  let module: TestingModule;
  let db: DatabaseService;
  let service: WebhooksService;
  let dataDir: string;

  let createCalls: CreateSessionDto[];
  let steerCalls: Array<{ id: string; message: string; origin?: string }>;
  let attentionSignals: Array<Record<string, unknown>>;
  let autoSteer: string;
  let autoCloseOnMerge: string;
  let forgeLogin: string | null;
  let steerError: Error | null;
  let jobLogCalls: number[];
  let forgeStateUpdates: Array<{ id: string; state: Record<string, unknown> }>;
  let archiveCalls: string[];
  let removeWorktreeCalls: Array<[string, string]>;
  let resolvedAttention: Array<[string, string]>;
  let worktreeClean: boolean;
  let unpushedCount: number;
  let removeWorktreeError: Error | null;
  let workflowJobsError: Error | null;
  let dirtyAfterArchive: boolean;
  let statusCalls: number;
  let projectPaths: string[];
  let matchingProjectPaths: Set<string>;
  let archiveError: Error | null;
  let ownerSession: { id: string; status: string; projectPath: string; pullRequestNumber: number } | null;
  let sessionsStub: {
    create: (dto: CreateSessionDto) => Promise<{ id: string }>;
    steer: (id: string, message: string, force?: boolean, attachments?: unknown, origin?: string) => Promise<{ id: string }>;
    archive: (id: string) => unknown;
  };
  let gitStub: {
    listProjects: () => Promise<Array<{ path: string }>>;
    remoteInfo: (path: string) => Promise<{ host: string; owner: string; repo: string }>;
    status: () => Promise<{ clean: boolean; files: never[]; branch: string; ahead: number; behind: number }>;
    unpushedCommits: () => Promise<{ branch: string; base: string; commits: Array<{ sha: string }> }>;
    removeWorktree: (repoRoot: string, worktreePath: string) => Promise<void>;
    removeWorktreeIfSafe: (
      repoRoot: string,
      worktreePath: string,
    ) => Promise<{ removed: boolean; reason?: string }>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhooks-service-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    db = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    db.db.exec('DELETE FROM forge_webhook_deliveries');
    createCalls = [];
    steerCalls = [];
    attentionSignals = [];
    autoSteer = '1';
    autoCloseOnMerge = '1';
    forgeLogin = 'nuncio-bot';
    steerError = null;
    jobLogCalls = [];
    forgeStateUpdates = [];
    archiveCalls = [];
    removeWorktreeCalls = [];
    resolvedAttention = [];
    worktreeClean = true;
    unpushedCount = 0;
    removeWorktreeError = null;
    workflowJobsError = null;
    dirtyAfterArchive = false;
    statusCalls = 0;
    projectPaths = [KNOWN_PATH];
    matchingProjectPaths = new Set([KNOWN_PATH]);
    archiveError = null;
    ownerSession = { id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7 };
    sessionsStub = {
      create: async (dto) => {
        createCalls.push(dto);
        return { id: 'sess-123' };
      },
      steer: async (id, message, _force, _attachments, origin) => {
        if (steerError) throw steerError;
        steerCalls.push({ id, message, origin });
        return { id };
      },
      archive: (id: string) => {
        if (archiveError) throw archiveError;
        archiveCalls.push(id);
        ownerSession = ownerSession ? { ...ownerSession, status: 'ARCHIVED' } : null;
        return ownerSession;
      },
    };
    gitStub = {
      listProjects: async () => projectPaths.map((path) => ({ path })),
      remoteInfo: async (path) =>
        matchingProjectPaths.has(path)
          ? { host: 'github.com', owner: 'octo', repo: 'nuncio' }
          : { host: 'github.com', owner: 'someone', repo: 'else' },
      status: async () => {
        statusCalls += 1;
        return {
          clean: worktreeClean && !(dirtyAfterArchive && statusCalls > 1),
          files: [], branch: 'nuncio/sess-pr', ahead: 0, behind: 0,
        };
      },
      unpushedCommits: async () => ({ branch: 'nuncio/sess-pr', base: 'origin/main', commits: Array.from({ length: unpushedCount }, (_, i) => ({ sha: String(i) })) }),
      removeWorktree: async (repoRoot: string, worktreePath: string) => {
        if (removeWorktreeError) throw removeWorktreeError;
        removeWorktreeCalls.push([repoRoot, worktreePath]);
      },
      removeWorktreeIfSafe: async (repoRoot: string, worktreePath: string) => {
        if (removeWorktreeError) {
          return { removed: false, reason: 'worktree-removal-failed' };
        }
        if (!(await gitStub.status()).clean) {
          return { removed: false, reason: 'dirty-after-archive' };
        }
        if ((await gitStub.unpushedCommits()).commits.length > 0) {
          return { removed: false, reason: 'unpushed-after-archive' };
        }
        removeWorktreeCalls.push([repoRoot, worktreePath]);
        return { removed: true };
      },
    };
    service = new (WebhooksService as never as new (...args: never[]) => WebhooksService)(
      sessionsStub as never,
      gitStub as never,
      db as never,
      {
        findByProjectPullRequest: (path: string) =>
          ownerSession?.projectPath === path ? ownerSession : null,
        updateForgeState: (id: string, state: Record<string, unknown>) => {
          forgeStateUpdates.push({ id, state });
          return ownerSession;
        },
      } as never,
      { resolve: (key: string) => key === 'forges.autoCloseOnMerge' ? autoCloseOnMerge : autoSteer } as never,
      { listStatus: async () => [{ id: 'github', login: forgeLogin, connected: true }] } as never,
      {
        getWorkflowRunJobs: async () => {
          if (workflowJobsError) throw workflowJobsError;
          return [{ id: 901, name: 'unit-tests', status: 'completed', conclusion: 'failure' }];
        },
        getJobLog: async (_path: string, id: number) => {
          jobLogCalls.push(id);
          return { log: 'AssertionError: expected 2 to be 3', truncated: false };
        },
      } as never,
      {
        raise: (signal: Record<string, unknown>) => attentionSignals.push(signal),
        onConditionCleared: (kind: string, subject: string) => resolvedAttention.push([kind, subject]),
      } as never,
    );
  });

  it('creates a session for a labeled issue.opened on a known repo', async () => {
    const result = await service.handleEvent('github', makeEvent());

    expect(result.created).toBe(true);
    expect(result.sessionId).toBe('sess-123');
    expect(createCalls).toHaveLength(1);
    const dto = createCalls[0];
    expect(dto.prompt).toContain('Implement the rate limiter');
    expect(dto.prompt).toContain('Throttle requests please');
    expect(dto.projectPath).toBe(KNOWN_PATH);
    expect(dto.baseBranch).toBe('main');
    expect(dto.useWorktree).toBe(true);
  });

  it('ignores an unknown repo (no local match) without creating a session', async () => {
    const result = await service.handleEvent(
      'github',
      makeEvent({ owner: 'someone', repo: 'else', repoFullName: 'someone/else' }),
    );

    expect(result).toEqual({ created: false, reason: 'unknown-repo' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores an issue missing the nuncio label', async () => {
    const result = await service.handleEvent('github', makeEvent({ labels: ['enhancement'] }));

    expect(result).toEqual({ created: false, reason: 'no-label' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores a non-opened action', async () => {
    const result = await service.handleEvent('github', makeEvent({ action: 'closed' }));

    expect(result).toEqual({ created: false, reason: 'ignored-action' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores pull_request events (v1: issues only)', async () => {
    const result = await service.handleEvent(
      'github',
      { ...makeEvent(), kind: 'pull_request' } as never,
    );

    expect(result).toEqual({ created: false, reason: 'ignored-action' });
    expect(createCalls).toHaveLength(0);
  });

  it('dedupes a replayed delivery: second call is duplicate and only one session is created', async () => {
    const first = await service.handleEvent('github', makeEvent({ deliveryId: 'dup-1' }));
    const second = await service.handleEvent('github', makeEvent({ deliveryId: 'dup-1' }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, reason: 'duplicate' });
    expect(createCalls).toHaveLength(1);
  });

  it('routes pull-request feedback to the owning session with review context', async () => {
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github',
        deliveryId: 'feedback-1',
        kind: 'pull_request_feedback',
        action: 'submitted',
        owner: 'octo',
        repo: 'nuncio',
        repoFullName: 'octo/nuncio',
        defaultBranch: 'main',
        number: 7,
        author: 'reviewer',
        reviewState: 'changes_requested',
        comments: [{ body: 'Handle the null case.', path: 'src/a.ts', line: 19 }],
        url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );

    expect(result).toMatchObject({ created: false, steered: true, sessionId: 'sess-pr' });
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0]).toMatchObject({ id: 'sess-pr', origin: 'forge:github:pr-feedback' });
    expect(steerCalls[0].message).toContain('reviewer');
    expect(steerCalls[0].message).toContain('changes_requested');
    expect(steerCalls[0].message).toContain('Handle the null case.');
    expect(steerCalls[0].message).toContain('src/a.ts:19');
    expect(steerCalls[0].message).toContain('https://github.com/octo/nuncio/pull/7');
  });

  it('raises pr-feedback attention when no session owns the pull request', async () => {
    ownerSession = null;

    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-2', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'reviewer', comments: [{ body: 'Please fix.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );

    expect(result).toMatchObject({ created: false, reason: 'no-owning-session' });
    expect(steerCalls).toHaveLength(0);
    expect(attentionSignals).toContainEqual(expect.objectContaining({
      kind: 'pr-feedback',
      subjectId: 'octo/nuncio#7',
      projectPath: KNOWN_PATH,
    }));
  });

  it('ignores feedback authored by the authenticated forge login', async () => {
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-own', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'nuncio-bot', comments: [{ body: 'Agent reply.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );

    expect(result).toEqual({ created: false, reason: 'own-forge-author' });
    expect(steerCalls).toHaveLength(0);
    expect(attentionSignals).toHaveLength(0);
  });

  it('dedupes replayed feedback before steering a second time', async () => {
    const event = {
      provider: 'github', deliveryId: 'feedback-replay', kind: 'pull_request_feedback', action: 'created',
      owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
      author: 'reviewer', comments: [{ body: 'One delivery.' }], url: 'https://github.com/octo/nuncio/pull/7',
    } as never;

    await service.handleEvent('github', event);
    expect(await service.handleEvent('github', event)).toEqual({ created: false, reason: 'duplicate' });
    expect(steerCalls).toHaveLength(1);
  });

  it('fails closed when the authenticated forge login cannot be established', async () => {
    forgeLogin = null;
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-no-login', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'reviewer', comments: [{ body: 'Please fix.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );
    expect(result).toEqual({ created: false, reason: 'forge-login-unavailable' });
    expect(steerCalls).toHaveLength(0);
  });

  it('retains a failed delivery claim so a retry cannot duplicate a possibly-persisted steer', async () => {
    const event = {
      provider: 'github', deliveryId: 'feedback-retry', kind: 'pull_request_feedback', action: 'created',
      owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
      author: 'reviewer', comments: [{ body: 'Retry me.' }], url: 'https://github.com/octo/nuncio/pull/7',
    } as never;
    steerError = new Error('temporary provider failure');
    await expect(service.handleEvent('github', event)).rejects.toThrow('temporary provider failure');
    steerError = null;
    await expect(service.handleEvent('github', event)).resolves.toEqual({ created: false, reason: 'duplicate' });
    expect(steerCalls).toHaveLength(0);
  });

  it('refuses to steer an owning session when feedback has no author', async () => {
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-no-author', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: '', comments: [{ body: 'Unknown source.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );
    expect(result).toEqual({ created: false, reason: 'missing-feedback-author' });
    expect(steerCalls).toHaveLength(0);
  });

  it('raises no-owner attention even when forge identity is unavailable', async () => {
    ownerSession = null;
    forgeLogin = null;
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-no-owner-login', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'reviewer', comments: [{ body: 'Needs an owner.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );
    expect(result).toMatchObject({ reason: 'no-owning-session' });
    expect(attentionSignals).toContainEqual(expect.objectContaining({ kind: 'pr-feedback' }));
  });

  it('ignores own-authored feedback even when the prior owning session is no longer active', async () => {
    ownerSession = null;
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-own-no-owner', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'nuncio-bot', comments: [{ body: 'Delayed agent reply.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );
    expect(result).toEqual({ created: false, reason: 'own-forge-author' });
    expect(attentionSignals).toHaveLength(0);
  });

  it('routes a CI failure with the failing job log tail to the owning session', async () => {
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'ci-1', kind: 'ci_failure', action: 'failed',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        runId: 90, jobName: 'CI', url: 'https://github.com/octo/nuncio/actions/runs/90',
      } as never,
    );

    expect(result).toMatchObject({ created: false, steered: true, sessionId: 'sess-pr' });
    expect(jobLogCalls).toEqual([901]);
    expect(steerCalls[0].message).toContain('unit-tests');
    expect(steerCalls[0].message).toContain('AssertionError: expected 2 to be 3');
  });

  it('still steers CI failure context when workflow job lookup is unavailable', async () => {
    workflowJobsError = new Error('forge unavailable');
    const result = await service.handleEvent('github', {
      provider: 'github', deliveryId: 'ci-job-list-failed', kind: 'ci_failure', action: 'failed',
      owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
      runId: 90, jobName: 'CI', url: 'https://github.com/octo/nuncio/actions/runs/90',
      labels: [],
    });

    expect(result).toMatchObject({ steered: true, sessionId: 'sess-pr' });
    expect(steerCalls[0].message).toContain('Job: CI');
    expect(steerCalls[0].message).toContain('[Job log unavailable]');
  });

  it('selects the matching clone that owns the pull request', async () => {
    projectPaths = ['/projects/other-clone', KNOWN_PATH];
    matchingProjectPaths.add('/projects/other-clone');
    const result = await service.handleEvent('github', {
      provider: 'github', deliveryId: 'feedback-duplicate-clone', kind: 'pull_request_feedback',
      action: 'created', owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio',
      defaultBranch: 'main', number: 7, author: 'reviewer',
      comments: [{ body: 'Route to the owner.' }],
      url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    });

    expect(result).toMatchObject({ steered: true, sessionId: 'sess-pr' });
    expect(attentionSignals).toHaveLength(0);
  });

  it('raises attention for a CI failure without an owning session', async () => {
    ownerSession = null;
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'ci-no-owner', kind: 'ci_failure', action: 'failed',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        runId: 90, jobName: 'CI', url: 'https://github.com/octo/nuncio/actions/runs/90',
      } as never,
    );

    expect(result).toMatchObject({ created: false, reason: 'no-owning-session' });
    expect(attentionSignals).toContainEqual(expect.objectContaining({ kind: 'pr-feedback', subjectId: 'octo/nuncio#7' }));
    expect(jobLogCalls).toHaveLength(0);
  });

  it('disables all feedback and CI auto-steer behavior with one setting', async () => {
    autoSteer = '0';
    const result = await service.handleEvent(
      'github',
      {
        provider: 'github', deliveryId: 'feedback-disabled', kind: 'pull_request_feedback', action: 'created',
        owner: 'octo', repo: 'nuncio', repoFullName: 'octo/nuncio', defaultBranch: 'main', number: 7,
        author: 'reviewer', comments: [{ body: 'Please fix.' }], url: 'https://github.com/octo/nuncio/pull/7',
      } as never,
    );

    expect(result).toEqual({ created: false, reason: 'auto-steer-disabled' });
    expect(steerCalls).toHaveLength(0);
    expect(attentionSignals).toHaveLength(0);
  });

  it('archives an idle clean merged-PR session and removes its worktree', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    const result = await service.handleEvent(
      'github',
      {
        ...makeEvent({ deliveryId: 'merged-clean', kind: 'issue' }),
        kind: 'pull_request', action: 'closed', merged: true,
        url: 'https://github.com/octo/nuncio/pull/7', labels: [],
      } as never,
    );

    expect(result).toMatchObject({ created: false, archived: true, sessionId: 'sess-pr' });
    expect(forgeStateUpdates).toContainEqual({
      id: 'sess-pr',
      state: expect.objectContaining({ pullRequestState: 'merged', forgeStatus: 'merged' }),
    });
    expect(archiveCalls).toEqual(['sess-pr']);
    expect(removeWorktreeCalls).toEqual([[KNOWN_PATH, '/worktrees/sess-pr']]);
    expect(resolvedAttention).toContainEqual(['pr-review', `${KNOWN_PATH}#7`]);
    expect(resolvedAttention).toContainEqual(['pr-feedback', 'octo/nuncio#7']);
  });

  it('skips destructive merge cleanup and raises attention for a dirty worktree', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    worktreeClean = false;
    const result = await service.handleEvent(
      'github',
      {
        ...makeEvent({ deliveryId: 'merged-dirty' }), kind: 'pull_request', action: 'closed',
        merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
      } as never,
    );

    expect(result).toMatchObject({ created: false, reason: 'dirty-worktree' });
    expect(archiveCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
    expect(attentionSignals).toContainEqual(expect.objectContaining({
      kind: 'pr-feedback',
      subjectId: 'octo/nuncio#7:cleanup',
      payload: expect.objectContaining({ reason: 'dirty-worktree' }),
    }));
  });

  it('skips merged cleanup for unpushed commits', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    unpushedCount = 1;
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-unpushed' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'unpushed-commits' });
    expect(archiveCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  it('skips merged cleanup while the owning session is running', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'RUNNING', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-running' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'session-running' });
    expect(archiveCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  it('updates forge state only when a pull request closes without merging', async () => {
    const event = {
      ...makeEvent({ deliveryId: 'closed-unmerged' }), kind: 'pull_request', action: 'closed',
      merged: false, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never;
    const first = await service.handleEvent('github', event);
    const replay = await service.handleEvent('github', event);

    expect(first).toMatchObject({ closed: true, sessionId: 'sess-pr' });
    expect(forgeStateUpdates[0].state).toMatchObject({ pullRequestState: 'closed', forgeStatus: 'closed' });
    expect(archiveCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
    expect(replay).toEqual({ created: false, reason: 'duplicate' });
  });

  it('updates merged state and resolves PR attention when auto-close is disabled', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    autoCloseOnMerge = '0';
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-disabled' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'auto-close-disabled', sessionId: 'sess-pr' });
    expect(forgeStateUpdates[0].state).toMatchObject({ pullRequestState: 'merged' });
    expect(resolvedAttention).toContainEqual(['pr-review', `${KNOWN_PATH}#7`]);
    expect(archiveCalls).toHaveLength(0);
  });

  it('updates merged state for an already archived owner without repeating cleanup', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'ARCHIVED', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-archived' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'already-archived', sessionId: 'sess-pr' });
    expect(forgeStateUpdates[0].state).toMatchObject({ pullRequestState: 'merged' });
    expect(archiveCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  it('raises cleanup attention when non-forced worktree removal fails', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    removeWorktreeError = new Error('worktree became dirty');
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-remove-failed' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'worktree-removal-failed' });
    expect(archiveCalls).toEqual(['sess-pr']);
    expect(attentionSignals).toContainEqual(expect.objectContaining({
      subjectId: 'octo/nuncio#7:cleanup',
      payload: expect.objectContaining({ reason: 'worktree-removal-failed' }),
    }));
  });

  it('rechecks the worktree after archive and preserves it if a final write appears', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    dirtyAfterArchive = true;
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-final-write' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'dirty-after-archive' });
    expect(archiveCalls).toEqual(['sess-pr']);
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  it('raises cleanup attention when the session starts running before archive', async () => {
    ownerSession = {
      id: 'sess-pr', status: 'IDLE', projectPath: KNOWN_PATH, pullRequestNumber: 7,
      worktreePath: '/worktrees/sess-pr', baseBranch: 'main',
    } as never;
    archiveError = new Error('Invalid transition RUNNING to ARCHIVED');
    const result = await service.handleEvent('github', {
      ...makeEvent({ deliveryId: 'merged-archive-race' }), kind: 'pull_request', action: 'closed',
      merged: true, url: 'https://github.com/octo/nuncio/pull/7', labels: [],
    } as never);

    expect(result).toMatchObject({ reason: 'archive-race' });
    expect(attentionSignals).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ reason: 'archive-race' }),
    }));
  });
});
