import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvidenceGitHead } from '../../../src/evidence/evidence-git-head';

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

describe('readEvidenceGitHead', () => {
  let sandbox: string;

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns the exact HEAD sha for a clean git checkout', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'nuncio-evidence-head-'));
    await runGit(sandbox, ['init', '-b', 'main']);
    await runGit(sandbox, ['config', 'user.email', 't@nuncio.local']);
    await runGit(sandbox, ['config', 'user.name', 'Nuncio Test']);
    writeFileSync(join(sandbox, 'README.md'), 'hello');
    await runGit(sandbox, ['add', 'README.md']);
    await runGit(sandbox, ['commit', '-m', 'init']);

    const head = await readEvidenceGitHead(sandbox);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    const verify = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: sandbox, stdout: 'pipe' });
    const expected = (await new Response(verify.stdout).text()).trim();
    expect(head).toBe(expected);
  });

  it('returns null outside a git repository', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'nuncio-evidence-nogit-'));
    await expect(readEvidenceGitHead(sandbox)).resolves.toBeNull();
  });

  it('returns null when rev-parse exits non-zero (unborn branch)', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'nuncio-evidence-unborn-'));
    await runGit(sandbox, ['init', '-b', 'main']);
    await expect(readEvidenceGitHead(sandbox)).resolves.toBeNull();
  });

  it('returns null for a missing directory', async () => {
    await expect(readEvidenceGitHead('/definitely/not/a/nuncio/repo/path')).resolves.toBeNull();
  });

  it('returns null when stdout is not a valid commit sha', async () => {
    const originalSpawn = Bun.spawn;
    try {
      Bun.spawn = ((_cmd: string[], opts?: { cwd?: string }) => ({
        stdout: new Response('not-a-sha\n').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        kill() {},
        stdin: undefined,
      })) as typeof Bun.spawn;
      await expect(readEvidenceGitHead('/any/cwd')).resolves.toBeNull();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
