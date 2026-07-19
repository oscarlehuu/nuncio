import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSessionWorkspaceContext,
  renderWorkspaceContext,
  type SessionWorkspaceContext,
} from '../../../src/orchestration/session-workspace-context';

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  await proc.exited;
}

describe('buildSessionWorkspaceContext', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-ws-ctx-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function initRepo(): Promise<void> {
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'README.md'), '# hello\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'first commit');
    writeFileSync(join(dir, 'README.md'), '# hello again\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'second commit');
  }

  it('returns null for a non-git directory', async () => {
    expect(await buildSessionWorkspaceContext(dir)).toBeNull();
  });

  it('returns null for a fresh repo with no commits (documented degrade)', async () => {
    await git(dir, 'init', '-q', '-b', 'main');
    expect(await buildSessionWorkspaceContext(dir)).toBeNull();
  });

  it('captures snapshot, recent commit subjects, and top-level entries', async () => {
    await initRepo();
    const ctx = await buildSessionWorkspaceContext(dir);
    expect(ctx).not.toBeNull();
    expect(ctx!.snapshot.branch).toBe('main');
    expect(ctx!.snapshot.headSha).toMatch(/^[0-9a-f]{7,}$/);
    expect(ctx!.recentCommits[0]).toMatch(/^[0-9a-f]{7,} second commit$/);
    expect(ctx!.recentCommits[1]).toMatch(/^[0-9a-f]{7,} first commit$/);
    // Directories are marked with a trailing slash; files are bare names.
    expect(ctx!.topLevelEntries).toContain('src/');
    expect(ctx!.topLevelEntries).toContain('README.md');
  });

  it('caps top-level entries with an overflow note', async () => {
    await initRepo();
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `file-${String(i).padStart(2, '0')}.txt`), 'x\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'many files');
    const ctx = await buildSessionWorkspaceContext(dir);
    expect(ctx!.topLevelEntries.length).toBeLessThanOrEqual(31);
    expect(ctx!.topLevelEntries.at(-1)).toMatch(/^…and \d+ more$/);
  });
});

describe('renderWorkspaceContext', () => {
  const base: SessionWorkspaceContext = {
    snapshot: {
      branch: 'nuncio/abc-fix',
      headSha: 'abc1234',
      baseBranch: 'main',
      dirtyFiles: [],
      diffStat: null,
    },
    recentCommits: ['abc1234 second commit', 'def5678 first commit'],
    topLevelEntries: ['src/', 'README.md'],
  };

  it('renders a compact workspace block', () => {
    const out = renderWorkspaceContext(base);
    expect(out).toContain('## Workspace');
    expect(out).toContain('nuncio/abc-fix');
    expect(out).toContain('abc1234');
    expect(out).toContain('main');
    expect(out).toContain('clean');
    expect(out).toContain('second commit');
    expect(out).toContain('src/');
  });

  it('labels a detached HEAD instead of presenting it as a branch', () => {
    const out = renderWorkspaceContext({
      ...base,
      snapshot: { ...base.snapshot, branch: 'HEAD' },
    });
    expect(out).toContain('branch: (detached) (base: main)');
    expect(out).not.toContain('branch: HEAD');
  });

  it('lists dirty files when present', () => {
    const out = renderWorkspaceContext({
      ...base,
      snapshot: { ...base.snapshot, dirtyFiles: ['a.ts', 'b.ts'] },
    });
    expect(out).not.toContain('clean');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
  });

  it('stays within the byte cap for pathological inputs', () => {
    const out = renderWorkspaceContext({
      snapshot: {
        branch: 'b'.repeat(300),
        headSha: 'abc1234',
        baseBranch: null,
        dirtyFiles: Array.from({ length: 21 }, (_, i) => `${'f'.repeat(80)}-${i}.ts`),
        diffStat: null,
      },
      recentCommits: Array.from({ length: 3 }, () => `abc1234 ${'s'.repeat(300)}`),
      topLevelEntries: Array.from({ length: 31 }, (_, i) => `${'d'.repeat(60)}-${i}/`),
    });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1536);
  });
});
