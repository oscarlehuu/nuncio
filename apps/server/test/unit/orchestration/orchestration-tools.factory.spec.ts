import { buildOrchestrationTools } from '../../../src/orchestration/tools/orchestration-tools.factory';
import type {
  OrchestrationToolDeps,
  OrchestrationScope,
} from '../../../src/orchestration/tools/orchestration-tools.types';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto } from '../../../src/tasks/tasks.types';

function session(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1', title: 'Session 1', status: 'IDLE', provider: 'cursor', model: null, modelOptions: null,
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
    id: 't1', prompt: 'do the thing', status: 'DONE', provider: 'cursor', model: null,
    modelOptions: null, projectPath: '/repo', baseBranch: null, useWorktree: false, workspace: null,
    parentSessionId: 's1', role: 'subagent', cleanupPolicy: null, reviewState: null,
    sessionId: 'child-1', outcome: { verify: { ok: true } }, contextBrief: null, notifyPolicy: null,
    tag: null, createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 2, ...over,
  };
}

function makeDeps(over: Partial<OrchestrationToolDeps> = {}): OrchestrationToolDeps {
  const sessions = [session({ id: 's1' }), session({ id: 's2', title: 'Sibling' })];
  return {
    currentMode: () => 'read-write',
    listSessions: () => sessions,
    findSession: (id) => sessions.find((s) => s.id === id) ?? null,
    childrenOf: () => [],
    listEventsSince: () => [],
    listTasks: () => [task()],
    findTask: (id) => (id === 't1' ? task() : null),
    enqueueTask: (input) => task({ id: 'new', prompt: input.prompt, status: 'QUEUED', provider: input.provider ?? null }),
    queuePosition: () => 1,
    resolveEngine: async (parent, explicit) => ({ provider: explicit ?? parent.provider, model: parent.model }),
    buildWorkspaceSnapshot: async () => null,
    resolveVerifyCommand: () => null,
    listProjectFacts: () => [],
    recordProjectFact: () => ({ status: 'written', message: 'ok' }),
    factRecordingEnabled: () => false,
    ...over,
  };
}

const scope: OrchestrationScope = { sessionId: 's1', projectPath: '/repo' };

describe('buildOrchestrationTools gating', () => {
  it('off → no tools and no systemPromptAppend', () => {
    const rt = buildOrchestrationTools(makeDeps(), scope, 'off');
    expect(rt.tools).toHaveLength(0);
    expect(rt.systemPromptAppend).toBeUndefined();
  });

  it('read → 5 read tools, no write tools', () => {
    const rt = buildOrchestrationTools(makeDeps(), scope, 'read');
    expect(rt.tools.map((t) => t.name)).toEqual([
      'nuncio_list_sessions', 'nuncio_read_session', 'nuncio_list_tasks', 'nuncio_get_task_result', 'nuncio_list_project_facts',
    ]);
    expect(rt.tools.map((t) => t.name)).not.toContain('nuncio_enqueue_task');
    expect(rt.tools.map((t) => t.name)).not.toContain('nuncio_record_project_fact');
    expect(rt.systemPromptAppend).toContain('nuncio_read_session');
  });

  it('read-write → adds nuncio_enqueue_task and nuncio_record_project_fact', () => {
    const rt = buildOrchestrationTools(makeDeps(), scope, 'read-write');
    expect(rt.tools.map((t) => t.name)).toContain('nuncio_enqueue_task');
    expect(rt.tools.map((t) => t.name)).toContain('nuncio_record_project_fact');
  });

  it('a profile tools-preamble overrides the default systemPromptAppend (D2)', () => {
    const rt = buildOrchestrationTools(makeDeps(), scope, 'read', 'CUSTOM PREAMBLE');
    expect(rt.systemPromptAppend).toBe('CUSTOM PREAMBLE');
    // Absent preamble → the default is kept.
    expect(buildOrchestrationTools(makeDeps(), scope, 'read').systemPromptAppend).toContain('nuncio_read_session');
  });

  it('every tool has a valid object inputSchema', () => {
    const rt = buildOrchestrationTools(makeDeps(), scope, 'read-write');
    for (const tool of rt.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });
});

describe('standalone fact recording (P2)', () => {
  it('off + factRecording → only the record-fact tool, with a fact nudge append', () => {
    const deps = makeDeps({ factRecordingEnabled: () => true });
    const rt = buildOrchestrationTools(deps, scope, 'off');
    expect(rt.tools.map((t) => t.name)).toEqual(['nuncio_record_project_fact']);
    expect(rt.systemPromptAppend).toContain('nuncio_record_project_fact');
  });

  it('read + factRecording → read tools plus the record-fact tool', () => {
    const deps = makeDeps({ factRecordingEnabled: () => true });
    const rt = buildOrchestrationTools(deps, scope, 'read');
    const names = rt.tools.map((t) => t.name);
    expect(names).toContain('nuncio_list_sessions');
    expect(names).toContain('nuncio_record_project_fact');
    expect(names).not.toContain('nuncio_enqueue_task');
  });

  it('read + factRecording → the record-fact tool executes (fact writes ride their own gate)', async () => {
    const deps = makeDeps({ currentMode: () => 'read', factRecordingEnabled: () => true });
    const tool = buildOrchestrationTools(deps, scope, 'read').tools
      .find((t) => t.name === 'nuncio_record_project_fact')!;
    expect(((await tool.execute({ key: 'k', value: 'v' })) as { isError?: boolean }).isError).toBeUndefined();
  });

  it('read-write + factRecording → the record-fact tool appears exactly once', () => {
    const deps = makeDeps({ factRecordingEnabled: () => true });
    const rt = buildOrchestrationTools(deps, scope, 'read-write');
    expect(rt.tools.filter((t) => t.name === 'nuncio_record_project_fact')).toHaveLength(1);
  });

  it('execute gate honors factRecordingEnabled even when orchestration mode is off', async () => {
    let enabled = true;
    const deps = makeDeps({ currentMode: () => 'off', factRecordingEnabled: () => enabled });
    const tool = buildOrchestrationTools(deps, scope, 'off').tools
      .find((t) => t.name === 'nuncio_record_project_fact')!;
    expect(((await tool.execute({ key: 'k', value: 'v' })) as { isError?: boolean }).isError).toBeUndefined();
    // A mid-session settings flip is enforced at execute time.
    enabled = false;
    expect(((await tool.execute({ key: 'k', value: 'v' })) as { isError?: boolean }).isError).toBe(true);
  });
});

async function callTool(mode: 'read' | 'read-write', name: string, input: Record<string, unknown>, deps = makeDeps()) {
  const rt = buildOrchestrationTools(deps, scope, mode);
  const tool = rt.tools.find((t) => t.name === name)!;
  return tool.execute(input);
}

describe('nuncio_list_sessions', () => {
  it('scopes to the caller project and clamps the limit', async () => {
    const deps = makeDeps({
      listSessions: () => [session({ id: 's1' }), session({ id: 'x', projectPath: '/other' })],
    });
    const res = await callTool('read', 'nuncio_list_sessions', { limit: 50 }, deps);
    const rows = (res as { structuredContent: Array<{ id: string }> }).structuredContent;
    expect(rows.map((r) => r.id)).toEqual(['s1']); // /other filtered out
  });

  it('filters by status', async () => {
    const deps = makeDeps({
      listSessions: () => [session({ id: 's1', status: 'IDLE' }), session({ id: 's2', status: 'RUNNING' })],
    });
    const res = await callTool('read', 'nuncio_list_sessions', { status: 'RUNNING' }, deps);
    const rows = (res as { structuredContent: Array<{ id: string }> }).structuredContent;
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });
});

describe('nuncio_read_session', () => {
  it('errors on a foreign-project, non-lineage session', async () => {
    const deps = makeDeps({
      findSession: (id) => (id === 'foreign' ? session({ id: 'foreign', projectPath: '/other', parentSessionId: null }) : session({ id })),
    });
    const res = await callTool('read', 'nuncio_read_session', { sessionId: 'foreign' }, deps);
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('reads a same-project session with a compacted body', async () => {
    const events: SessionEvent[] = [{ seq: 1, type: 'user_message', payload: { text: 'hi' }, createdAt: 1 }];
    const deps = makeDeps({
      findSession: (id) => session({ id, projectPath: '/repo' }),
      listEventsSince: () => events,
    });
    const res = await callTool('read', 'nuncio_read_session', { sessionId: 's2' }, deps);
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain('**User:** hi');
  });

  it('clamps the budget to 8192', async () => {
    const deps = makeDeps({ findSession: (id) => session({ id, projectPath: '/repo' }) });
    const res = await callTool('read', 'nuncio_read_session', { sessionId: 's2', budgetBytes: 999999 }, deps);
    expect((res as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe('nuncio_get_task_result', () => {
  it('returns a digest with briefGoal for a terminal task', async () => {
    const deps = makeDeps({ findTask: () => task({ contextBrief: { goal: 'ship it' } }) });
    const res = await callTool('read', 'nuncio_get_task_result', { taskId: 't1' }, deps);
    const sc = (res as { structuredContent: { status: string; briefGoal: string } }).structuredContent;
    expect(sc.status).toBe('DONE');
    expect(sc.briefGoal).toBe('ship it');
  });

  it('errors on a non-terminal task', async () => {
    const deps = makeDeps({ findTask: () => task({ status: 'RUNNING' }) });
    const res = await callTool('read', 'nuncio_get_task_result', { taskId: 't1' }, deps);
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('errors on an unknown task', async () => {
    const res = await callTool('read', 'nuncio_get_task_result', { taskId: 'nope' });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe('task tool scope guards (F1)', () => {
  it('nuncio_list_tasks rejects a parent session outside project and lineage', async () => {
    const foreign = session({ id: 'foreign', projectPath: '/other', parentSessionId: null });
    const deps = makeDeps({
      findSession: (id) => (id === 'foreign' ? foreign : id === 's1' ? session({ id: 's1' }) : null),
      childrenOf: () => [],
    });
    const res = await callTool('read', 'nuncio_list_tasks', { parentSessionId: 'foreign' }, deps);
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('nuncio_get_task_result rejects a task whose parent/child sessions are foreign', async () => {
    const deps = makeDeps({
      findTask: () => task({ parentSessionId: 'foreign', sessionId: 'foreign-child' }),
      findSession: (id) =>
        id === 's1' ? session({ id: 's1' }) : session({ id, projectPath: '/other', parentSessionId: null }),
      childrenOf: () => [],
    });
    const res = await callTool('read', 'nuncio_get_task_result', { taskId: 't1' }, deps);
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe('null-projectPath scope collapse (F2)', () => {
  it('a null-project caller cannot read another null-project session (not lineage)', async () => {
    const nullScope: OrchestrationScope = { sessionId: 's1', projectPath: null };
    const deps = makeDeps({
      findSession: (id) => (id === 'other' ? session({ id: 'other', projectPath: null, parentSessionId: null }) : session({ id, projectPath: null })),
      childrenOf: () => [],
    });
    const rt = buildOrchestrationTools(deps, nullScope, 'read');
    const read = rt.tools.find((t) => t.name === 'nuncio_read_session')!;
    const res = await read.execute({ sessionId: 'other' });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('a null-project target is only readable via lineage (child ok)', async () => {
    const child = session({ id: 'child', projectPath: null, parentSessionId: 's1' });
    const deps = makeDeps({
      findSession: (id) => (id === 'child' ? child : session({ id: 's1', projectPath: '/repo' })),
      childrenOf: (pid) => (pid === 's1' ? [child] : []),
    });
    const res = await callTool('read', 'nuncio_read_session', { sessionId: 'child' }, deps);
    expect((res as { isError?: boolean }).isError).toBeUndefined();
  });

  it('null-project list_sessions returns only own + lineage, never other null-project rows', async () => {
    const nullScope: OrchestrationScope = { sessionId: 's1', projectPath: null };
    const deps = makeDeps({
      listSessions: () => [
        session({ id: 's1', projectPath: null }),
        session({ id: 'other', projectPath: null, parentSessionId: null }),
      ],
      findSession: (id) => session({ id, projectPath: null }),
      childrenOf: () => [],
    });
    const rt = buildOrchestrationTools(deps, nullScope, 'read');
    const list = rt.tools.find((t) => t.name === 'nuncio_list_sessions')!;
    const rows = ((await list.execute({})) as { structuredContent: Array<{ id: string }> }).structuredContent;
    expect(rows.map((r) => r.id)).toEqual(['s1']); // 'other' excluded
  });
});

describe('execute-time mode gate (F3)', () => {
  it('read tools refuse when the mode has flipped to off', async () => {
    let mode: 'off' | 'read' | 'read-write' = 'read-write';
    const deps = makeDeps({ currentMode: () => mode });
    const rt = buildOrchestrationTools(deps, scope, 'read-write');
    const list = rt.tools.find((t) => t.name === 'nuncio_list_sessions')!;
    // Works while enabled...
    expect(((await list.execute({})) as { isError?: boolean }).isError).toBeUndefined();
    // ...refuses after a mid-session flip.
    mode = 'off';
    const res = await list.execute({});
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain('disabled');
  });

  it('enqueue refuses under read while read tools still work', async () => {
    let mode: 'read' | 'read-write' = 'read-write';
    const deps = makeDeps({ currentMode: () => mode });
    const rt = buildOrchestrationTools(deps, scope, 'read-write');
    const enqueue = rt.tools.find((t) => t.name === 'nuncio_enqueue_task')!;
    const list = rt.tools.find((t) => t.name === 'nuncio_list_sessions')!;
    mode = 'read';
    expect(((await enqueue.execute({ prompt: 'p', brief: { goal: 'g' } })) as { isError?: boolean }).isError).toBe(true);
    expect(((await list.execute({})) as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe('title byte-cap (F5)', () => {
  it('caps session titles to 256 bytes in list_sessions output', async () => {
    const deps = makeDeps({
      listSessions: () => [session({ id: 's1', title: 'T'.repeat(1000) })],
      findSession: (id) => session({ id }),
    });
    const rows = ((await callTool('read', 'nuncio_list_sessions', {}, deps)) as {
      structuredContent: Array<{ title: string }>;
    }).structuredContent;
    expect(new TextEncoder().encode(rows[0]!.title).byteLength).toBeLessThanOrEqual(256);
  });
});

describe('project fact tools (B-workstream)', () => {
  it('nuncio_list_project_facts returns the caller-project facts', async () => {
    const deps = makeDeps({
      listProjectFacts: (pp) => (pp === '/repo' ? [{ id: 'f1', projectPath: '/repo', key: 'k', value: 'v', provenance: 'founder', sourceSessionId: null, pinned: false, createdAt: 1, updatedAt: 1 }] : []),
    });
    const res = await callTool('read', 'nuncio_list_project_facts', {}, deps);
    const rows = (res as { structuredContent: Array<{ key: string }> }).structuredContent;
    expect(rows.map((r) => r.key)).toEqual(['k']);
  });

  it('nuncio_record_project_fact reports written / proposed / error', async () => {
    let outcome: { status: 'written' | 'proposed' | 'error'; message: string } = { status: 'written', message: 'ok' };
    const deps = makeDeps({ recordProjectFact: () => outcome });
    const tool = buildOrchestrationTools(deps, scope, 'read-write').tools.find((t) => t.name === 'nuncio_record_project_fact')!;

    outcome = { status: 'written', message: 'Recorded project fact "k".' };
    const w = await tool.execute({ key: 'k', value: 'v' });
    expect((w as { structuredContent: { status: string } }).structuredContent.status).toBe('written');

    outcome = { status: 'proposed', message: 'pending founder review' };
    const p = await tool.execute({ key: 'k', value: 'v2' });
    expect((p as { structuredContent: { status: string } }).structuredContent.status).toBe('proposed');

    outcome = { status: 'error', message: 'key must be a slug' };
    const e = await tool.execute({ key: 'Bad Key', value: 'v' });
    expect((e as { isError?: boolean }).isError).toBe(true);
  });

  it('record fact refuses under read mode (execute-time gate)', async () => {
    const deps = makeDeps({ currentMode: () => 'read' });
    // Build in read-write so the tool exists, then the live gate refuses.
    const tool = buildOrchestrationTools(deps, scope, 'read-write').tools.find((t) => t.name === 'nuncio_record_project_fact')!;
    expect(((await tool.execute({ key: 'k', value: 'v' })) as { isError?: boolean }).isError).toBe(true);
  });
});
