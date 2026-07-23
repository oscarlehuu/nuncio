import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import { AttentionCollectors } from '../../../src/attention/attention-collectors';
import { LoopsService } from '../../../src/loops/loops.service';
import { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import { RecentProjectsRepository } from '../../../src/git/recent-projects.repository';
import {
  notifySessionEventHooks,
} from '../../../src/sessions/domain/session-event-hooks';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { LoopDto } from '../../../src/loops/loops.types';

/**
 * The rung-1/2 signal collectors (sub-phase A). Verifies the ADDITIVE wiring:
 * existing session events + loop status drive attention items, with dedup +
 * auto-resolve. A minimal LoopsService fake supplies loop status for the
 * broken-loop collector + probe.
 */
class FakeLoops {
  loops: LoopDto[] = [];
  list(): LoopDto[] {
    return this.loops;
  }
  findById(id: string): LoopDto | null {
    return this.loops.find((l) => l.id === id) ?? null;
  }
}

/** Fake forge repo service: returns canned open PRs per path, or throws (unreachable). */
class FakeForgeRepos {
  prsByPath = new Map<string, Array<{ number: number; title: string; url: string }>>();
  identitiesByPath = new Map<string, string>();
  unreachablePaths = new Set<string>();
  listCalls: string[] = [];
  async resolveRepoIdentity(path: string): Promise<string> {
    const identity = this.identitiesByPath.get(path);
    if (!identity) throw new Error('repo identity unavailable');
    return identity;
  }
  async listPullRequests(path: string): Promise<Array<{ number: number; title: string; url: string }>> {
    this.listCalls.push(path);
    if (this.unreachablePaths.has(path)) throw new Error('forge unreachable');
    return this.prsByPath.get(path) ?? [];
  }
}

class FakeRecentProjects {
  paths: string[] = [];
  list(): Array<{ path: string; name: string; lastUsedAt: number }> {
    return this.paths.map((path) => ({ path, name: path, lastUsedAt: 0 }));
  }
}

function event(type: string, payload: unknown, seq = 1): SessionEvent {
  return { seq, type, payload, createdAt: 0 };
}

function loop(over: Partial<LoopDto> = {}): LoopDto {
  return {
    id: over.id ?? 'loop-1',
    name: over.name ?? null,
    goal: over.goal ?? 'nightly',
    scheduleId: 's',
    maxRunsPerDay: 5,
    maxConsecutiveFailures: 3,
    stop: null,
    escalation: 'needs-attention',
    projectPath: over.projectPath ?? '/repos/x',
    engine: null,
    model: null,
    status: over.status ?? 'broken',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('AttentionCollectors', () => {
  let module: TestingModule;
  let collectors: AttentionCollectors;
  let attention: AttentionService;
  let fakeLoops: FakeLoops;
  let fakeForge: FakeForgeRepos;
  let fakeRecent: FakeRecentProjects;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-collect-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    fakeLoops = new FakeLoops();
    fakeForge = new FakeForgeRepos();
    fakeRecent = new FakeRecentProjects();
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        AttentionRepository,
        AttentionService,
        AttentionCollectors,
        { provide: LoopsService, useValue: fakeLoops },
        { provide: ForgeRepoService, useValue: fakeForge },
        { provide: RecentProjectsRepository, useValue: fakeRecent },
      ],
    }).compile();
    attention = module.get(AttentionService);
    collectors = module.get(AttentionCollectors);
    collectors.onModuleInit(); // registers the event hook + probes + boot sweep
  });

  afterEach(async () => {
    collectors.onModuleDestroy();
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('raises a permission item on user_input_requested (existing event, no new type)', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1', title: 'Approve?' }));
    const items = attention.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('permission');
    expect(items[0]!.subjectId).toBe('sess-1:r1');
  });

  it('resolves the permission item when the input is resolved', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }));
    notifySessionEventHooks('sess-1', event('user_input_resolved', { requestId: 'r1' }, 2));
    expect(attention.list().items.filter((i) => i.kind === 'permission')).toHaveLength(0);
  });

  it('does not stack duplicate permission items for the same request', () => {
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }));
    notifySessionEventHooks('sess-1', event('user_input_requested', { requestId: 'r1' }, 2));
    expect(attention.list().items.filter((i) => i.kind === 'permission')).toHaveLength(1);
  });

  it('raises a verify-dead item on verify_needs_attention', () => {
    notifySessionEventHooks('sess-9', event('verify_needs_attention', {}));
    const item = attention.list().items.find((i) => i.kind === 'verify-dead' && i.subjectId === 'sess-9');
    expect(item?.title).toBe('Checks still failing after auto-fix — needs your decision');
  });

  it('sweep raises a tripped-breaker item for a broken loop', async () => {
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
    await collectors.sweep();
    const item = attention.list().items.find((i) => i.kind === 'tripped-breaker' && i.subjectId === 'loop-1');
    expect(item?.title).toBe('Autopilot paused "nightly" after repeated failures');
  });

  it('a broken loop that resumed auto-resolves its item on the next sweep', async () => {
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
    await collectors.sweep();
    expect(attention.list().items.some((i) => i.subjectId === 'loop-1')).toBe(true);
    // The loop resumed → the probe reports the condition cleared.
    fakeLoops.loops = [loop({ id: 'loop-1', status: 'active' })];
    await collectors.sweep();
    expect(attention.list().items.some((i) => i.subjectId === 'loop-1')).toBe(false);
  });

  describe('provider approval events (finding #1)', () => {
    it('raises a permission item on provider_request (Codex/provider approval)', () => {
      notifySessionEventHooks('sess-2', event('provider_request', { requestId: 'p1', method: 'exec' }));
      const items = attention.list().items;
      expect(items.some((i) => i.kind === 'permission' && i.subjectId === 'sess-2:p1')).toBe(true);
    });

    it('clears the permission item on provider_request_resolved', () => {
      notifySessionEventHooks('sess-2', event('provider_request', { requestId: 'p1' }));
      notifySessionEventHooks('sess-2', event('provider_request_resolved', { requestId: 'p1' }, 2));
      expect(attention.list().items.filter((i) => i.kind === 'permission')).toHaveLength(0);
    });
  });

  describe('manual resolve suppresses re-raise until the condition clears (finding #2)', () => {
    it('a manually-resolved STILL-broken loop is NOT re-raised by the next sweep', async () => {
      fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
      await collectors.sweep();
      const item = attention.list().items.find((i) => i.subjectId === 'loop-1')!;
      attention.resolve(item.id); // founder override, loop still broken

      await collectors.sweep(); // loop still broken
      expect(attention.list().items.some((i) => i.subjectId === 'loop-1')).toBe(false);
    });

    it('resumed-then-re-broken IS a fresh item (new generation)', async () => {
      fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
      await collectors.sweep();
      const first = attention.list().items.find((i) => i.subjectId === 'loop-1')!;
      attention.resolve(first.id); // override while broken

      // Condition clears (loop resumed), then re-trips (broke again).
      fakeLoops.loops = [loop({ id: 'loop-1', status: 'active' })];
      await collectors.sweep();
      fakeLoops.loops = [loop({ id: 'loop-1', status: 'broken' })];
      await collectors.sweep();

      const open = attention.list().items.filter((i) => i.subjectId === 'loop-1');
      expect(open).toHaveLength(1); // a legitimately fresh item
      expect(open[0]!.id).not.toBe(first.id);
    });
  });

  describe('PR items clear when the PR closes / merges (finding #3)', () => {
    it('fetches and raises each forge PR once when multiple local paths share a repo', async () => {
      fakeRecent.paths = ['/repos/app', '/worktrees/app-feature'];
      fakeForge.identitiesByPath.set('/repos/app', 'github.com/octo/app');
      fakeForge.identitiesByPath.set('/worktrees/app-feature', 'github.com/octo/app');
      fakeForge.prsByPath.set('/repos/app', [{ number: 7, title: 'Add feature', url: 'u' }]);

      await collectors.sweep();

      expect(fakeForge.listCalls).toEqual(['/repos/app']);
      const items = attention.list().items.filter((item) => item.kind === 'pr-review');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        subjectId: 'github.com/octo/app#7',
        projectPath: '/repos/app',
        payload: { projectPath: '/repos/app', number: 7, url: 'u' },
      });
    });

    it('keeps same-named repositories on different forge hosts distinct', async () => {
      fakeRecent.paths = ['/repos/github-app', '/repos/gitlab-app'];
      fakeForge.identitiesByPath.set('/repos/github-app', 'github.com/octo/app');
      fakeForge.identitiesByPath.set('/repos/gitlab-app', 'gitlab.com/octo/app');
      fakeForge.prsByPath.set('/repos/github-app', [{ number: 7, title: 'GitHub PR', url: 'gh' }]);
      fakeForge.prsByPath.set('/repos/gitlab-app', [{ number: 7, title: 'GitLab MR', url: 'gl' }]);

      await collectors.sweep();

      expect(fakeForge.listCalls).toEqual(['/repos/github-app', '/repos/gitlab-app']);
      expect(attention.list().items.map((item) => item.subjectId).sort()).toEqual([
        'github.com/octo/app#7',
        'gitlab.com/octo/app#7',
      ]);
    });

    it('a PR that is no longer open auto-resolves its item on the next sweep', async () => {
      fakeRecent.paths = ['/repos/x'];
      fakeForge.identitiesByPath.set('/repos/x', 'github.com/octo/x');
      fakeForge.prsByPath.set('/repos/x', [{ number: 7, title: 'Add feature', url: 'u' }]);
      await collectors.sweep();
      expect(attention.list().items.some((i) => i.subjectId === 'github.com/octo/x#7')).toBe(true);

      // PR #7 merged → no longer in the open set.
      fakeForge.prsByPath.set('/repos/x', []);
      await collectors.sweep();
      expect(attention.list().items.some((i) => i.subjectId === 'github.com/octo/x#7')).toBe(false);
    });

    it("one repo's fetch failure does not clear another repo's items", async () => {
      fakeRecent.paths = ['/repos/x', '/repos/y'];
      fakeForge.identitiesByPath.set('/repos/x', 'github.com/octo/x');
      fakeForge.identitiesByPath.set('/repos/y', 'github.com/octo/y');
      fakeForge.prsByPath.set('/repos/x', [{ number: 7, title: 'PR X', url: 'ux' }]);
      fakeForge.prsByPath.set('/repos/y', [{ number: 8, title: 'PR Y', url: 'uy' }]);
      await collectors.sweep();
      expect(attention.list().items.map((i) => i.subjectId).sort()).toEqual([
        'github.com/octo/x#7',
        'github.com/octo/y#8',
      ]);

      fakeForge.unreachablePaths.add('/repos/x');
      fakeForge.prsByPath.set('/repos/y', []);
      await collectors.sweep();
      expect(attention.list().items.map((i) => i.subjectId)).toEqual(['github.com/octo/x#7']);
    });

    it('clears legacy local-path keys even when the alias fell out of recent projects', async () => {
      fakeRecent.paths = ['/repos/x'];
      fakeForge.identitiesByPath.set('/repos/x', 'github.com/octo/x');
      fakeForge.identitiesByPath.set('/worktrees/x-feature', 'github.com/octo/x');
      fakeForge.prsByPath.set('/repos/x', [{ number: 7, title: 'PR X', url: 'u' }]);
      attention.raise({
        kind: 'pr-review',
        subjectId: '/worktrees/x-feature#7',
        projectPath: '/worktrees/x-feature',
        title: 'PR X',
        payload: {
          projectPath: '/worktrees/x-feature',
          number: 7,
          url: 'https://github.com/octo/x/pull/7',
        },
      });

      await collectors.sweep();

      expect(attention.list().items.map((item) => item.subjectId)).toEqual(['github.com/octo/x#7']);
    });

    it('preserves a legacy path key when the checkout now points at a different repository', async () => {
      fakeRecent.paths = ['/repos/app'];
      fakeForge.identitiesByPath.set('/repos/app', 'github.com/new-owner/app');
      fakeForge.prsByPath.set('/repos/app', []);
      attention.raise({
        kind: 'pr-review',
        subjectId: '/repos/app#7',
        projectPath: '/repos/app',
        title: 'Old repository PR',
        payload: {
          projectPath: '/repos/app',
          number: 7,
          url: 'https://github.com/old-owner/app/pull/7',
        },
      });

      await collectors.sweep();

      expect(attention.list().items.map((item) => item.subjectId)).toEqual(['/repos/app#7']);
    });

    it('does not treat a hostless repo payload as proof across forge hosts', async () => {
      fakeRecent.paths = ['/repos/app'];
      fakeForge.identitiesByPath.set('/repos/app', 'gitlab.com/octo/app');
      fakeForge.prsByPath.set('/repos/app', []);
      attention.raise({
        kind: 'pr-review',
        subjectId: '/repos/app#7',
        projectPath: '/repos/app',
        title: 'GitHub PR from the previous checkout',
        payload: { repo: 'octo/app', number: 7 },
      });

      await collectors.sweep();

      expect(attention.list().items.map((item) => item.subjectId)).toEqual(['/repos/app#7']);
    });

    it('preserves malformed legacy subject ids even when their payload repository matches', async () => {
      fakeRecent.paths = ['/repos/app'];
      fakeForge.identitiesByPath.set('/repos/app', 'github.com/octo/app');
      fakeForge.prsByPath.set('/repos/app', []);
      attention.raise({
        kind: 'pr-review',
        subjectId: '/repos/app#not-a-pr',
        projectPath: '/repos/app',
        title: 'Malformed legacy row',
        payload: { repo: 'github.com/octo/app' },
      });

      await collectors.sweep();

      expect(attention.list().items.map((item) => item.subjectId)).toEqual([
        '/repos/app#not-a-pr',
      ]);
    });

    it('preserves a matching legacy key when that repository fetch fails', async () => {
      fakeRecent.paths = ['/repos/app'];
      fakeForge.identitiesByPath.set('/repos/app', 'github.com/octo/app');
      fakeForge.unreachablePaths.add('/repos/app');
      attention.raise({
        kind: 'pr-review',
        subjectId: '/repos/app#7',
        projectPath: '/repos/app',
        title: 'PR awaiting review',
        payload: { repo: 'github.com/octo/app', number: 7 },
      });

      await collectors.sweep();

      expect(attention.list().items.map((item) => item.subjectId)).toEqual(['/repos/app#7']);
    });

    it('deduplicates case-variant repository identities into one canonical fetch and item', async () => {
      fakeRecent.paths = ['/repos/app', '/worktrees/app'];
      fakeForge.identitiesByPath.set('/repos/app', 'GitHub.com/Octo/App');
      fakeForge.identitiesByPath.set('/worktrees/app', 'github.com/octo/app');
      fakeForge.prsByPath.set('/repos/app', [{
        number: 7,
        title: 'Case-insensitive repo',
        url: 'https://github.com/octo/app/pull/7',
      }]);

      await collectors.sweep();

      expect(fakeForge.listCalls).toEqual(['/repos/app']);
      expect(attention.list().items.map((item) => item.subjectId)).toEqual([
        'github.com/octo/app#7',
      ]);
    });
  });
});
