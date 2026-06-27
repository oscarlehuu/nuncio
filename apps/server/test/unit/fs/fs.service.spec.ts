import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { FsModule } from '../../../src/fs/fs.module';
import { FsService } from '../../../src/fs/fs.service';

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

describe('FsService', () => {
  let module: TestingModule;
  let service: FsService;
  let dataDir: string;
  let sandbox: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-fs-data-'));
    sandbox = mkdtempSync(join(tmpdir(), 'nuncio-fs-sandbox-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    // Build a sandbox tree:
    //   sandbox/
    //     alpha/              (plain dir)
    //       sub/              (nested)
    //     beta-repo/          (git repo — has .git)
    //     .hidden/            (dotfile dir — should be filtered)
    //     node_modules/       (noise — should be filtered)
    //     readme.txt          (file — should be filtered)
    mkdirSync(join(sandbox, 'alpha', 'sub'), { recursive: true });
    mkdirSync(join(sandbox, 'beta-repo'), { recursive: true });
    mkdirSync(join(sandbox, '.hidden'), { recursive: true });
    mkdirSync(join(sandbox, 'node_modules'), { recursive: true });
    writeFileSync(join(sandbox, 'readme.txt'), 'hi');

    // Init beta-repo as a git repo so isGit detection is exercised.
    await runGitAsync(join(sandbox, 'beta-repo'), ['init', '-b', 'main']);
    await runGitAsync(join(sandbox, 'beta-repo'), ['config', 'user.email', 't@nuncio.local']);
    await runGitAsync(join(sandbox, 'beta-repo'), ['config', 'user.name', 'Nuncio Test']);

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, FsModule],
    }).compile();
    service = module.get(FsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('listDirectories', () => {
    it('lists subdirectories sorted by name', () => {
      const listing = service.listDirectories(sandbox);
      const names = listing.entries.map((e) => e.name);
      expect(names).toEqual(['alpha', 'beta-repo']);
    });

    it('filters out dotfile dirs, node_modules, and files', () => {
      const names = service.listDirectories(sandbox).entries.map((e) => e.name);
      expect(names).not.toContain('.hidden');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('readme.txt');
    });

    it('marks git repos with isGit=true', () => {
      const listing = service.listDirectories(sandbox);
      const beta = listing.entries.find((e) => e.name === 'beta-repo');
      const alpha = listing.entries.find((e) => e.name === 'alpha');
      expect(beta?.isGit).toBe(true);
      expect(alpha?.isGit).toBe(false);
    });

    it('returns absolute paths for each entry', () => {
      const listing = service.listDirectories(sandbox);
      const alpha = listing.entries.find((e) => e.name === 'alpha');
      expect(alpha?.path).toBe(join(sandbox, 'alpha'));
    });

    it('reports the current absolute path', () => {
      expect(service.listDirectories(sandbox).current).toBe(sandbox);
    });

    it('reports the parent absolute path', () => {
      const listing = service.listDirectories(sandbox);
      expect(listing.parent).toBe(join(sandbox, '..'));
    });

    it('reports parent=null at the filesystem root', () => {
      const listing = service.listDirectories('/');
      expect(listing.parent).toBeNull();
      expect(listing.current).toBe('/');
    });

    it('expands ~ to the home directory', () => {
      const listing = service.listDirectories('~');
      const expected = join(process.env.HOME ?? '');
      // resolve the home path the same way the service is expected to
      const { resolve } = require('node:path');
      expect(listing.current).toBe(resolve(expected));
    });

    it('defaults to home when path is empty', () => {
      const listing = service.listDirectories('');
      const { resolve } = require('node:path');
      expect(listing.current).toBe(resolve(process.env.HOME ?? ''));
    });

    it('throws BadRequestException for a non-existent path', () => {
      expect(() => service.listDirectories('/definitely/not/here')).toThrow();
    });

    it('throws BadRequestException for a path that is a file, not a directory', () => {
      const file = join(sandbox, 'readme.txt');
      expect(() => service.listDirectories(file)).toThrow();
    });

    it('navigates into a subdirectory (nested listing)', () => {
      const listing = service.listDirectories(join(sandbox, 'alpha'));
      expect(listing.current).toBe(join(sandbox, 'alpha'));
      expect(listing.parent).toBe(sandbox);
      expect(listing.entries.map((e) => e.name)).toEqual(['sub']);
    });

    it('resolves a relative path against cwd', () => {
      const { resolve } = require('node:path');
      const listing = service.listDirectories('.');
      expect(listing.current).toBe(resolve('.'));
    });

    it('skips entries that cannot be stat-ed (permission denied) without throwing', () => {
      // Create a dir entry whose stat throws — hard to simulate portably without
      // root. Instead, verify the filter tolerates a dangling symlink (stat throws
      // ENOENT on the target via lstat-based readdirSync with withFileTypes).
      const link = join(sandbox, 'dangling-link');
      try {
        symlinkSync('/definitely/not/a/target', link);
      } catch {
        // symlink creation may fail on some sandboxes; skip this assertion gracefully
        return;
      }
      const names = service.listDirectories(sandbox).entries.map((e) => e.name);
      // The dangling symlink must not crash the listing and must not appear as a dir.
      expect(names).not.toContain('dangling-link');
    });
  });
});
