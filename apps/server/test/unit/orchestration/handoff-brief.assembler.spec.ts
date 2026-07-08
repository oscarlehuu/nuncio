import { assembleSubagentBrief } from '../../../src/orchestration/handoff-brief.assembler';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

function parent(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'parent-1',
    title: 'Parent',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    workspace: '/repo',
    prompt: 'Refactor the auth module for clarity',
    preview: null,
    projectPath: '/repo',
    baseBranch: 'main',
    worktreePath: null,
    branch: 'main',
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    ...overrides,
  } as SessionDto;
}

function toolStart(file: string, seq: number): SessionEvent {
  return { seq, type: 'tool_start', payload: { tool: 'Edit', input: { file_path: file } }, createdAt: seq };
}

describe('assembleSubagentBrief', () => {
  it('sets goal from the subagent prompt and records the parent objective as a decision', () => {
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'Write tests for the token refresh path',
      parentTailEvents: [],
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.goal).toBe('Write tests for the token refresh path');
    expect(brief.decisions).toContain('Parent objective: Refactor the auth module for clarity');
  });

  it('truncates goal and parent objective to 200 chars', () => {
    const longPrompt = 'a'.repeat(400);
    const brief = assembleSubagentBrief({
      parent: parent({ prompt: 'b'.repeat(400) }),
      subagentPrompt: longPrompt,
      parentTailEvents: [],
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.goal).toHaveLength(200);
    expect(brief.decisions?.[0]).toBe(`Parent objective: ${'b'.repeat(200)}`);
  });

  it('harvests repo-relative file paths from tool events, deduped, keeping last-touch order', () => {
    const events: SessionEvent[] = [
      toolStart('/repo/src/a.ts', 1),
      toolStart('/repo/src/b.ts', 2),
      toolStart('/repo/src/a.ts', 3),
      { seq: 4, type: 'tool_start', payload: { tool: 'Read', input: { path: '/repo/src/c.ts' } }, createdAt: 4 },
      { seq: 5, type: 'tool_start', payload: { tool: 'Bash', input: { cwd: '/repo/scripts' } }, createdAt: 5 },
    ];
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: null,
      verifyCommand: null,
    });
    // last-touch order, deduped, project-relative
    expect(brief.files).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts', 'scripts']);
  });

  it('caps files at 10', () => {
    const events = Array.from({ length: 15 }, (_, i) => toolStart(`/repo/f${i}.ts`, i + 1));
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.files).toHaveLength(10);
  });

  it('drops absolute paths outside the project root', () => {
    const events: SessionEvent[] = [
      toolStart('/repo/src/keep.ts', 1),
      toolStart('/etc/passwd', 2),
      toolStart('/other/project/x.ts', 3),
    ];
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.files).toEqual(['src/keep.ts']);
  });

  it('drops paths that escape the project root via traversal', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_start', payload: { tool: 'Read', input: { path: '/repo/src/keep.ts' } }, createdAt: 1 },
      { seq: 2, type: 'tool_start', payload: { tool: 'Read', input: { path: '../secrets/token.txt' } }, createdAt: 2 },
      { seq: 3, type: 'tool_start', payload: { tool: 'Read', input: { path: '/repo/../secrets/x' } }, createdAt: 3 },
      { seq: 4, type: 'tool_start', payload: { tool: 'Read', input: { path: './src/kept.ts' } }, createdAt: 4 },
    ];
    const brief = assembleSubagentBrief({
      parent: parent({ projectPath: '/repo' }),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.files).toEqual(['src/keep.ts', 'src/kept.ts']);
  });

  it('drops upward-traversing relative paths even without an absolute project root', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool_start', payload: { tool: 'Read', input: { path: '../secrets/token.txt' } }, createdAt: 1 },
      { seq: 2, type: 'tool_start', payload: { tool: 'Read', input: { path: './src/ok.ts' } }, createdAt: 2 },
      { seq: 3, type: 'tool_start', payload: { tool: 'Read', input: { path: 'src/nested/../also-ok.ts' } }, createdAt: 3 },
    ];
    const brief = assembleSubagentBrief({
      parent: parent({ projectPath: null }),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.files).toEqual(['src/ok.ts', 'src/also-ok.ts']);
  });

  it('omits files when the parent touched no tool events', () => {
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: [{ seq: 1, type: 'assistant_message', payload: { text: 'hi' }, createdAt: 1 }],
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.files).toBeUndefined();
  });

  it('passes through workspace and verifyCommand, and records provenance', () => {
    const ws = { branch: 'main', headSha: 'abc1234', baseBranch: null, dirtyFiles: [], diffStat: null };
    const events = [toolStart('/repo/x.ts', 7)];
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: events,
      workspace: ws,
      verifyCommand: 'bun run test',
    });
    expect(brief.workspace).toEqual(ws);
    expect(brief.verifyCommand).toBe('bun run test');
    expect(brief.sourceSessionId).toBe('parent-1');
    expect(brief.sourceSeq).toBe(7);
  });

  it('handles a null workspace and empty tail without a source seq', () => {
    const brief = assembleSubagentBrief({
      parent: parent(),
      subagentPrompt: 'go',
      parentTailEvents: [],
      workspace: null,
      verifyCommand: null,
    });
    expect(brief.workspace).toBeNull();
    expect(brief.sourceSeq).toBeUndefined();
    expect(brief.verifyCommand).toBeUndefined();
  });
});
