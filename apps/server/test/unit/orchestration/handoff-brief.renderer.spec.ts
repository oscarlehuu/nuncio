import { renderHandoffBrief } from '../../../src/orchestration/handoff-brief.renderer';
import type { HandoffBrief } from '../../../src/orchestration/handoff-brief.types';

describe('renderHandoffBrief', () => {
  it('renders a full brief with every section in fixed order', () => {
    const brief: HandoffBrief = {
      goal: 'Ship the login form',
      constraints: ['No new deps', 'Keep bundle under 200kb'],
      decisions: ['Use React Hook Form', 'Cobalt accent'],
      files: ['apps/web/src/login.tsx', 'apps/web/src/auth.ts'],
      verifyCommand: 'bun run test',
      doneCriteria: ['Form submits', 'Errors shown inline'],
      workspace: {
        branch: 'feature/login',
        headSha: 'abc1234',
        baseBranch: 'main',
        dirtyFiles: ['apps/web/src/login.tsx'],
        diffStat: ' login.tsx | 10 +++',
      },
    };
    const out = renderHandoffBrief(brief);
    expect(out.startsWith('## Handoff brief')).toBe(true);
    expect(out).toContain('Ship the login form');
    expect(out).toContain('Constraints:');
    expect(out).toContain('- No new deps');
    expect(out).toContain('Decisions already made:');
    expect(out).toContain('- Use React Hook Form');
    expect(out).toContain('Start from:');
    expect(out).toContain('- apps/web/src/login.tsx');
    expect(out).toContain('Workspace:');
    expect(out).toContain('feature/login');
    expect(out).toContain('Done when:');
    expect(out).toContain('- Form submits');
    expect(out).toContain('Verify: `bun run test`');

    // Fixed section order.
    const order = ['Constraints:', 'Decisions already made:', 'Start from:', 'Workspace:', 'Done when:'];
    let cursor = 0;
    for (const section of order) {
      const at = out.indexOf(section);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('renders a minimal brief (goal only) without empty sections', () => {
    const out = renderHandoffBrief({ goal: 'Fix the typo' });
    expect(out).toContain('## Handoff brief');
    expect(out).toContain('Fix the typo');
    expect(out).not.toContain('Constraints:');
    expect(out).not.toContain('Decisions already made:');
    expect(out).not.toContain('Start from:');
    expect(out).not.toContain('Workspace:');
    expect(out).not.toContain('Done when:');
    expect(out).not.toContain('Verify:');
  });

  it('omits sections backed by empty arrays', () => {
    const out = renderHandoffBrief({ goal: 'g', constraints: [], decisions: [], files: [] });
    expect(out).not.toContain('Constraints:');
    expect(out).not.toContain('Decisions already made:');
    expect(out).not.toContain('Start from:');
  });

  it('omits the workspace section when workspace is null', () => {
    const out = renderHandoffBrief({ goal: 'g', workspace: null });
    expect(out).not.toContain('Workspace:');
  });

  it('truncates files first, then decisions, then constraints when over budget', () => {
    const big = (label: string) => Array.from({ length: 40 }, (_, i) => `${label}-item-${i}-${'x'.repeat(40)}`);
    const brief: HandoffBrief = {
      goal: 'Keep this goal intact',
      constraints: big('constraint'),
      decisions: big('decision'),
      files: big('file'),
      verifyCommand: 'bun run test',
      doneCriteria: ['Keep this done criterion intact'],
    };
    const out = renderHandoffBrief(brief);
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(2048);
    expect(out).toContain('_(brief truncated)_');
    // Never-dropped fields survive.
    expect(out).toContain('Keep this goal intact');
    expect(out).toContain('Keep this done criterion intact');
    expect(out).toContain('Verify: `bun run test`');
    // Files are dropped before decisions and constraints.
    expect(out.includes('file-item-0')).toBe(false);
  });

  it('keeps the goal even when the goal alone exceeds the budget', () => {
    const goal = 'g'.repeat(4000);
    const out = renderHandoffBrief({ goal });
    expect(out).toContain('## Handoff brief');
    expect(out).toContain(goal);
    expect(out).toContain('_(brief truncated)_');
  });
});
