import { buildEnqueueTool } from '../../../src/orchestration/tools/orchestration-enqueue-tool';
import type {
  OrchestrationToolDeps,
  OrchestrationScope,
} from '../../../src/orchestration/tools/orchestration-tools.types';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import type { CreateTaskDto, TaskDto } from '../../../src/tasks/tasks.types';

function session(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1', title: 'S', status: 'IDLE', provider: 'cursor', model: 'cursor:m', modelOptions: null,
    workspace: '/repo', prompt: 'p', preview: null, projectPath: '/repo', baseBranch: 'main',
    worktreePath: null, branch: 'main', providerThreadId: null, providerActiveTurnId: null,
    providerState: null, cursorBackend: null, cursorChatId: null, supportsInteraction: false,
    supportsInterrupt: false, supportsSteerWhileRunning: false, supportsImages: false,
    pendingInput: false, parentSessionId: null, originTaskId: null, priorSessionId: null,
    createdAt: 1, updatedAt: 2, ...over,
  } as SessionDto;
}

function task(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't', prompt: 'p', status: 'QUEUED', provider: 'cursor', model: null, modelOptions: null,
    projectPath: '/repo', baseBranch: null, useWorktree: true, workspace: null, parentSessionId: 's1',
    role: 'subagent', cleanupPolicy: null, reviewState: null, sessionId: null, outcome: null,
    contextBrief: null, notifyPolicy: null, tag: null, createdAt: 1, updatedAt: 2, startedAt: null,
    finishedAt: null, ...over,
  };
}

const scope: OrchestrationScope = { sessionId: 's1', projectPath: '/repo' };

function makeDeps(over: Partial<OrchestrationToolDeps> = {}): {
  deps: OrchestrationToolDeps;
  created: CreateTaskDto[];
} {
  const created: CreateTaskDto[] = [];
  const sessions = [session({ id: 's1' })];
  const deps: OrchestrationToolDeps = {
    currentMode: () => 'read-write',
    listSessions: () => sessions,
    findSession: (id) => sessions.find((s) => s.id === id) ?? null,
    childrenOf: () => [],
    listEventsSince: () => [],
    listTasks: () => [],
    findTask: () => null,
    enqueueTask: (input) => {
      created.push(input);
      return task({
        id: 'new',
        prompt: input.prompt,
        provider: input.provider ?? null,
        model: input.model ?? null,
        contextBrief: input.contextBrief ?? null,
        tag: input.tag ?? null,
      });
    },
    queuePosition: () => 3,
    // Mirrors the shared resolution order: explicit > tag route > default.
    resolveEngine: async (parent, explicit, tag) => {
      if (explicit) return { provider: explicit, model: null };
      if (tag === 'review') return { provider: 'codex', model: 'codex:m' };
      return { provider: parent.provider, model: parent.model };
    },
    buildWorkspaceSnapshot: async () => ({ branch: 'main', headSha: 'abc', baseBranch: 'main', dirtyFiles: [], diffStat: null }),
    resolveVerifyCommand: () => 'bun run test',
    ...over,
  };
  return { deps, created };
}

describe('nuncio_enqueue_task', () => {
  it('merges the agent brief with nuncio ground truth and returns resolved engine', async () => {
    const { deps, created } = makeDeps();
    const tool = buildEnqueueTool(deps, scope);
    const res = await tool.execute({ prompt: 'write tests', brief: { goal: 'cover the parser', files: ['src/p.ts'] } });

    const input = created[0]!;
    expect(input.role).toBe('subagent');
    expect(input.parentSessionId).toBe('s1');
    expect(input.contextBrief?.goal).toBe('cover the parser');
    expect(input.contextBrief?.files).toEqual(['src/p.ts']);
    // nuncio ground truth merged in.
    expect(input.contextBrief?.workspace?.branch).toBe('main');
    expect(input.contextBrief?.verifyCommand).toBe('bun run test');
    const sc = (res as { structuredContent: { resolvedProvider: string; queuePosition: number } }).structuredContent;
    expect(sc.resolvedProvider).toBe('cursor');
    expect(sc.queuePosition).toBe(3);
  });

  it('honors an explicit provider override', async () => {
    const { deps, created } = makeDeps();
    await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' }, provider: 'codex' });
    expect(created[0]!.provider).toBe('codex');
  });

  it('routes by tag and persists the tag (C3): review → codex via resolveEngine', async () => {
    const { deps, created } = makeDeps(); // stub routes review → codex
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' }, tag: 'review' });
    expect(created[0]!.tag).toBe('review');
    expect(created[0]!.provider).toBe('codex'); // routed by tag
    const sc = (res as { structuredContent: { resolvedProvider: string } }).structuredContent;
    expect(sc.resolvedProvider).toBe('codex'); // output reflects the routed engine
  });

  it('explicit provider beats tag routing (resolution order)', async () => {
    const { deps, created } = makeDeps();
    await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' }, tag: 'review', provider: 'pi' });
    expect(created[0]!.provider).toBe('pi'); // explicit wins over the review→codex route
  });

  it('rejects an invalid tag', async () => {
    const { deps } = makeDeps();
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' }, tag: 'nonsense' });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('requires prompt and brief.goal', async () => {
    const { deps } = makeDeps();
    const tool = buildEnqueueTool(deps, scope);
    expect((await tool.execute({ brief: { goal: 'g' } }) as { isError?: boolean }).isError).toBe(true);
    expect((await tool.execute({ prompt: 'p', brief: {} }) as { isError?: boolean }).isError).toBe(true);
  });

  it('rejects when the child-to-be chain would reach depth 2', async () => {
    // caller s1 has a parent → caller chain 1 → child chain 2 → reject.
    const parent = session({ id: 'root' });
    const caller = session({ id: 's1', parentSessionId: 'root' });
    const { deps } = makeDeps({
      findSession: (id) => (id === 'root' ? parent : id === 's1' ? caller : null),
    });
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain('depth');
  });

  it('allows a root caller to delegate (child chain 1)', async () => {
    const { deps, created } = makeDeps(); // s1 has no parent
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' } });
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(created).toHaveLength(1);
  });

  it('rejects at the open-task cap (10 open subagents)', async () => {
    const openTasks = Array.from({ length: 10 }, (_, i) => task({ id: `o${i}`, status: 'QUEUED', role: 'subagent' }));
    const { deps } = makeDeps({ listTasks: () => openTasks });
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain('cap');
  });

  it('rejects oversized measured input including tag + provider (>16KB)', async () => {
    const { deps } = makeDeps();
    const res = await buildEnqueueTool(deps, scope).execute({
      prompt: 'x'.repeat(20000),
      brief: { goal: 'g' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('the cap holds under concurrent enqueues gated on a shared snapshot (F4 TOCTOU)', async () => {
    // 9 open tasks seeded; both calls await the SAME snapshot promise before the
    // cap re-check. Because the re-check + insert run synchronously after the
    // await, exactly one call inserts (reaching 10) and the other is rejected.
    const open: TaskDto[] = Array.from({ length: 9 }, (_, i) => task({ id: `o${i}`, status: 'QUEUED', role: 'subagent' }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, created } = makeDeps({
      // Live count: reflects tasks inserted so far in this test.
      listTasks: () => [...open, ...created.map((c, i) => task({ id: `new-${i}`, status: 'QUEUED', role: 'subagent', prompt: c.prompt }))],
      enqueueTask: (input) => {
        created.push(input);
        return task({ id: `new-${created.length - 1}`, prompt: input.prompt });
      },
      buildWorkspaceSnapshot: async () => {
        await gate;
        return null;
      },
    });
    const tool = buildEnqueueTool(deps, scope);

    const p1 = tool.execute({ prompt: 'a', brief: { goal: 'g' } });
    const p2 = tool.execute({ prompt: 'b', brief: { goal: 'g' } });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    const errors = [r1, r2].filter((r) => (r as { isError?: boolean }).isError).length;
    expect(errors).toBe(1); // exactly one rejected by the cap
    expect(created).toHaveLength(1); // exactly one inserted
    // The rejection is the cap, not something else.
    const rejected = [r1, r2].find((r) => (r as { isError?: boolean }).isError)!;
    expect((rejected as { content: Array<{ text: string }> }).content[0].text).toContain('cap');
  });

  it('survives a workspace-snapshot failure (best-effort, still enqueues)', async () => {
    const { deps, created } = makeDeps({
      buildWorkspaceSnapshot: async () => {
        throw new Error('git blew up');
      },
    });
    const res = await buildEnqueueTool(deps, scope).execute({ prompt: 'p', brief: { goal: 'g' } });
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(created[0]!.contextBrief?.workspace).toBeUndefined();
  });
});
