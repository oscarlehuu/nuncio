import { BadRequestException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileExplorerService } from '../../../src/fs/file-explorer.service';

function expectBadRequest(fn: () => unknown) {
  expect(fn).toThrow(BadRequestException);
}

describe('FileExplorerService', () => {
  let root: string;
  let outside: string;
  let service: FileExplorerService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nuncio-file-explorer-root-'));
    outside = mkdtempSync(join(tmpdir(), 'nuncio-file-explorer-outside-'));
    service = new FileExplorerService();

    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'z-dir'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Hello');
    writeFileSync(join(root, '.env'), 'TOKEN=1');
    writeFileSync(join(root, 'src', 'app.ts'), 'console.log("hi")');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(outside, join(root, 'escape-link'), 'dir');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file'), 'file');
    } catch {
      // Some environments disallow symlinks; tests that need it skip gracefully.
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  describe('confinement', () => {
    const traversal = '../secret.txt';
    const absolute = '/tmp/secret.txt';

    it('rejects traversal, absolute paths, and symlink escapes for entries', () => {
      expectBadRequest(() => service.listEntries(root, traversal));
      expectBadRequest(() => service.listEntries(root, absolute));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.listEntries(root, 'escape-link'));
      }
    });

    it('rejects traversal, absolute paths, and symlink escapes for reads', () => {
      expectBadRequest(() => service.readFile(root, traversal));
      expectBadRequest(() => service.readFile(root, absolute));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.readFile(root, 'escape-link/secret.txt'));
        expectBadRequest(() => service.readFile(root, 'escape-file'));
      }
    });

    it('rejects traversal, absolute paths, and symlink escapes for writes', () => {
      expectBadRequest(() => service.writeFile(root, traversal, 'x'));
      expectBadRequest(() => service.writeFile(root, absolute, 'x'));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.writeFile(root, 'escape-link/secret.txt', 'x'));
        expectBadRequest(() => service.writeFile(root, 'escape-file', 'x'));
      }
    });

    it('rejects traversal, absolute paths, and symlink escapes for mkdir', () => {
      expectBadRequest(() => service.makeDir(root, traversal));
      expectBadRequest(() => service.makeDir(root, absolute));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.makeDir(root, 'escape-link/new-dir'));
      }
    });

    it('rejects traversal, absolute paths, symlink escapes, and root moves for rename', () => {
      expectBadRequest(() => service.rename(root, traversal, 'ok'));
      expectBadRequest(() => service.rename(root, 'README.md', absolute));
      expectBadRequest(() => service.rename(root, '', 'moved-root'));
      expectBadRequest(() => service.rename(root, '.', 'moved-root'));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.rename(root, 'escape-link/secret.txt', 'src/secret.txt'));
        expectBadRequest(() => service.rename(root, 'README.md', 'escape-link/README.md'));
      }
    });

    it('rejects traversal, absolute paths, symlink escapes, and delete-of-root for delete', () => {
      expectBadRequest(() => service.deleteEntry(root, traversal));
      expectBadRequest(() => service.deleteEntry(root, absolute));
      expectBadRequest(() => service.deleteEntry(root, ''));
      expectBadRequest(() => service.deleteEntry(root, '.'));
      if (existsSync(join(root, 'escape-link'))) {
        expectBadRequest(() => service.deleteEntry(root, 'escape-link/secret.txt'));
        expectBadRequest(() => service.deleteEntry(root, 'escape-link'));
        expectBadRequest(() => service.deleteEntry(root, 'escape-file'));
      }
    });
  });

  it('requires root to be an existing directory', () => {
    expectBadRequest(() => service.listEntries(join(root, 'missing'), ''));
    expectBadRequest(() => service.listEntries(root, 'README.md'));
  });

  it('lists files and directories dirs-first, hides .git/node_modules, and shows other dotfiles', () => {
    const listing = service.listEntries(root, '');
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'dir:src',
      'dir:z-dir',
      'file:.env',
      'file:README.md',
    ]);
  });

  it('lists nested directory entries with parent paths', () => {
    const listing = service.listEntries(root, 'src');
    expect(listing.path).toBe('src');
    expect(listing.parent).toBe('');
    expect(listing.entries).toEqual([
      { name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 17 },
    ]);
  });

  it('reads utf8 files and flags binary and oversized files without raw content', () => {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));

    expect(service.readFile(root, 'README.md')).toMatchObject({
      path: 'README.md',
      content: '# Hello',
      encoding: 'utf8',
      truncated: false,
      size: 7,
    });
    expect(service.readFile(root, 'binary.bin')).toMatchObject({ binary: true, size: 3 });
    const large = service.readFile(root, 'large.txt');
    expect(large).toMatchObject({ truncated: true, size: 1024 * 1024 + 1 });
    expect('content' in large).toBe(false);
  });

  it('writes files, creates directories, renames, and deletes files/directories', () => {
    expect(service.writeFile(root, 'src/new.txt', 'one')).toEqual({ path: 'src/new.txt', size: 3 });
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('one');
    expect(service.writeFile(root, 'src/new.txt', 'two')).toEqual({ path: 'src/new.txt', size: 3 });
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('two');

    expect(service.makeDir(root, 'nested/a')).toEqual({ path: 'nested/a' });
    expect(existsSync(join(root, 'nested', 'a'))).toBe(true);
    expectBadRequest(() => service.makeDir(root, 'nested/a'));

    expect(service.rename(root, 'src/new.txt', 'nested/a/moved.txt')).toEqual({
      from: 'src/new.txt',
      to: 'nested/a/moved.txt',
    });
    expect(existsSync(join(root, 'src', 'new.txt'))).toBe(false);
    expect(readFileSync(join(root, 'nested', 'a', 'moved.txt'), 'utf8')).toBe('two');
    expectBadRequest(() => service.rename(root, 'README.md', 'nested/a/moved.txt'));
    expectBadRequest(() => service.rename(root, 'missing.txt', 'nested/a/nope.txt'));

    expect(service.deleteEntry(root, 'nested')).toEqual({ path: 'nested' });
    expect(existsSync(join(root, 'nested'))).toBe(false);
    expect(service.deleteEntry(root, 'README.md')).toEqual({ path: 'README.md' });
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });

  it('requires existing parent directories for file writes', () => {
    expectBadRequest(() => service.writeFile(root, 'missing/new.txt', 'nope'));
  });
});
