import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWorkspaceSnapshot } from '../../../src/orchestration/workspace-snapshot';

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

describe('buildWorkspaceSnapshot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-ws-snap-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function initRepo(): Promise<void> {
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'initial');
  }

  it('returns null for a non-git directory', async () => {
    const snap = await buildWorkspaceSnapshot(dir);
    expect(snap).toBeNull();
  });

  it('reports branch and short sha for a committed repo', async () => {
    await initRepo();
    const snap = await buildWorkspaceSnapshot(dir);
    expect(snap).not.toBeNull();
    expect(snap!.branch).toBe('main');
    expect(snap!.headSha).toMatch(/^[0-9a-f]{7,}$/);
    expect(snap!.dirtyFiles).toEqual([]);
  });

  it('lists dirty files from porcelain status', async () => {
    await initRepo();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');
    const snap = await buildWorkspaceSnapshot(dir);
    expect(snap!.dirtyFiles).toContain('a.txt');
    expect(snap!.dirtyFiles).toContain('b.txt');
  });

  it('caps the dirty file list at 20 with an overflow marker', async () => {
    await initRepo();
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    }
    const snap = await buildWorkspaceSnapshot(dir);
    expect(snap!.dirtyFiles).toHaveLength(21);
    expect(snap!.dirtyFiles[20]).toMatch(/…and \d+ more/);
  });

  it('produces a diffStat when a base branch is given', async () => {
    await initRepo();
    await git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'a.txt'), 'feature change\n');
    await git(dir, 'commit', '-q', '-am', 'feature work');
    const snap = await buildWorkspaceSnapshot(dir, 'main');
    expect(snap!.baseBranch).toBe('main');
    expect(snap!.diffStat).toContain('a.txt');
  });

  it('leaves diffStat null when no base branch is given', async () => {
    await initRepo();
    const snap = await buildWorkspaceSnapshot(dir);
    expect(snap!.diffStat).toBeNull();
  });

  it('returns a snapshot (not null) even when the base branch does not exist', async () => {
    await initRepo();
    const snap = await buildWorkspaceSnapshot(dir, 'no-such-base');
    expect(snap).not.toBeNull();
    expect(snap!.branch).toBe('main');
    expect(snap!.diffStat).toBeNull();
  });
});
