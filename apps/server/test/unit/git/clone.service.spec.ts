import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('preserves a Unicode repository name as one path segment', () => {
    expect(pickCloneDirName('répo工具', () => false)).toBe('répo工具');
  });

  it('uses -999 as the last candidate and fails after exactly 999 occupied names', () => {
    const first998 = new Set(['nuncio', ...Array.from({ length: 997 }, (_, index) => `nuncio-${index + 2}`)]);
    expect(pickCloneDirName('nuncio', (name) => first998.has(name))).toBe('nuncio-999');

    first998.add('nuncio-999');
    expect(() => pickCloneDirName('nuncio', (name) => first998.has(name))).toThrow(
      'Too many existing clones named nuncio',
    );
  });

  it('rejects a repo name that would escape the clone dir', () => {
    expect(() => pickCloneDirName('../evil', () => false)).toThrow(BadRequestException);
    expect(() => pickCloneDirName('a/b', () => false)).toThrow(BadRequestException);
    expect(() => pickCloneDirName('', () => false)).toThrow(BadRequestException);
  });
});

describe('CloneService', () => {
  const testProcessStart = 'test-process-start';
  const reservationFileName = 'reservation.json';
  const reservationWorktreeName = 'checkout';
  const reclaimLeaseName = '.reclaiming';

  let module: TestingModule;
  let service: CloneService;
  let recent: RecentProjectsRepository;
  let settings: SettingsService;
  let defaultProcessStartTimeLookup: CloneService['processStartTimeLookup'];
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
    // Default: no credential/process shelling in tests. Individual tests override
    // these seams to assert credential and cross-process ownership behavior.
    service.resolveToken = async () => null;
    defaultProcessStartTimeLookup = service.processStartTimeLookup;
    service.processStartTimeLookup = async (pid) => (pid === process.pid ? testProcessStart : null);
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

  function reservationMarker(dirName: string): string {
    return join(cloneDir, `.${dirName}.nuncio-clone-reservation`);
  }

  function seedReservation(
    dirName: string,
    options: {
      pid?: number;
      processStartTime?: string;
      cloneUrl?: string;
      reservationId?: string;
      partial?: string;
    } = {},
  ): string {
    const marker = reservationMarker(dirName);
    mkdirSync(marker, { recursive: true });
    writeFileSync(
      join(marker, reservationFileName),
      JSON.stringify({
        schemaVersion: 1,
        reservationId: options.reservationId ?? `reservation-${dirName}`,
        pid: options.pid ?? 987_654_321,
        processStartTime: options.processStartTime ?? 'dead-process-start',
        createdAtMs: 1_700_000_000_000,
        leaseUpdatedAtMs: 1_700_000_000_000,
        destinationName: dirName,
        cloneUrlHash: createHash('sha256')
          .update(options.cloneUrl ?? 'https://github.com/octo/nuncio.git')
          .digest('hex'),
      }),
    );
    if (options.partial !== undefined) {
      const worktree = join(marker, reservationWorktreeName);
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, 'partial'), options.partial);
    }
    return marker;
  }

  function seedReclaimLease(
    marker: string,
    options: {
      pid?: number;
      processStartTime?: string;
      cloneUrl?: string;
      reservationId?: string;
      destinationName?: string;
      createdAtMs?: number;
      leaseUpdatedAtMs?: number;
    } = {},
  ): string {
    const dir = join(marker, reclaimLeaseName);
    const destinationName = options.destinationName
      ?? JSON.parse(readFileSync(join(marker, reservationFileName), 'utf8')).destinationName as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, reservationFileName),
      JSON.stringify({
        schemaVersion: 1,
        reservationId: options.reservationId ?? `reclaimer-${destinationName}`,
        pid: options.pid ?? 876_543_210,
        processStartTime: options.processStartTime ?? 'dead-reclaimer-start',
        createdAtMs: options.createdAtMs ?? 1_700_000_000_100,
        leaseUpdatedAtMs: options.leaseUpdatedAtMs ?? 1_700_000_000_100,
        destinationName,
        cloneUrlHash: createHash('sha256')
          .update(options.cloneUrl ?? 'https://github.com/octo/nuncio.git')
          .digest('hex'),
      }),
    );
    return dir;
  }

  async function runReclaimerCrash(ownerPid: number, round: number): Promise<number> {
    const scriptPath = join(dataDir, `clone-reclaimer-crash-${round}.ts`);
    const cloneServiceUrl = pathToFileURL(
      join(__dirname, '../../../src/git/clone.service.ts'),
    ).href;
    writeFileSync(scriptPath, `
      import { CloneService } from ${JSON.stringify(cloneServiceUrl)};

      const cloneDir = process.argv[2]!;
      const ownerPid = Number(process.argv[3]);
      const service = new CloneService(
        { resolve: (key: string) => key === 'NUNCIO_CLONE_DIR' ? cloneDir : null } as never,
        { record: (_path: string) => undefined } as never,
      );
      let ownerChecks = 0;
      service.resolveToken = async () => null;
      service.processStartTimeLookup = async (pid) => {
        if (pid === process.pid) return \`crash-child-start-\${process.pid}\`;
        if (pid === ownerPid) {
          ownerChecks += 1;
          if (ownerChecks === 2) process.exit(86);
        }
        return null;
      };
      service.cloneExec = async () => process.exit(87);
      await service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      });
      process.exit(88);
    `);

    const child = Bun.spawn(['bun', scriptPath, cloneDir, String(ownerPid)], {
      cwd: join(__dirname, '../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code !== 86) {
      throw new Error(`reclaimer crash child exited ${code}: ${stderr.trim()}`);
    }
    return child.pid;
  }

  function runGit(args: string[], cwd?: string): string {
    const result = Bun.spawnSync(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || `git ${args.join(' ')} failed`);
    }
    return result.stdout.toString().trim();
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

  it('reads a stable OS process-start identity for the current process', async () => {
    const first = await defaultProcessStartTimeLookup(process.pid);
    const second = await defaultProcessStartTimeLookup(process.pid);

    expect(typeof first).toBe('string');
    expect(first).toBe(second);
  });

  it('stores verifiable owner metadata before cloning and publishes from the reserved workspace', async () => {
    let observedMarker = '';
    service.cloneExec = async (url, cloneDest) => {
      observedMarker = dirname(cloneDest);
      const serializedMetadata = readFileSync(
        join(observedMarker, reservationFileName),
        'utf8',
      );
      const metadata = JSON.parse(serializedMetadata) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        schemaVersion: 1,
        pid: process.pid,
        processStartTime: testProcessStart,
        destinationName: 'nuncio',
        cloneUrlHash: createHash('sha256').update(url).digest('hex'),
      });
      expect(serializedMetadata).not.toContain(url);
      expect(typeof metadata.reservationId).toBe('string');
      expect(Number.isFinite(metadata.createdAtMs)).toBe(true);
      expect(Number.isFinite(metadata.leaseUpdatedAtMs)).toBe(true);
      expect(cloneDest).toBe(join(observedMarker, reservationWorktreeName));
      mkdirSync(join(cloneDest, '.git'), { recursive: true });
    };

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(join(result.path, '.git'))).toBe(true);
    expect(existsSync(observedMarker)).toBe(false);
  });

  it('publishes a real git clone from the marker-owned workspace', async () => {
    const source = join(dataDir, 'réal-source');
    mkdirSync(source);
    runGit(['init'], source);
    runGit(['config', 'user.email', 'clone-test@nuncio.local'], source);
    runGit(['config', 'user.name', 'Clone Test'], source);
    writeFileSync(join(source, 'README.md'), 'real clone\n');
    runGit(['add', 'README.md'], source);
    runGit(['commit', '-m', 'initial'], source);

    const result = await service.clone({
      forgeId: 'local',
      fullName: 'local/réal-checkout',
      cloneUrl: source,
    });

    expect(result.path).toBe(join(cloneDir, 'réal-checkout'));
    expect(readFileSync(join(result.path, 'README.md'), 'utf8')).toBe('real clone\n');
    expect(runGit(['rev-parse', '--is-inside-work-tree'], result.path)).toBe('true');
    expect(existsSync(reservationMarker('réal-checkout'))).toBe(false);
  });

  it('reuses a completed matching natural checkout after its owner dies before marker cleanup', async () => {
    const existing = join(cloneDir, 'nuncio');
    mkdirSync(join(existing, '.git'), { recursive: true });
    writeFileSync(join(existing, 'owner'), 'completed');
    const marker = seedReservation('nuncio');
    let cloneCalls = 0;
    service.cloneExec = async () => {
      cloneCalls += 1;
    };
    service.remoteMatches = async (dir, url) =>
      dir === existing && url === 'https://github.com/octo/nuncio.git';

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(existing);
    expect(cloneCalls).toBe(0);
    expect(readFileSync(join(existing, 'owner'), 'utf8')).toBe('completed');
    expect(existsSync(marker)).toBe(false);
  });

  it('reclaims a dead owner partial workspace and clones at the natural name', async () => {
    const marker = seedReservation('nuncio', { partial: 'interrupted-clone' });
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(join(result.path, '.git'))).toBe(true);
    expect(existsSync(join(result.path, 'partial'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('reclaims a stale reclaimer lease and clones at the natural name', async () => {
    const marker = seedReservation('nuncio', { partial: 'interrupted-clone' });
    seedReclaimLease(marker);
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(join(result.path, '.git'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves a live reclaimer lease and selects -2', async () => {
    const marker = seedReservation('nuncio', { partial: 'stale-owner' });
    const lease = seedReclaimLease(marker, {
      pid: 42_425,
      processStartTime: 'live-reclaimer-start',
    });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_425) return 'live-reclaimer-start';
      return null;
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(existsSync(lease)).toBe(true);
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'stale-owner',
    );
  });

  it('preserves a reclaimer lease when process ownership lookup fails', async () => {
    const marker = seedReservation('nuncio', { partial: 'unknown-reclaimer' });
    const lease = seedReclaimLease(marker, { pid: 42_427 });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_427) throw new Error('process table unavailable');
      return null;
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(existsSync(lease)).toBe(true);
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'unknown-reclaimer',
    );
  });

  it('reclaims a reclaimer lease when its PID was reused', async () => {
    const marker = seedReservation('nuncio', { partial: 'stale-owner' });
    seedReclaimLease(marker, {
      pid: 42_425,
      processStartTime: 'old-reclaimer-start',
    });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_425) return 'reused-reclaimer-start';
      return null;
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves malformed reclaimer metadata because its ownership is unprovable', async () => {
    const marker = seedReservation('nuncio', { partial: 'stale-owner' });
    const lease = join(marker, reclaimLeaseName);
    mkdirSync(lease);
    writeFileSync(join(lease, reservationFileName), '{not-json');
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'stale-owner',
    );
    expect(readFileSync(join(lease, reservationFileName), 'utf8')).toBe('{not-json');
  });

  it('treats invalid reclaimer PID and lease chronology as unprovable', async () => {
    const zeroPidMarker = seedReservation('nuncio', { partial: 'zero-pid-reclaimer' });
    seedReclaimLease(zeroPidMarker, { pid: 0 });
    const invalidLeaseMarker = seedReservation('nuncio-2', { partial: 'invalid-lease-reclaimer' });
    seedReclaimLease(invalidLeaseMarker, {
      createdAtMs: 1_700_000_000_200,
      leaseUpdatedAtMs: 1_700_000_000_100,
    });
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-3'));
    expect(readFileSync(join(zeroPidMarker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'zero-pid-reclaimer',
    );
    expect(readFileSync(join(invalidLeaseMarker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'invalid-lease-reclaimer',
    );
  });

  it('recovers the natural name after two real reclaimer processes crash', async () => {
    const originalOwnerPid = 987_654_321;
    const marker = seedReservation('nuncio', {
      pid: originalOwnerPid,
      partial: 'interrupted-clone',
    });

    const firstReclaimerPid = await runReclaimerCrash(originalOwnerPid, 1);
    expect(
      JSON.parse(readFileSync(join(marker, reclaimLeaseName, reservationFileName), 'utf8')).pid,
    ).toBe(firstReclaimerPid);

    const secondReclaimerPid = await runReclaimerCrash(originalOwnerPid, 2);
    expect(
      JSON.parse(readFileSync(join(marker, reclaimLeaseName, reservationFileName), 'utf8')).pid,
    ).toBe(secondReclaimerPid);

    stubCloneWritingRepo('https://github.com/octo/nuncio.git');
    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(cloneDir).some((name) => name.includes('nuncio-2'))).toBe(false);
  });

  it('serializes two reclaimers racing one stale lease before publication', async () => {
    const marker = seedReservation('nuncio', { partial: 'interrupted-clone' });
    const staleReclaimerPid = 42_426;
    seedReclaimLease(marker, { pid: staleReclaimerPid });

    let releaseStaleLookups!: () => void;
    const bothSawStaleLease = new Promise<void>((resolve) => {
      releaseStaleLookups = resolve;
    });
    let staleLookups = 0;
    const lookup: CloneService['processStartTimeLookup'] = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === staleReclaimerPid) {
        staleLookups += 1;
        if (staleLookups === 2) releaseStaleLookups();
        await bothSawStaleLease;
      }
      return null;
    };

    const contender = new CloneService(settings, recent);
    service.processStartTimeLookup = lookup;
    contender.processStartTimeLookup = lookup;
    contender.resolveToken = async () => null;
    const materializeClone: CloneService['cloneExec'] = async (url, dest) => {
      void url;
      mkdirSync(join(dest, '.git'), { recursive: true });
      writeFileSync(join(dest, 'owner'), dest);
    };
    service.cloneExec = materializeClone;
    contender.cloneExec = materializeClone;

    const results = await Promise.all([
      service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      }),
      contender.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      }),
    ]);

    expect(new Set(results.map((result) => result.path))).toEqual(
      new Set([join(cloneDir, 'nuncio'), join(cloneDir, 'nuncio-2')]),
    );
    const publishedOwners = results.map((result) =>
      readFileSync(join(result.path, 'owner'), 'utf8'));
    expect(new Set(publishedOwners).size).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it('reuses a completed checkout behind a stale reclaimer lease', async () => {
    const existing = join(cloneDir, 'nuncio');
    mkdirSync(join(existing, '.git'), { recursive: true });
    writeFileSync(join(existing, 'owner'), 'completed');
    const marker = seedReservation('nuncio');
    seedReclaimLease(marker);
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
    expect(readFileSync(join(existing, 'owner'), 'utf8')).toBe('completed');
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves a live other-process reservation and selects -2', async () => {
    const marker = seedReservation('nuncio', {
      pid: 42_424,
      processStartTime: 'other-live-start',
      partial: 'live-owner',
    });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_424) return 'other-live-start';
      return null;
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'live-owner',
    );
    expect(existsSync(marker)).toBe(true);
  });

  it('reclaims a reservation when the PID was reused with a different process start', async () => {
    const marker = seedReservation('nuncio', {
      pid: 42_424,
      processStartTime: 'old-process-start',
      partial: 'old-owner',
    });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_424) return 'reused-process-start';
      return null;
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(result.path, 'partial'))).toBe(false);
  });

  it('preserves malformed reservations because their owner cannot be proved stale', async () => {
    const marker = reservationMarker('nuncio');
    mkdirSync(join(marker, reservationWorktreeName), { recursive: true });
    writeFileSync(join(marker, reservationFileName), '{not-json');
    writeFileSync(join(marker, reservationWorktreeName, 'partial'), 'unknown-owner');
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'unknown-owner',
    );
    expect(existsSync(marker)).toBe(true);
  });

  it('treats non-positive PIDs and invalid lease timestamps as unprovable', async () => {
    const zeroPidMarker = seedReservation('nuncio', {
      pid: 0,
      partial: 'zero-pid-owner',
    });
    const invalidLeaseMarker = seedReservation('nuncio-2', {
      partial: 'invalid-lease-owner',
    });
    const invalidLeasePath = join(invalidLeaseMarker, reservationFileName);
    const invalidLease = JSON.parse(readFileSync(invalidLeasePath, 'utf8')) as Record<string, unknown>;
    invalidLease.leaseUpdatedAtMs = null;
    writeFileSync(invalidLeasePath, JSON.stringify(invalidLease));
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-3'));
    expect(readFileSync(join(zeroPidMarker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'zero-pid-owner',
    );
    expect(readFileSync(join(invalidLeaseMarker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'invalid-lease-owner',
    );
  });

  it('fails closed when process ownership lookup cannot verify a reservation', async () => {
    const marker = seedReservation('nuncio', {
      pid: 42_424,
      processStartTime: 'unknown-owner-start',
      partial: 'unknown-owner',
    });
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      throw new Error('process table unavailable');
    };
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(readFileSync(join(marker, reservationWorktreeName, 'partial'), 'utf8')).toBe(
      'unknown-owner',
    );
    expect(existsSync(marker)).toBe(true);
  });

  it('removes a stale marker but never removes an unrelated checkout', async () => {
    const unrelated = join(cloneDir, 'nuncio');
    mkdirSync(join(unrelated, '.git'), { recursive: true });
    writeFileSync(join(unrelated, 'owner'), 'unrelated-checkout');
    const staleMarker = seedReservation('nuncio');
    service.remoteMatches = async () => false;
    stubCloneWritingRepo('https://github.com/octo/nuncio.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio-2'));
    expect(readFileSync(join(unrelated, 'owner'), 'utf8')).toBe('unrelated-checkout');
    expect(existsSync(staleMarker)).toBe(false);
  });

  it('does not overwrite a checkout that appears before publication', async () => {
    const unrelated = join(cloneDir, 'nuncio');
    service.cloneExec = async (url, cloneDest) => {
      void url;
      mkdirSync(join(cloneDest, '.git'), { recursive: true });
      writeFileSync(join(cloneDest, 'owner'), 'completed-clone');

      mkdirSync(join(unrelated, '.git'), { recursive: true });
      writeFileSync(join(unrelated, 'owner'), 'other-process');
    };

    await expect(
      service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      }),
    ).rejects.toThrow('Clone destination became occupied');

    expect(readFileSync(join(unrelated, 'owner'), 'utf8')).toBe('other-process');
    expect(existsSync(reservationMarker('nuncio'))).toBe(false);
  });

  it('recovers the natural name across repeated interrupted reservations', async () => {
    for (let round = 1; round <= 3; round += 1) {
      const marker = seedReservation('nuncio', {
        reservationId: `interrupted-${round}`,
        partial: `partial-${round}`,
      });
      service.cloneExec = async (url, cloneDest) => {
        void url;
        mkdirSync(join(cloneDest, '.git'), { recursive: true });
        writeFileSync(join(cloneDest, 'round'), String(round));
      };

      const result = await service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      });

      expect(result.path).toBe(join(cloneDir, 'nuncio'));
      expect(readFileSync(join(result.path, 'round'), 'utf8')).toBe(String(round));
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(cloneDir).some((name) => name.includes('nuncio-2'))).toBe(false);

      if (round < 3) rmSync(result.path, { recursive: true, force: true });
    }
  });

  it('recovers a stale Unicode reservation without changing the destination name', async () => {
    const marker = seedReservation('répo工具', {
      cloneUrl: 'https://github.com/octo/répo工具.git',
      partial: 'interrompu',
    });
    stubCloneWritingRepo('https://github.com/octo/répo工具.git');

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/répo工具',
      cloneUrl: 'https://github.com/octo/répo工具.git',
    });

    expect(result.path).toBe(join(cloneDir, 'répo工具'));
    expect(existsSync(join(result.path, '.git'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails after 999 live reservations without removing any owner marker', async () => {
    service.processStartTimeLookup = async (pid) => {
      if (pid === process.pid) return testProcessStart;
      if (pid === 42_424) return 'other-live-start';
      return null;
    };
    const names = ['nuncio', ...Array.from({ length: 998 }, (_, index) => `nuncio-${index + 2}`)];
    for (const name of names) {
      seedReservation(name, {
        pid: 42_424,
        processStartTime: 'other-live-start',
        reservationId: `live-${name}`,
      });
    }
    let cloneCalls = 0;
    service.cloneExec = async () => {
      cloneCalls += 1;
    };

    await expect(
      service.clone({
        forgeId: 'github',
        fullName: 'octo/nuncio',
        cloneUrl: 'https://github.com/octo/nuncio.git',
      }),
    ).rejects.toThrow('Too many existing clones named nuncio');

    expect(cloneCalls).toBe(0);
    expect(names.every((name) => existsSync(reservationMarker(name)))).toBe(true);
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

  it('keeps exclusive destination ownership across a public authenticated retry', async () => {
    service.resolveToken = async () => 'ghp_secret';
    let reservedCloneDest = '';

    service.cloneExec = async (url, dest, auth) => {
      void url;
      if (!auth) {
        reservedCloneDest = dest;
        writeFileSync(join(dest, 'anonymous-partial'), 'partial');
        throw new BadRequestException('Repository not found');
      }

      expect(dest).toBe(reservedCloneDest);
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(join(dest, 'anonymous-partial'))).toBe(false);
      mkdirSync(join(dest, '.git'), { recursive: true });
      writeFileSync(join(dest, 'owner'), 'authenticated');
    };

    const result = await service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: false,
    });

    expect(result.path).toBe(join(cloneDir, 'nuncio'));
    expect(existsSync(reservedCloneDest)).toBe(false);
    expect(readFileSync(join(result.path, 'owner'), 'utf8')).toBe('authenticated');
  });

  it('gives concurrent public clones exclusive destinations and cleans only the failed owner', async () => {
    let releaseCandidateGate!: () => void;
    const bothCandidatesSelected = new Promise<void>((resolve) => {
      releaseCandidateGate = resolve;
    });
    const initialCandidates: string[] = [];
    service.beforeDestinationReservation = async (dest) => {
      if (initialCandidates.length >= 2) return;
      initialCandidates.push(dest);
      if (initialCandidates.length === 2) releaseCandidateGate();
      await bothCandidatesSelected;
    };

    let releaseBothExecs!: () => void;
    const bothExecuting = new Promise<void>((resolve) => {
      releaseBothExecs = resolve;
    });
    let markSuccessReady!: () => void;
    const successReady = new Promise<void>((resolve) => {
      markSuccessReady = resolve;
    });
    const attempts: Array<{ url: string; cloneDest: string; finalDest: string }> = [];

    service.cloneExec = async (url, dest, auth) => {
      expect(auth).toBeNull();
      const metadata = JSON.parse(
        readFileSync(join(dirname(dest), reservationFileName), 'utf8'),
      ) as { destinationName: string };
      attempts.push({
        url,
        cloneDest: dest,
        finalDest: join(cloneDir, metadata.destinationName),
      });
      if (attempts.length === 2) releaseBothExecs();
      await bothExecuting;

      if (url.includes('/success.git')) {
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(join(dest, 'owner'), 'success');
        markSuccessReady();
        return;
      }

      await successReady;
      writeFileSync(join(dest, 'failed-partial'), 'failure');
      throw new BadRequestException('public clone failed');
    };

    const successfulClone = service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/success.git',
      private: false,
    });
    const failedClone = service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/failure.git',
      private: false,
    });

    const [success, failure] = await Promise.allSettled([successfulClone, failedClone]);
    expect(success.status).toBe('fulfilled');
    expect(failure.status).toBe('rejected');
    expect(initialCandidates).toHaveLength(2);
    expect(new Set(initialCandidates).size).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.cloneDest)).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt.finalDest)).size).toBe(2);

    const successDest = attempts.find((attempt) => attempt.url.includes('/success.git'))!.finalDest;
    const failedAttempt = attempts.find((attempt) => attempt.url.includes('/failure.git'))!;
    expect(readFileSync(join(successDest, 'owner'), 'utf8')).toBe('success');
    expect(existsSync(join(successDest, 'failed-partial'))).toBe(false);
    expect(existsSync(failedAttempt.cloneDest)).toBe(false);
    expect(existsSync(failedAttempt.finalDest)).toBe(false);
    expect(readdirSync(cloneDir).some((name) => name.includes('nuncio-clone-reservation'))).toBe(false);
  });

  it('cleans its reserved destination when public token resolution fails', async () => {
    const dest = join(cloneDir, 'nuncio');
    service.cloneExec = async (url, cloneDest, auth) => {
      void url;
      expect(auth).toBeNull();
      writeFileSync(join(cloneDest, 'anonymous-partial'), 'failure');
      throw new BadRequestException('plain clone failed');
    };
    service.resolveToken = async () => {
      throw new Error('credential lookup unavailable');
    };

    await expect(service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: false,
    })).rejects.toThrow('credential lookup unavailable');

    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(cloneDir).some((name) => name.includes('nuncio-clone-reservation'))).toBe(false);
  });

  it('removes only its reserved destination after an authenticated clone fails', async () => {
    service.resolveToken = async () => 'ghp_secret';
    const dest = join(cloneDir, 'nuncio');
    service.cloneExec = async (url, cloneDest) => {
      void url;
      mkdirSync(join(cloneDest, '.git'), { recursive: true });
      writeFileSync(join(cloneDest, 'partial'), 'failure');
      throw new BadRequestException('network failed');
    };

    await expect(service.clone({
      forgeId: 'github',
      fullName: 'octo/nuncio',
      cloneUrl: 'https://github.com/octo/nuncio.git',
      private: true,
    })).rejects.toThrow('network failed');

    expect(existsSync(dest)).toBe(false);
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
