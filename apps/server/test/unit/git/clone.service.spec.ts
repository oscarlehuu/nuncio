import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import {
  buildCloneAuthHeader,
  CloneService,
  pickCloneDirName,
} from '../../../src/git/clone.service';
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
    // Default: no credential resolution (avoid shelling out to gh/glab in tests).
    // Individual tests override to assert credential injection.
    service.resolveToken = async () => null;
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

  it('creates the clone root when NUNCIO_CLONE_DIR does not exist yet (first-use regression)', async () => {
    // Point at a not-yet-existing parent — git clone would fail (git does not
    // mkdir parents), so the service must create the root before cloning.
    const freshRoot = join(cloneDir, 'nested', 'projects');
    process.env.NUNCIO_CLONE_DIR = freshRoot;
    expect(existsSync(freshRoot)).toBe(false);

    let parentExistedAtCloneTime = false;
    service.cloneExec = async (url, dest) => {
      void url;
      parentExistedAtCloneTime = existsSync(freshRoot);
      mkdirSync(join(dest, '.git'), { recursive: true });
    };
    service.remoteMatches = async () => true;
    service.resolveToken = async () => null;

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(parentExistedAtCloneTime).toBe(true);
    expect(result.path).toBe(join(freshRoot, 'nuncio'));
  });

  it('injects the resolved credential into the clone command without persisting it into the repo', async () => {
    service.resolveToken = async (forgeId) => (forgeId === 'github' ? 'ghp_secret' : null);
    let seenToken: string | null | undefined;
    service.cloneExec = async (url, dest, auth) => {
      seenToken = auth?.token ?? null;
      // A real credentialed clone must NOT write the token into the repo config
      // or the origin URL. Materialize a clean repo (token-free) as git would.
      mkdirSync(join(dest, '.git'), { recursive: true });
      writeFileSync(
        join(dest, '.git', 'config'),
        `[remote "origin"]\n\turl = https://github.com/octo/nuncio.git\n`,
      );
    };
    service.remoteMatches = async () => true;

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: true,
    });

    // The credential reached the command runner...
    expect(seenToken).toBe('ghp_secret');
    // ...but never landed in the cloned repo's persisted config.
    const config = readFileSync(join(result.path, '.git', 'config'), 'utf8');
    expect(config).not.toContain('ghp_secret');
    expect(config).not.toContain('extraheader');
    expect(config).not.toContain('Authorization');
  });

  it('clones a public repo without sending credentials first, even when a token resolves', async () => {
    service.resolveToken = async (forgeId) => (forgeId === 'github' ? 'ghp_secret' : null);
    const seenAuth: Array<string | null> = [];
    service.cloneExec = async (url, dest, auth) => {
      void url;
      seenAuth.push(auth?.token ?? null);
      mkdirSync(join(dest, '.git'), { recursive: true });
    };
    service.remoteMatches = async () => true;

    await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: false,
    });

    expect(seenAuth).toEqual([null]);
  });

  it('falls back to authenticated clone for a public repo only after plain clone fails', async () => {
    service.resolveToken = async (forgeId) => (forgeId === 'github' ? 'ghp_secret' : null);
    const seenAuth: Array<string | null> = [];
    service.cloneExec = async (url, dest, auth) => {
      void url;
      seenAuth.push(auth?.token ?? null);
      if (!auth) throw new BadRequestException('Repository not found');
      mkdirSync(join(dest, '.git'), { recursive: true });
    };
    service.remoteMatches = async () => true;

    await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: false,
    });

    expect(seenAuth).toEqual([null, 'ghp_secret']);
  });

  it('surfaces a friendly error when authenticated GitHub clone rejects credentials', async () => {
    service.resolveToken = async (forgeId) => (forgeId === 'github' ? 'ghp_secret' : null);
    service.cloneExec = async () => {
      throw new BadRequestException(
        "remote: invalid credentials\nfatal: Authentication failed for 'https://github.com/octo/nuncio.git/'",
      );
    };

    await expect(
      service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
        private: true,
      }),
    ).rejects.toThrow('GitHub token rejected - run gh auth login / check Settings');
  });
});

describe('CloneService.buildCloneArgs (credential non-persistence mechanics)', () => {
  it('passes the token via a one-shot -c http.extraheader (not a persisted config write)', () => {
    const { buildCloneArgs } = require('../../../src/git/clone.service') as typeof import('../../../src/git/clone.service');
    const args = buildCloneArgs('https://github.com/octo/nuncio.git', '/dest/nuncio', {
      forgeId: 'github',
      token: 'ghp_secret',
    });

    // -c is an ephemeral per-invocation override; `git config` would persist. The
    // header carries the token, and it precedes the `clone` subcommand.
    const cIndex = args.indexOf('-c');
    expect(cIndex).toBeGreaterThanOrEqual(0);
    expect(args[cIndex + 1]).toContain('http.extraheader=');
    expect(args[cIndex + 1]).toContain('Authorization:');
    expect(args).not.toContain('config'); // never `git config ...` (that persists)
    expect(args.indexOf('clone')).toBeGreaterThan(cIndex); // -c before the subcommand
  });

  it('formats GitHub clone auth as basic x-access-token credentials', () => {
    const header = buildCloneAuthHeader('github', 'ghp_secret');
    expect(header).toBe('Authorization: basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==');
  });

  it('formats GitLab clone auth as basic oauth2 credentials', () => {
    const header = buildCloneAuthHeader('gitlab', 'glpat-secret');
    expect(header).toBe('Authorization: basic b2F1dGgyOmdscGF0LXNlY3JldA==');
  });

  it('omits credentials entirely when no token is resolved', () => {
    const { buildCloneArgs } = require('../../../src/git/clone.service') as typeof import('../../../src/git/clone.service');
    const args = buildCloneArgs('https://github.com/octo/pub.git', '/dest/pub', null);
    expect(args).not.toContain('-c');
    expect(args.join(' ')).not.toContain('extraheader');
    expect(args).toEqual(['clone', 'https://github.com/octo/pub.git', '/dest/pub']);
  });
});
