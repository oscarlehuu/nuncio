import { groupSessionsByRepo } from '../../../src/projects/repo-grouping';

describe('groupSessionsByRepo', () => {
  it('groups a main-checkout session and a worktree session of one repo together', () => {
    const groups = groupSessionsByRepo([
      {
        id: 's-main',
        identityId: 'remote:github.com/octo/app',
        repoRoot: '/repos/app',
        name: 'app',
        branch: 'main',
        worktreePath: null,
        isWorktree: false,
      },
      {
        id: 's-wt',
        identityId: 'remote:github.com/octo/app',
        repoRoot: '/repos/app',
        name: 'app',
        branch: 'feature',
        worktreePath: '/work/s-wt',
        isWorktree: true,
      },
    ]);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.id).toBe('remote:github.com/octo/app');
    expect(group.repoRoot).toBe('/repos/app');
    expect(group.sessionIds).toEqual(['s-main', 's-wt']);
    expect(group.worktrees).toEqual([
      { path: '/work/s-wt', branch: 'feature', sessionIds: ['s-wt'] },
    ]);
  });

  it('keeps two different repos as separate groups', () => {
    const groups = groupSessionsByRepo([
      { id: 'a', identityId: 'remote:github.com/octo/a', repoRoot: '/r/a', name: 'a', branch: 'main', worktreePath: null, isWorktree: false },
      { id: 'b', identityId: 'remote:github.com/octo/b', repoRoot: '/r/b', name: 'b', branch: 'main', worktreePath: null, isWorktree: false },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.id).sort()).toEqual([
      'remote:github.com/octo/a',
      'remote:github.com/octo/b',
    ]);
  });

  it('keeps non-git path-identity folders separate from each other', () => {
    const groups = groupSessionsByRepo([
      { id: 'p1', identityId: '/loose/one', repoRoot: '/loose/one', name: 'one', branch: null, worktreePath: null, isWorktree: false },
      { id: 'p2', identityId: '/loose/two', repoRoot: '/loose/two', name: 'two', branch: null, worktreePath: null, isWorktree: false },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('collapses multiple sessions in the same worktree into one worktree entry', () => {
    const groups = groupSessionsByRepo([
      { id: 's1', identityId: 'remote:github.com/octo/app', repoRoot: '/repos/app', name: 'app', branch: 'feat', worktreePath: '/work/x', isWorktree: true },
      { id: 's2', identityId: 'remote:github.com/octo/app', repoRoot: '/repos/app', name: 'app', branch: 'feat', worktreePath: '/work/x', isWorktree: true },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].worktrees).toEqual([
      { path: '/work/x', branch: 'feat', sessionIds: ['s1', 's2'] },
    ]);
  });
});
