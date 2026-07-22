import { describe, expect, it } from 'bun:test';
import { OrchestrationToolsService } from '../../../src/orchestration/tools/orchestration-tools.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';

function makeSession(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'parent',
    title: 'parent',
    status: 'IDLE',
    provider: 'pi',
    model: 'pi:default',
    modelOptions: null,
    mode: null,
    workspace: '/repo',
    prompt: 'p',
    preview: null,
    projectPath: '/repo',
    baseBranch: 'main',
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    parentSessionId: null,
    originTaskId: null,
    priorSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('OrchestrationToolsService', () => {
  function serviceFor(mode = 'read-write', factRecording: 'on' | 'off' = 'off') {
    const enqueueCalls: unknown[] = [];
    const upsertCalls: unknown[] = [];
    const sessionsRepo = {
      listUserFacing: () => [makeSession()],
      findUserFacingById: (id: string) => (id === 'parent' ? makeSession() : null),
      childrenOf: () => [],
    };
    const events = { listSince: () => [] };
    const tasksRepo = {
      list: () => [],
      listByParentSession: () => [],
      findUserFacingById: () => null,
    };
    const settings = {
      resolve: (key: string) => {
        if (key === 'NUNCIO_ORCHESTRATION_TOOLS') return mode;
        if (key === 'NUNCIO_FACT_RECORDING') return factRecording;
        if (key === 'NUNCIO_SUBAGENT_PROVIDER') return 'pi';
        if (key === 'NUNCIO_SUBAGENT_MODEL') return 'pi:child';
        if (key === 'NUNCIO_VERIFY_COMMAND') return 'bun test';
        if (key === 'NUNCIO_ENGINE_ROUTING') return undefined;
        return undefined;
      },
    };
    const agents = { available: async () => [{ id: 'pi' }] };
    const contextFacts = {
      list: () => [],
      upsert: (input: unknown) => {
        upsertCalls.push(input);
        return { written: true };
      },
    };
    const profiles = {
      resolve: () => ({ sections: { toolsPreamble: 'Use orchestration tools carefully.' } }),
    };
    const enqueuer = {
      enqueue: (input: unknown) => {
        enqueueCalls.push(input);
        return { id: 'task-1', status: 'QUEUED' };
      },
    };

    const service = new OrchestrationToolsService(
      sessionsRepo as never,
      events as never,
      tasksRepo as never,
      enqueuer as never,
      settings as never,
      agents as never,
      contextFacts as never,
      profiles as never,
    );
    return { service, enqueueCalls, upsertCalls };
  }

  it('returns no tools when orchestration mode is off and fact recording is off', () => {
    const { service } = serviceFor('off', 'off');
    expect(service.forScope({ sessionId: 'parent', projectPath: '/repo' })).toEqual({ tools: [] });
  });

  it('mode off + fact recording on → only the record-fact tool', () => {
    const { service } = serviceFor('off', 'on');
    const runtime = service.forScope({ sessionId: 'parent', projectPath: '/repo' });
    expect(runtime.tools.map((tool) => tool.name)).toEqual(['nuncio_record_project_fact']);
    expect(runtime.systemPromptAppend).toContain('nuncio_record_project_fact');
  });

  it('builds orchestration tools when mode is read-write', () => {
    const { service } = serviceFor('read-write');
    const runtime = service.forScope({
      sessionId: 'parent',
      projectPath: '/repo',
      provider: 'pi',
      model: 'pi:default',
    });
    expect(runtime.tools.length).toBeGreaterThan(0);
    expect(runtime.tools.map((tool) => tool.name)).toContain('nuncio_list_sessions');
    // The profile preamble replaces the fleet-tools default; the fact-recording
    // nudge (read-write always carries the record tool) is appended after it.
    expect(runtime.systemPromptAppend).toStartWith('Use orchestration tools carefully.');
    expect(runtime.systemPromptAppend).toContain('nuncio_record_project_fact');
  });

  it('wires enqueueTask through the injected enqueuer', async () => {
    const { service, enqueueCalls } = serviceFor('read-write');
    const runtime = service.forScope({ sessionId: 'parent', projectPath: '/repo' });
    const enqueue = runtime.tools.find((tool) => tool.name === 'nuncio_enqueue_task');
    expect(enqueue).toBeDefined();
    await enqueue!.execute({ prompt: 'do work', brief: { goal: 'ship it' } });
    expect(enqueueCalls.length).toBe(1);
  });

  it('records project facts through ContextFactsService', async () => {
    const { service, upsertCalls } = serviceFor('read-write');
    const runtime = service.forScope({ sessionId: 'parent', projectPath: '/repo' });
    const record = runtime.tools.find((tool) => tool.name === 'nuncio_record_project_fact');
    expect(record).toBeDefined();
    const result = await record!.execute({ key: 'stack', value: 'bun' });
    expect(upsertCalls.length).toBe(1);
    expect(result).toMatchObject({
      structuredContent: { status: 'written', key: 'stack' },
    });
  });
});
