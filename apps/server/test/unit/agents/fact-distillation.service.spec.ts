import { FactDistillationService } from '../../../src/agents/fact-distillation.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

function statusIdle(): SessionEvent {
  return { seq: 99, type: 'status', payload: { status: 'IDLE' }, createdAt: Date.now() };
}

function substantiveEvents(count: number): SessionEvent[] {
  const events: SessionEvent[] = [{ seq: 1, type: 'user_message', payload: { text: 'do the task' }, createdAt: 1 }];
  for (let i = 0; i < count; i++) {
    events.push({ seq: i + 2, type: 'tool_start', payload: { tool: 'bash' }, createdAt: i + 2 });
  }
  events.push({ seq: count + 2, type: 'assistant_message', payload: { text: 'done' }, createdAt: count + 2 });
  return events;
}

function makeHarness(over: {
  completeText?: string;
  session?: Record<string, unknown> | null;
  events?: SessionEvent[];
  distillation?: 'on' | 'off';
  completeOneShot?: (() => Promise<string>) | null;
} = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const completions: Array<Record<string, unknown>> = [];
  const session = over.session === null ? null : {
    id: 's1',
    projectPath: '/repo',
    workspace: '/repo',
    worktreePath: null,
    runtimePolicy: null,
    verifyOwner: 'session',
    provider: 'cursor',
    model: null,
    ...over.session,
  };
  const provider = {
    id: 'pi',
    isAvailable: async () => true,
    completeOneShot:
      over.completeOneShot === null
        ? undefined
        : over.completeOneShot ??
          (async (input: Record<string, unknown>) => {
            completions.push(input);
            return over.completeText ?? '[{"key":"build-command","value":"use bun test"}]';
          }),
  };
  const service = new FactDistillationService(
    { findById: () => session } as never,
    { listSince: () => over.events ?? substantiveEvents(6) } as never,
    {
      upsert: (input: Record<string, unknown>) => {
        upserts.push(input);
        return { written: true, proposed: false, replacedProposal: false, fact: null, proposalId: null };
      },
      listPinnedFirst: () => [],
    } as never,
    { available: async () => [provider] } as never,
    {
      resolve: (key: string) => {
        if (key === 'NUNCIO_FACT_DISTILLATION') return over.distillation ?? 'on';
        if (key === 'NUNCIO_FACT_DISTILLATION_MODEL') return 'cliproxyapi:claude-sonnet-5';
        return undefined;
      },
    } as never,
  );
  return { service, upserts, completions };
}

describe('FactDistillationService', () => {
  it('distills durable facts when a substantive run settles to IDLE', async () => {
    const { service, upserts, completions } = makeHarness();
    await service.handleEvent('s1', statusIdle());
    expect(completions).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      projectPath: '/repo',
      key: 'build-command',
      value: 'use bun test',
      provenance: 'agent',
      sourceSessionId: 's1',
    });
  });

  it('ignores non-IDLE status events and non-status events', async () => {
    const { service, completions } = makeHarness();
    await service.handleEvent('s1', { seq: 1, type: 'status', payload: { status: 'RUNNING' }, createdAt: 1 });
    await service.handleEvent('s1', { seq: 2, type: 'assistant_message', payload: { text: 'x' }, createdAt: 2 });
    expect(completions).toHaveLength(0);
  });

  it('the kill-switch disables distillation entirely', async () => {
    const { service, completions } = makeHarness({ distillation: 'off' });
    await service.handleEvent('s1', statusIdle());
    expect(completions).toHaveLength(0);
  });

  it('skips sessions without a project, policy sessions, and crew-owned sessions', async () => {
    for (const session of [
      { projectPath: null },
      { runtimePolicy: { filesystem: 'workspace-write', network: 'disabled', workspaceRoot: '/repo' } },
      { verifyOwner: 'crew' },
    ]) {
      const { service, completions } = makeHarness({ session });
      await service.handleEvent('s1', statusIdle());
      expect(completions).toHaveLength(0);
    }
  });

  it('skips a short run below the substantive-events threshold', async () => {
    const { service, completions } = makeHarness({ events: substantiveEvents(1) });
    await service.handleEvent('s1', statusIdle());
    expect(completions).toHaveLength(0);
  });

  it('malformed model output writes nothing and does not throw', async () => {
    const { service, upserts } = makeHarness({ completeText: 'sorry, no JSON here' });
    await service.handleEvent('s1', statusIdle());
    expect(upserts).toHaveLength(0);
  });

  it('caps writes at 3 facts and drops invalid entries', async () => {
    const { service, upserts } = makeHarness({
      completeText: JSON.stringify([
        { key: 'one', value: 'v1' },
        { key: 'Bad Key!', value: 'skipped' },
        { key: 'two', value: 'v2' },
        { key: 'three', value: 'v3' },
        { key: 'four', value: 'v4' },
      ]),
    });
    await service.handleEvent('s1', statusIdle());
    expect(upserts.map((u) => u.key)).toEqual(['one', 'two', 'three']);
  });

  it('a cooldown prevents back-to-back distillations of the same session', async () => {
    const { service, completions } = makeHarness();
    await service.handleEvent('s1', statusIdle());
    await service.handleEvent('s1', statusIdle());
    expect(completions).toHaveLength(1);
  });

  it('no available provider supports one-shot completions → silent skip', async () => {
    const { service, upserts } = makeHarness({ completeOneShot: null });
    await service.handleEvent('s1', statusIdle());
    expect(upserts).toHaveLength(0);
  });
});
