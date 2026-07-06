import { buildOutcomeDigest } from '../../../src/orchestration/outcome-digest.builder';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto } from '../../../src/tasks/tasks.types';

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 'task-1',
    prompt: 'do the thing',
    status: 'DONE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    projectPath: null,
    baseBranch: null,
    useWorktree: false,
    workspace: null,
    parentSessionId: 'parent-1',
    role: 'subagent',
    cleanupPolicy: 'after-review',
    reviewState: 'awaiting_review',
    sessionId: 'child-1',
    outcome: null,
    contextBrief: null,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  };
}

function assistantMessage(text: string, seq: number): SessionEvent {
  return { seq, type: 'assistant_message', payload: { text }, createdAt: seq };
}

const snapshot = {
  branch: 'feature/x',
  headSha: 'abc1234',
  baseBranch: 'main',
  dirtyFiles: [],
  diffStat: null,
};

describe('buildOutcomeDigest', () => {
  it('summarizes a DONE task with a passing verify', () => {
    const events: SessionEvent[] = [
      assistantMessage('first', 1),
      assistantMessage('final answer', 2),
      { seq: 3, type: 'verify_result', payload: { ok: true, outputTail: 'all green' }, createdAt: 3 },
    ];
    const digest = buildOutcomeDigest(task({ status: 'DONE' }), 'child-1', events, snapshot);
    expect(digest.taskId).toBe('task-1');
    expect(digest.childSessionId).toBe('child-1');
    expect(digest.status).toBe('DONE');
    expect(digest.outcomeSummary).toBe('final answer');
    expect(digest.verify).toEqual({ passed: true, output: 'all green' });
    expect(digest.workspace).toEqual(snapshot);
    expect(digest.childBranch).toBe('feature/x');
  });

  it('reports a FAILED task with no verify and no assistant message', () => {
    const digest = buildOutcomeDigest(task({ status: 'FAILED' }), 'child-1', [], null);
    expect(digest.status).toBe('FAILED');
    expect(digest.outcomeSummary).toBeNull();
    expect(digest.verify).toBeNull();
    expect(digest.workspace).toBeNull();
    expect(digest.childBranch).toBeNull();
  });

  it('carries a failing verify with its output', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'verify_result', payload: { ok: false, outputTail: '2 tests failed' }, createdAt: 1 },
    ];
    const digest = buildOutcomeDigest(task({ status: 'FAILED' }), 'child-1', events, null);
    expect(digest.verify).toEqual({ passed: false, output: '2 tests failed' });
  });

  it('tail-truncates an over-long assistant message to 1024 bytes', () => {
    const long = 'x'.repeat(4000);
    const digest = buildOutcomeDigest(task(), 'child-1', [assistantMessage(long, 1)], null);
    expect(new TextEncoder().encode(digest.outcomeSummary ?? '').byteLength).toBeLessThanOrEqual(1024);
    // It is a TAIL: the end of the message survives.
    expect(digest.outcomeSummary?.endsWith('x')).toBe(true);
  });

  it('caps verify output at 512 bytes', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'verify_result', payload: { ok: false, outputTail: 'e'.repeat(2000) }, createdAt: 1 },
    ];
    const digest = buildOutcomeDigest(task({ status: 'FAILED' }), 'child-1', events, null);
    expect(new TextEncoder().encode(digest.verify?.output ?? '').byteLength).toBeLessThanOrEqual(512);
  });

  it('truncates multi-byte summaries on a clean byte boundary', () => {
    const emoji = '😀'.repeat(400); // 4 bytes each = 1600 bytes
    const digest = buildOutcomeDigest(task(), 'child-1', [assistantMessage(emoji, 1)], null);
    const bytes = new TextEncoder().encode(digest.outcomeSummary ?? '').byteLength;
    expect(bytes).toBeLessThanOrEqual(1024);
    // No replacement character from a chopped surrogate.
    expect(digest.outcomeSummary).not.toContain('�');
  });

  it('emits a CANCELLED digest with a null summary', () => {
    const digest = buildOutcomeDigest(
      task({ status: 'CANCELLED' }),
      'child-1',
      [assistantMessage('ignored', 1)],
      null,
    );
    expect(digest.status).toBe('CANCELLED');
    expect(digest.outcomeSummary).toBeNull();
  });

  it('tolerates a null child session id', () => {
    const digest = buildOutcomeDigest(task({ status: 'FAILED', sessionId: null }), null, [], null);
    expect(digest.childSessionId).toBeNull();
    expect(digest.outcomeSummary).toBeNull();
  });

  it('keeps the worst-case payload within the 4KB events budget', () => {
    const worstWorkspace = {
      branch: 'feature/really-long-branch-name',
      headSha: 'abcdef1',
      baseBranch: 'main',
      dirtyFiles: Array.from({ length: 20 }, (_, i) => `src/${'p'.repeat(200)}-${i}.ts`),
      diffStat: 'd'.repeat(1024),
    };
    const digest = buildOutcomeDigest(
      task({ status: 'DONE' }),
      'child-1',
      [
        assistantMessage('s'.repeat(4000), 1),
        { seq: 2, type: 'verify_result', payload: { ok: false, outputTail: 'v'.repeat(4000) }, createdAt: 2 },
      ],
      worstWorkspace,
    );
    expect(new TextEncoder().encode(JSON.stringify(digest)).byteLength).toBeLessThanOrEqual(4096);
    // Protected fields survive the trim.
    expect(digest.taskId).toBe('task-1');
    expect(digest.status).toBe('DONE');
    expect(digest.verify?.passed).toBe(false);
    // With plain text (no escape inflation), the summary is preferred over
    // verify.output, so a substantial summary survives.
    expect(new TextEncoder().encode(digest.outcomeSummary ?? '').byteLength).toBeGreaterThanOrEqual(256);
  });

  it('does not mutate the caller-supplied workspace snapshot while trimming', () => {
    const ws = {
      branch: 'main',
      headSha: 'abc1234',
      baseBranch: 'main',
      dirtyFiles: Array.from({ length: 20 }, (_, i) => `${'x'.repeat(200)}-${i}`),
      diffStat: 'd'.repeat(1024),
    };
    const before = JSON.stringify(ws);
    buildOutcomeDigest(task({ status: 'DONE' }), 'c', [assistantMessage('y'.repeat(4000), 1)], ws);
    expect(JSON.stringify(ws)).toBe(before);
  });

  it('drops the whole workspace (backstop) when an unbounded scalar still overflows', () => {
    // An absurd branch name survives the dirtyFiles/diffStat/summary ladder, so
    // the final backstop must null the workspace to hold the 4KB bound.
    const absurdWorkspace = {
      branch: 'b'.repeat(5000),
      headSha: 'abc1234',
      baseBranch: 'main',
      dirtyFiles: [],
      diffStat: null,
    };
    const digest = buildOutcomeDigest(task({ status: 'DONE' }), 'child-1', [], absurdWorkspace);
    expect(new TextEncoder().encode(JSON.stringify(digest)).byteLength).toBeLessThanOrEqual(4096);
    expect(digest.workspace).toBeNull();
    expect(digest.childBranch).toBeNull();
    // Protected fields remain.
    expect(digest.taskId).toBe('task-1');
    expect(digest.status).toBe('DONE');
  });

  describe('serialized-payload budget invariant (never > 4096 bytes)', () => {
    const NUL = String.fromCharCode(1); // a C0 control char ()
    const serializedBytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;

    // Each row: [name, summary, verifyOutput]. JSON escaping inflates these
    // (~6x for control chars, 2x for quotes/backslashes), so RAW-byte floors are
    // not enough — the invariant is measured on the SERIALIZED payload.
    const cases: Array<[string, string, string]> = [
      ['NUL-filled summary + control verify output', NUL.repeat(4000), NUL.repeat(4000)],
      ['all-quotes summary + all-quotes verify', '"'.repeat(4000), '"'.repeat(4000)],
      ['all-backslash summary + verify', '\\'.repeat(4000), '\\'.repeat(4000)],
      ['mixed emoji + control chars', '😀'.repeat(2000) + NUL.repeat(2000), '€'.repeat(2000)],
      // The exact review repro: 256 raw control-byte summary tail + 512 raw
      // control-byte verify output previously serialized to 4767 bytes.
      ['review 4767B regression repro', NUL.repeat(1024), NUL.repeat(4000)],
    ];

    for (const [name, summary, verifyOutput] of cases) {
      it(`stays ≤ 4096 serialized: ${name}`, () => {
        const events: SessionEvent[] = [
          assistantMessage(summary, 1),
          { seq: 2, type: 'verify_result', payload: { ok: false, outputTail: verifyOutput }, createdAt: 2 },
        ];
        const digest = buildOutcomeDigest(task({ status: 'DONE' }), 'child-1', events, {
          branch: 'main',
          headSha: 'abc1234',
          baseBranch: 'main',
          dirtyFiles: Array.from({ length: 20 }, (_, i) => `src/${'p'.repeat(200)}-${i}.ts`),
          diffStat: 'd'.repeat(1024),
        });
        expect(serializedBytes(digest)).toBeLessThanOrEqual(4096);
        // Protected fields are never trimmed.
        expect(digest.taskId).toBe('task-1');
        expect(digest.status).toBe('DONE');
        expect(digest.verify?.passed).toBe(false);
      });
    }

    it('strips C0 control characters from summary and verify output', () => {
      const events: SessionEvent[] = [
        assistantMessage(`clean${NUL}text`, 1),
        { seq: 2, type: 'verify_result', payload: { ok: true, outputTail: `ok${NUL}here` }, createdAt: 2 },
      ];
      const digest = buildOutcomeDigest(task({ status: 'DONE' }), 'child-1', events, null);
      expect(digest.outcomeSummary).toBe('cleantext');
      expect(digest.verify?.output).toBe('okhere');
    });

    it('preserves tab and newline (not stripped as control chars)', () => {
      const events: SessionEvent[] = [assistantMessage('line1\nline2\tindented', 1)];
      const digest = buildOutcomeDigest(task({ status: 'DONE' }), 'child-1', events, null);
      expect(digest.outcomeSummary).toBe('line1\nline2\tindented');
    });
  });
});
