import { renderOutcomeDigest, DIGEST_ACTION_SENTENCE } from '../../../src/orchestration/outcome-digest.renderer';
import { byteLength } from '../../../src/orchestration/byte-truncate';
import type { TaskCompletedPayload } from '../../../src/sessions/domain/events.types';

function payload(overrides: Partial<TaskCompletedPayload> = {}): TaskCompletedPayload {
  return {
    taskId: 'task-1',
    childSessionId: 'child-1',
    status: 'DONE',
    outcomeSummary: 'Implemented the fix and added a test.',
    verify: { passed: true, output: 'all green' },
    workspace: { branch: 'feature/x', headSha: 'abc1234', baseBranch: 'main', dirtyFiles: [], diffStat: null },
    childBranch: 'feature/x',
    ...overrides,
  };
}

describe('renderOutcomeDigest', () => {
  it('renders status, verify line, child branch, and the summary excerpt', () => {
    const out = renderOutcomeDigest(payload());
    expect(out).toContain('DONE');
    expect(out.toLowerCase()).toContain('verify');
    expect(out).toContain('feature/x');
    expect(out).toContain('Implemented the fix');
  });

  it('ends with exactly the action sentence', () => {
    const out = renderOutcomeDigest(payload());
    expect(out.trimEnd().endsWith(DIGEST_ACTION_SENTENCE)).toBe(true);
    expect(DIGEST_ACTION_SENTENCE).toBe('Reply with next action, or reply DONE if the objective is met.');
  });

  it('shows a failed verify line', () => {
    const out = renderOutcomeDigest(payload({ status: 'FAILED', verify: { passed: false, output: '2 failed' } }));
    expect(out).toContain('FAILED');
    expect(out.toLowerCase()).toContain('fail');
  });

  it('omits sections gracefully when fields are null', () => {
    const out = renderOutcomeDigest(
      payload({ outcomeSummary: null, verify: null, workspace: null, childBranch: null }),
    );
    expect(out).toContain('DONE');
    // Still ends with the action sentence, no throw.
    expect(out.trimEnd().endsWith(DIGEST_ACTION_SENTENCE)).toBe(true);
  });

  it('stays within 1.5KB on adversarial input (serialized-byte aware)', () => {
    const out = renderOutcomeDigest(
      payload({
        outcomeSummary: 'x'.repeat(8000),
        verify: { passed: false, output: 'e'.repeat(8000) },
        childBranch: 'b'.repeat(4000),
      }),
    );
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(1536);
    // The action sentence is never truncated away.
    expect(out.trimEnd().endsWith(DIGEST_ACTION_SENTENCE)).toBe(true);
  });

  it('renders a CANCELLED digest', () => {
    const out = renderOutcomeDigest(payload({ status: 'CANCELLED', outcomeSummary: null, verify: null }));
    expect(out).toContain('CANCELLED');
    expect(out.trimEnd().endsWith(DIGEST_ACTION_SENTENCE)).toBe(true);
  });

  it('wraps the digest with a profile digest-wrapper (D2)', () => {
    const out = renderOutcomeDigest(payload(), { digestWrapper: '<<{{content}}>>' });
    expect(out.startsWith('<<')).toBe(true);
    expect(out.endsWith('>>')).toBe(true);
    expect(out).toContain('DONE');
  });

  it('clamps the final wrapped output to the 1.5KB budget under a hostile wrapper', () => {
    const warnings: string[] = [];
    const out = renderOutcomeDigest(payload(), {
      digestWrapper: 'HUGE'.repeat(15000) + '{{content}}',
      warn: (m) => warnings.push(m),
    });
    expect(byteLength(out)).toBeLessThanOrEqual(1536);
    expect(warnings.some((w) => w.includes('clamp'))).toBe(true);
  });

  it('prefix-heavy parse-valid wrapper: clamp still ends with the exact action sentence within budget', () => {
    const warnings: string[] = [];
    const out = renderOutcomeDigest(payload(), {
      digestWrapper: 'X'.repeat(1500) + '{{content}}',
      warn: (m) => warnings.push(m),
    });
    expect(byteLength(out)).toBeLessThanOrEqual(1536);
    expect(out.endsWith(DIGEST_ACTION_SENTENCE)).toBe(true);
    expect(warnings.some((w) => w.includes('clamp'))).toBe(true);
  });

  it('no wrapper → byte-identical to the unwrapped digest (pass-through)', () => {
    const p = payload();
    expect(renderOutcomeDigest(p, {})).toBe(renderOutcomeDigest(p));
  });
});
