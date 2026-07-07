import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { CloneService, pickCloneDirName } from '../../../src/git/clone.service';
import { RecentProjectsRepository } from '../../../src/git/recent-projects.repository';

describe('pickCloneDirName', () => {
  it('uses the repo name when the directory is free', () => {
    expect(pickCloneDirName('nuncio', () => false)).toBe('nuncio');
  });

  it('bumps to -2, -3 on collision', () => {
    const taken = new Set(['nuncio', 'nuncio-2']);
    expect(pickCloneDirName('nuncio', (name) => taken.has(name))).toBe('nuncio-3');
  });

  it('rejects a repo name that would escape the clone dir', () => {
    expect(() => pickCloneDirName('../evil', () => false)).toThrow(BadRequestException);
    expect(() => pickCloneDirName('a/b', () => false)).toThrow(BadRequestException);
    expect(() => pickCloneDirName('', () => false)).toThrow(BadRequestException);
  });
});

describe('CloneService', () => {
  let module: TestingModule;
  let service: CloneService;
  let recent: RecentProjectsRepository;
  let settings: SettingsService;
  let dataDir: string;
  let cloneDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-clone-'));
    cloneDir = mkdtempSync(join(tmpdir(), 'nuncio-clone-target-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_CLONE_DIR = cloneDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule],
      providers: [CloneService, RecentProjectsRepository],
    }).compile();

    service = module.get(CloneService);
    recent = module.get(RecentProjectsRepository);
    settings = module.get(SettingsService);
    void settings;
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CLONE_DIR;
  });

  /** Stub the git clone by materializing a fake repo at the target dir. */
  function stubCloneWritingRepo(remote: string) {
    service.cloneExec = async (url, dest) => {
      void url;
      mkdirSync(join(dest, '.git'), { recursive: true });
      writeFileSync(join(dest, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
    };
  }

  it('clones into NUNCIO_CLONE_DIR/<repo-name> and records recent', async () => {
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');
    service.remoteMatches = async () => true;

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(recent.list().some((r) => r.path === result.path)).toBe(true);
  });

  it('bumps the dir name on collision with an unrelated existing directory', async () => {
    // Pre-create a directory occupying the natural name.
    mkdirSync(join(cloneDir, 'nuncio'), { recursive: true });
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');
    service.remoteMatches = async () => true;

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
  });

  it('is idempotent: an already-cloned matching repo returns the existing path (no re-clone)', async () => {
    // Materialize an existing clone at the natural name with a matching remote.
    const existing = join(cloneDir, 'nuncio');
    mkdirSync(join(existing, '.git'), { recursive: true });
    let cloneCalls = 0;
    service.cloneExec = async () => {
      cloneCalls += 1;
    };
    service.remoteMatches = async (dir) => dir === existing;

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(existing);
    expect(cloneCalls).toBe(0);
    expect(recent.list().some((r) => r.path === existing)).toBe(true);
  });

  it('rejects a missing cloneUrl or fullName', async () => {
    await expect(
      service.clone({ forgeId: 'github', fullName: 'octo/nuncio', cloneUrl: '' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.clone({ forgeId: 'github', fullName: '', cloneUrl: 'https://x/y.git' }),
    ).rejects.toThrow(BadRequestException);
  });
});
