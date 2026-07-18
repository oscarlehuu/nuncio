import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureWorkspaceDiffSnapshot,
  classifyFiles,
  classifyPath,
} from '../../../src/sessions/diff/turn-diff-classifier';

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
}

describe('classifyPath', () => {
  it('flags .nuncio paths as gate-protected at any depth', () => {
    expect(classifyPath('.nuncio/verify')).toBe('gate-protected');
    expect(classifyPath('packages/app/.nuncio/verify')).toBe('gate-protected');
    expect(classifyPath('.nuncio/run-count')).toBe('gate-protected');
  });

  it('does not confuse sibling names with the gate directory', () => {
    expect(classifyPath('nuncio-x/file.ts')).not.toBe('gate-protected');
    expect(classifyPath('src/.nuncio.bak/file')).not.toBe('gate-protected');
  });

  it('flags UI-rendering file types as ui', () => {
    expect(classifyPath('src/App.tsx')).toBe('ui');
    expect(classifyPath('web/components/button.jsx')).toBe('ui');
    expect(classifyPath('styles/site.css')).toBe('ui');
    expect(classifyPath('pages/index.vue')).toBe('ui');
    expect(classifyPath('index.html')).toBe('ui');
  });

  it('classifies everything else as other', () => {
    expect(classifyPath('README.md')).toBe('other');
    expect(classifyPath('src/service.ts')).toBe('other');
    expect(classifyPath('scripts/build.sh')).toBe('other');
  });
});

describe('classifyFiles', () => {
  it('returns the distinct classes across the file list', () => {
    expect(classifyFiles(['src/a.ts', 'src/b.ts'])).toEqual(['other']);
    expect(classifyFiles(['src/App.tsx', '.nuncio/verify', 'README.md']).sort()).toEqual(
      ['gate-protected', 'other', 'ui'],
    );
    expect(classifyFiles([])).toEqual([]);
  });
});

describe('captureWorkspaceDiffSnapshot', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nuncio-turn-diff-'));
    runGit(repo, ['init', '-q']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns null for a non-git directory (verify must keep running)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'nuncio-plain-'));
    try {
      expect(await captureWorkspaceDiffSnapshot(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('is stable across calls on an unchanged workspace', async () => {
    const first = await captureWorkspaceDiffSnapshot(repo);
    const second = await captureWorkspaceDiffSnapshot(repo);
    expect(first).not.toBeNull();
    expect(first!.files).toEqual([]);
    expect(second!.fingerprint).toBe(first!.fingerprint);
  });

  it('changes the fingerprint and lists the file when a new file appears', async () => {
    const before = await captureWorkspaceDiffSnapshot(repo);
    writeFileSync(join(repo, 'src.tsx'), 'export {}\n');
    const after = await captureWorkspaceDiffSnapshot(repo);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
    expect(after!.files).toContain('src.tsx');
    expect(after!.classes).toContain('ui');
  });

  it('changes the fingerprint when an already-dirty file changes content', async () => {
    writeFileSync(join(repo, 'work.txt'), 'v1\n');
    const before = await captureWorkspaceDiffSnapshot(repo);
    // Same path stays in porcelain; only size/mtime move.
    writeFileSync(join(repo, 'work.txt'), 'v2 longer\n');
    const after = await captureWorkspaceDiffSnapshot(repo);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
  });

  it('changes the fingerprint when content changes but size stays equal', async () => {
    writeFileSync(join(repo, 'work.txt'), 'aaaa\n');
    const before = await captureWorkspaceDiffSnapshot(repo);
    writeFileSync(join(repo, 'work.txt'), 'bbbb\n');
    // Force an mtime step even on coarse-mtime filesystems.
    utimesSync(join(repo, 'work.txt'), new Date(), new Date(Date.now() + 5000));
    const after = await captureWorkspaceDiffSnapshot(repo);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
  });

  it('changes the fingerprint when HEAD moves (committed work, clean tree)', async () => {
    const before = await captureWorkspaceDiffSnapshot(repo);
    writeFileSync(join(repo, 'feature.ts'), 'export {}\n');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-q', '-m', 'feature']);
    const after = await captureWorkspaceDiffSnapshot(repo);
    expect(after!.files).toEqual([]);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
  });

  it('flags gate-protected changes under .nuncio', async () => {
    mkdirSync(join(repo, '.nuncio'), { recursive: true });
    writeFileSync(join(repo, '.nuncio', 'verify'), 'exit 0\n');
    const snapshot = await captureWorkspaceDiffSnapshot(repo);
    expect(snapshot!.classes).toContain('gate-protected');
  });

  it('caps the reported file list but keeps the fingerprint sensitive to all files', async () => {
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(repo, `f${String(i).padStart(2, '0')}.txt`), `${i}\n`);
    }
    const snapshot = await captureWorkspaceDiffSnapshot(repo);
    expect(snapshot!.files.length).toBeLessThanOrEqual(20);
    expect(snapshot!.filesTotal).toBe(30);
    writeFileSync(join(repo, 'zz-not-in-list.txt'), 'tail\n');
    const after = await captureWorkspaceDiffSnapshot(repo);
    expect(after!.fingerprint).not.toBe(snapshot!.fingerprint);
  });
});
