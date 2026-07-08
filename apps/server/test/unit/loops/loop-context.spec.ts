import { describe, expect, it } from 'bun:test';
import { CONTEXT_HEADER, buildRunContext, withRunContext } from '../../../src/loops/loop-context';
import type { LoopRunDto, LoopRunOutcome, LoopRunVerify } from '../../../src/loops/loops.types';

let seq = 0;
function run(outcome: LoopRunOutcome, verify: LoopRunVerify = 'none', dayBucket = '2026-07-07'): LoopRunDto {
  seq += 1;
  return { id: `r${seq}`, loopId: 'L', taskId: `t${seq}`, outcome, verify, dayBucket, createdAt: seq };
}

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

const now = at(2026, 7, 7, 9, 0);

describe('buildRunContext (memories v1)', () => {
  it('returns empty on the first run (no prior settled run)', () => {
    expect(buildRunContext({ runs: [], lastVerifyTail: null, maxRunsPerDay: 5, now })).toBe('');
    // A pending-only history is still "no settled run".
    expect(
      buildRunContext({ runs: [run('pending')], lastVerifyTail: null, maxRunsPerDay: 5, now }),
    ).toBe('');
  });

  it('summarizes the previous settled run, streak, and runs-today', () => {
    const runs = [run('failed', 'red', '2026-07-07'), run('failed', 'red', '2026-07-07')];
    const block = buildRunContext({ runs, lastVerifyTail: null, maxRunsPerDay: 8, now });
    expect(block.startsWith(CONTEXT_HEADER)).toBe(true);
    expect(block).toContain('Previous run: failed (verify red)');
    expect(block).toContain('Consecutive failures: 2');
    expect(block).toContain('Runs today: 2/8');
  });

  it('includes the last verify output tail, capped', () => {
    const tail = 'X'.repeat(5000);
    const block = buildRunContext({
      runs: [run('failed', 'red')],
      lastVerifyTail: tail,
      maxRunsPerDay: 5,
      now,
    });
    expect(block).toContain('Last verify output (tail):');
    const xRun = /X{100,}/.exec(block)?.[0].length ?? 0;
    expect(xRun).toBeLessThanOrEqual(1500);
  });

  it('omits the verify tail line when none is available', () => {
    const block = buildRunContext({ runs: [run('ok', 'green')], lastVerifyTail: null, maxRunsPerDay: 5, now });
    expect(block).not.toContain('Last verify output');
  });
});

describe('withRunContext', () => {
  it('prepends the delimited context block to the goal', () => {
    const out = withRunContext('bump deps', 'Previous run context:\n- x');
    expect(out).toContain('Previous run context:');
    expect(out).toContain('---');
    expect(out.endsWith('bump deps')).toBe(true);
  });

  it('returns the bare goal when the context is empty', () => {
    expect(withRunContext('bump deps', '')).toBe('bump deps');
  });
});
