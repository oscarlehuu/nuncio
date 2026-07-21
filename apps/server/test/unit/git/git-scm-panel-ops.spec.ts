import { BadRequestException } from '@nestjs/common';
import {
  MAX_BLAME_LINES,
  MAX_HISTORY_LIMIT,
  blame,
  branchSync,
  commitDiff,
  history,
  parseCommitLog,
  parseConflictPaths,
  pull,
  type GitRunner,
} from '../../../src/git/git-scm-panel-ops';

function mockGit(handlers: Record<string, string | Error> = {}): GitRunner {
  return async (args) => {
    const key = args.join(' ');
    for (const [pattern, value] of Object.entries(handlers)) {
      if (key.includes(pattern) || key === pattern) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return '';
  };
}

describe('git-scm-panel-ops', () => {
  describe('parseConflictPaths', () => {
    it('collects every conflict code and skips headers / non-conflicts', () => {
      const porcelain = [
        '## main...origin/main [ahead 1]',
        'UU conflicted.txt',
        'AA both-added.ts',
        'DD both-deleted.md',
        'AU added-by-us.js',
        'UA added-by-them.js',
        'DU deleted-by-us.css',
        'UD deleted-by-them.css',
        ' M dirty-but-not-conflicted.ts',
        '?? untracked.ts',
        '',
      ].join('\n');

      expect(parseConflictPaths(porcelain)).toEqual([
        'conflicted.txt',
        'both-added.ts',
        'both-deleted.md',
        'added-by-us.js',
        'added-by-them.js',
        'deleted-by-us.css',
        'deleted-by-them.css',
      ]);
    });

    it('returns empty for clean porcelain', () => {
      expect(parseConflictPaths('')).toEqual([]);
      expect(parseConflictPaths('## main\n')).toEqual([]);
    });
  });

  describe('parseCommitLog', () => {
    it('parses RS-delimited records and skips malformed ones', () => {
      const output = [
        'abc123\x00abc\x00init\x00Ada\x002026-01-01T00:00:00Z\x1e',
        '\n',
        'missing-short\x1e',
        'def456\x00def\x00second\x00Bob\x002026-01-02T00:00:00Z\x1e',
      ].join('');

      expect(parseCommitLog(output)).toEqual([
        {
          sha: 'abc123',
          shortSha: 'abc',
          subject: 'init',
          authorName: 'Ada',
          authoredAt: '2026-01-01T00:00:00Z',
        },
        {
          sha: 'def456',
          shortSha: 'def',
          subject: 'second',
          authorName: 'Bob',
          authoredAt: '2026-01-02T00:00:00Z',
        },
      ]);
    });

    it('returns empty for blank output', () => {
      expect(parseCommitLog('')).toEqual([]);
      expect(parseCommitLog('   \n')).toEqual([]);
    });
  });

  describe('branchSync', () => {
    it('reports dirty tree, conflicts, and ahead/behind from log ranges', async () => {
      const outgoing =
        'aaa1111111111111111111111111111111111111\x00aaa1111\x00out\x00Ada\x002026-01-01T00:00:00Z\x1e';
      const incoming =
        'bbb2222222222222222222222222222222222222\x00bbb2222\x00in\x00Bob\x002026-01-02T00:00:00Z\x1e';

      const git: GitRunner = async (args) => {
        const joined = args.join(' ');
        if (joined.includes('status')) {
          return '## main\nUU conflicted.txt\n M dirty.ts\n';
        }
        if (joined.includes('origin/main..HEAD')) return outgoing;
        if (joined.includes('HEAD..origin/main')) return incoming;
        return '';
      };

      const sync = await branchSync(git, '/repo', 'main', 'origin/main');
      expect(sync.clean).toBe(false);
      expect(sync.conflicts).toEqual(['conflicted.txt']);
      expect(sync.ahead).toBe(1);
      expect(sync.behind).toBe(1);
      expect(sync.outgoing[0]?.shortSha).toBe('aaa1111');
      expect(sync.incoming[0]?.shortSha).toBe('bbb2222');
    });

    it('skips range logs when base is null', async () => {
      const git = mockGit({ status: '' });
      const sync = await branchSync(git, '/repo', 'main', null);
      expect(sync).toEqual({
        branch: 'main',
        base: null,
        ahead: 0,
        behind: 0,
        outgoing: [],
        incoming: [],
        conflicts: [],
        clean: true,
      });
    });
  });

  describe('commitDiff', () => {
    it('rejects invalid revisions', async () => {
      const git = mockGit({ 'rev-parse': new Error('bad object') });
      await expect(commitDiff(git, '/repo', 'not-a-sha')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(commitDiff(git, '/repo', 'not-a-sha')).rejects.toThrow('Invalid revision');
    });

    it('truncates oversized diffs', async () => {
      const huge = 'x'.repeat(200_001);
      const git: GitRunner = async (args) => {
        if (args[0] === 'rev-parse') return args[2] ?? '';
        if (args[0] === 'show') return huge;
        return '';
      };
      const result = await commitDiff(git, '/repo', 'abc1234');
      expect(result.truncated).toBe(true);
      expect(result.diff.length).toBe(200_000);
    });

    it('returns untruncated diffs under the cap', async () => {
      const git: GitRunner = async (args) => {
        if (args[0] === 'rev-parse') return 'abc1234';
        if (args[0] === 'show') return 'diff --git a/f b/f\n';
        return '';
      };
      await expect(commitDiff(git, '/repo', 'abc1234')).resolves.toEqual({
        diff: 'diff --git a/f b/f\n',
        truncated: false,
      });
    });
  });

  describe('history', () => {
    it('clamps limit to [1, MAX_HISTORY_LIMIT] and parses parents', async () => {
      const seen: string[][] = [];
      const record =
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00aaaaaaa\x00root\x00Ada\x002026-01-01T00:00:00Z\x00\x1e' +
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x00bbbbbbb\x00child\x00Bob\x002026-01-02T00:00:00Z\x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1e';

      const git: GitRunner = async (args) => {
        seen.push(args);
        return record;
      };

      const zero = await history(git, '/repo', 'main', 0);
      expect(seen[0]?.find((a) => a.startsWith('--max-count='))).toBe('--max-count=1');
      expect(zero.commits[0]?.parents).toEqual([]);
      expect(zero.commits[1]?.parents).toEqual(['aaaaaaa']);

      seen.length = 0;
      await history(git, '/repo', 'main', 999);
      expect(seen[0]?.find((a) => a.startsWith('--max-count='))).toBe(
        `--max-count=${MAX_HISTORY_LIMIT}`,
      );

      seen.length = 0;
      await history(git, '/repo', 'feature', -5, 'feature');
      expect(seen[0]?.at(-1)).toBe('feature');
      expect(seen[0]?.find((a) => a.startsWith('--max-count='))).toBe('--max-count=1');
    });

    it('returns empty commits when git log fails', async () => {
      const git = mockGit({ log: new Error('fatal') });
      await expect(history(git, '/repo', 'main')).resolves.toEqual({
        branch: 'main',
        commits: [],
      });
    });
  });

  describe('blame', () => {
    it('parses porcelain lines and caps at MAX_BLAME_LINES', async () => {
      const sha = 'cccccccccccccccccccccccccccccccccccccccc';
      const chunks: string[] = [];
      for (let i = 1; i <= MAX_BLAME_LINES + 5; i++) {
        chunks.push(
          `${sha} ${i} ${i} 1`,
          'author Ada',
          'author-time 1700000000',
          `\tline ${i}`,
        );
      }
      const git = mockGit({ blame: chunks.join('\n') });
      const result = await blame(git, '/repo', 'src/a.ts', (p) => p);
      expect(result.path).toBe('src/a.ts');
      expect(result.truncated).toBe(true);
      expect(result.lines).toHaveLength(MAX_BLAME_LINES);
      expect(result.lines[0]).toMatchObject({
        line: 1,
        sha,
        shortSha: 'ccccccc',
        authorName: 'Ada',
        content: 'line 1',
      });
      expect(result.lines[0]?.authoredAt).toBe(new Date(1700000000 * 1000).toISOString());
    });

    it('wraps git blame failures as BadRequestException', async () => {
      const git = mockGit({ blame: new Error('no such path') });
      await expect(blame(git, '/repo', 'missing.ts', (p) => p)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('pull', () => {
    it('detects fast-forward from stdout', async () => {
      const git = mockGit({
        pull: 'Updating abc..def\nFast-forward\n README.md | 1 +\n',
      });
      await expect(pull(git, '/repo')).resolves.toEqual({
        pulled: true,
        fastForward: true,
      });
    });

    it('reports non-ff pull output without fastForward', async () => {
      const git = mockGit({ pull: 'Already up to date.\n' });
      await expect(pull(git, '/repo')).resolves.toEqual({
        pulled: true,
        fastForward: false,
      });
    });

    it('wraps pull failures', async () => {
      const git = mockGit({ pull: new Error('not possible to fast-forward') });
      await expect(pull(git, '/repo')).rejects.toThrow(/Failed to pull/);
    });
  });
});
