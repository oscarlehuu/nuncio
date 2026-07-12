import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CrewCommandRunner } from '../../../src/crew/crew-command.runner';
import { projectCrewDependencies } from '../../../src/crew/crew-dependency-projection';
import { CrewVerifierService } from '../../../src/crew/crew-verifier.service';

const boundary = {
  canonicalPath: '/repo', exists: true, symlink: false, branch: 'crew/run',
  fullHead: 'a'.repeat(40), clean: true, reachable: true,
};
const stored = { artifact: { id: 'artifact-1' }, preview: 'bounded', truncated: true };

describe('Crew verification workspace', () => {
  it('verifies the exact committed snapshot and discards ignored writes outside the canonical worktree', async () => {
    const repo = createGitRepository();
    const ignoredSource = join(repo.path, 'canonical-only.txt');
    const ignoredOutput = join(repo.path, 'generated.txt');
    writeFileSync(ignoredSource, 'canonical-only');
    let executedCwd = '';
    const commandRunner = new CrewCommandRunner();
    const runner = { run: async (...args: Parameters<CrewCommandRunner['run']>) => {
      executedCwd = args[1];
      return commandRunner.run(...args);
    } };
    const exactBoundary = {
      ...boundary, canonicalPath: repo.path, fullHead: repo.head, branch: 'main',
    };
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => exactBoundary } as never,
      runner as never,
      { writeLog: () => stored } as never,
    );

    try {
      const result = await verifier.verify({
        runId: 'run-exact', cwd: repo.path, expectedHead: repo.head, expectedBranch: 'main',
        command: [
          'test ! -e canonical-only.txt',
          'test ! -r original-source',
          'test "$(cat tracked.txt)" = frozen',
          'printf generated > generated.txt',
        ].join(' && '),
      });

      expect(result.passed).toBe(true);
      expect(executedCwd).not.toBe(repo.path);
      expect(existsSync(executedCwd)).toBe(false);
      expect(readFileSync(ignoredSource, 'utf8')).toBe('canonical-only');
      expect(existsSync(ignoredOutput)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('reuses installed dependencies offline while workspace packages resolve from the frozen snapshot', async () => {
    const fixture = createDependencyRepository();
    const exactBoundary = {
      ...boundary, canonicalPath: fixture.worktree, fullHead: fixture.head, branch: null,
    };
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => exactBoundary } as never,
      new CrewCommandRunner(),
      { writeLog: () => stored } as never,
    );

    try {
      const result = await verifier.verify({
        runId: 'run-dependencies', cwd: fixture.worktree, expectedHead: fixture.head,
        command: [
          'cd apps/app',
          'test "$(node_modules/.bin/fake)" = installed-cli',
          'if printf tamper > node_modules/fake/index.js; then exit 9; fi',
          'bun check.mjs',
        ].join(' && '),
      });

      expect(result).toMatchObject({ passed: true, exitCode: 0, spawnError: null });
      expect(readFileSync(join(fixture.main, 'packages/local/index.js'), 'utf8')).toContain('host-source');
      expect(readFileSync(
        join(fixture.main, 'node_modules/.bun/fake@1.0.0/node_modules/fake/index.js'), 'utf8',
      )).toContain('installed-dependency');
    } finally {
      fixture.cleanup();
    }
  });

  it('maps absolute workspace dependency links into the Linux disposable mount', () => {
    const fixture = createDependencyRepository();
    try {
      projectCrewDependencies({
        snapshotPath: fixture.worktree,
        sourcePath: fixture.worktree,
        worktrees: [fixture.worktree, fixture.main],
        platform: 'linux',
      });
      expect(readlinkSync(join(fixture.worktree, 'apps/app/node_modules/local')))
        .toBe('/workspace/packages/local');
      expect(readlinkSync(join(fixture.worktree, 'node_modules/.bun'))).toBe('/nuncio-deps/.bun');
    } finally {
      fixture.cleanup();
    }
  });

  it('projects a pnpm virtual store read-only when its frozen lockfile matches', async () => {
    const fixture = createDependencyRepository({ packageManager: 'pnpm' });
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => ({
        ...boundary, canonicalPath: fixture.worktree, fullHead: fixture.head, branch: null,
      }) } as never,
      new CrewCommandRunner(),
      { writeLog: () => stored } as never,
    );
    try {
      const result = await verifier.verify({
        runId: 'run-pnpm', cwd: fixture.worktree, expectedHead: fixture.head,
        command: [
          'cd apps/app',
          'test -d ../../node_modules/.pnpm',
          'if printf tamper > node_modules/fake/index.js; then exit 9; fi',
          'bun check.mjs',
        ].join(' && '),
      });
      expect(result).toMatchObject({ passed: true, exitCode: 0, spawnError: null });
      expect(readFileSync(
        join(fixture.main, 'node_modules/.pnpm/fake@1.0.0/node_modules/fake/index.js'), 'utf8',
      )).toContain('installed-dependency');
    } finally {
      fixture.cleanup();
    }
  });

  it('fails closed instead of using dependencies installed for a different lockfile', async () => {
    const fixture = createDependencyRepository({ mismatchLock: true });
    const run = jest.fn();
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => ({
        ...boundary, canonicalPath: fixture.worktree, fullHead: fixture.head, branch: null,
      }) } as never,
      { run } as never,
      { writeLog: () => stored } as never,
    );

    try {
      await expect(verifier.verify({
        runId: 'run-mismatch', command: 'bun test', cwd: fixture.worktree, expectedHead: fixture.head,
      })).rejects.toThrow('no separately installed dependencies');
      expect(run).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ['failure', { exitCode: 2, timedOut: false, aborted: false }],
    ['timeout', { exitCode: null, timedOut: true, aborted: false }],
    ['abort', { exitCode: null, timedOut: false, aborted: true }],
  ])('removes the disposable verification workspace after command %s', async (_label, outcome) => {
    const repo = createGitRepository();
    let executedCwd = '';
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => ({
        ...boundary, canonicalPath: repo.path, fullHead: repo.head, branch: 'main',
      }) } as never,
      { run: async (_command: string, cwd: string) => {
        executedCwd = cwd;
        return {
          ...outcome, stdout: '', stderr: '', durationMs: 1, spawnError: null, outputOverflow: false,
        };
      } } as never,
      { writeLog: () => stored } as never,
    );

    try {
      await verifier.verify({
        runId: 'run-cleanup', command: 'check', cwd: repo.path,
        expectedHead: repo.head, expectedBranch: 'main',
      });
      expect(executedCwd).not.toBe(repo.path);
      expect(existsSync(executedCwd)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it.each([
    ['abort', 5_000, true, null],
    ['timeout', 1_200, false, 'Crew verification setup timed out'],
  ])('stops and cleans snapshot preparation on %s', async (
    _label, timeoutMs, abort, spawnError,
  ) => {
    const fixture = createHungGitFixture();
    const controller = new AbortController();
    const run = jest.fn();
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => ({
        ...boundary, canonicalPath: fixture.source, fullHead: boundary.fullHead, branch: null,
      }) } as never,
      { run } as never,
      { writeLog: () => stored } as never,
    );
    const priorPath = process.env.PATH;
    process.env.PATH = `${fixture.bin}:${priorPath ?? ''}`;
    try {
      const pending = verifier.verify({
        runId: `run-setup-${_label}`, command: 'check', cwd: fixture.source,
        expectedHead: boundary.fullHead, timeoutMs, signal: controller.signal,
      });
      await waitForFile(fixture.snapshotMarker);
      const snapshotPath = readFileSync(fixture.snapshotMarker, 'utf8');
      if (abort) controller.abort();
      const result = await pending;
      expect(result).toMatchObject({
        passed: false,
        aborted: abort,
        timedOut: !abort,
        spawnError,
      });
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(snapshotPath)).toBe(false);
    } finally {
      process.env.PATH = priorPath;
      fixture.cleanup();
    }
  });
});

function createGitRepository(): { path: string; head: string; cleanup(): void } {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-verifier-source-')));
  writeFileSync(join(path, '.gitignore'), 'canonical-only.txt\ngenerated.txt\n');
  writeFileSync(join(path, 'tracked.txt'), 'frozen');
  symlinkSync(join(path, 'canonical-only.txt'), join(path, 'original-source'));
  initializeRepository(path);
  return {
    path,
    head: runGit(path, ['rev-parse', 'HEAD']).trim(),
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

function createDependencyRepository(options: {
  mismatchLock?: boolean;
  packageManager?: 'bun' | 'pnpm';
} = {}): {
  main: string; worktree: string; head: string; cleanup(): void;
} {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-dependency-main-')));
  const worktree = join(dirname(main), `${main.split('/').at(-1)}-worktree`);
  mkdirSync(join(main, 'apps/app'), { recursive: true });
  mkdirSync(join(main, 'packages/local'), { recursive: true });
  writeFileSync(join(main, '.gitignore'), 'node_modules\n');
  const lockfile = options.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'bun.lock';
  const store = options.packageManager === 'pnpm' ? '.pnpm' : '.bun';
  writeFileSync(join(main, lockfile), 'fixture-lock-v1\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/app', 'packages/local'], dependencies: { fake: '1.0.0' },
  }));
  writeFileSync(join(main, 'apps/app/package.json'), JSON.stringify({
    name: 'app', private: true, dependencies: { fake: '1.0.0', local: 'workspace:*' },
  }));
  writeFileSync(join(main, 'apps/app/check.mjs'), [
    "import fake from 'fake';", "import local from 'local';",
    "if (fake !== 'installed-dependency' || local !== 'snapshot-source') process.exit(2);",
  ].join('\n'));
  writeFileSync(join(main, 'packages/local/package.json'), JSON.stringify({
    name: 'local', type: 'module', exports: './index.js',
  }));
  writeFileSync(join(main, 'packages/local/index.js'), "export default 'snapshot-source';\n");
  initializeRepository(main);
  const head = runGit(main, ['rev-parse', 'HEAD']).trim();
  runGit(main, ['worktree', 'add', '-q', '--detach', worktree, head]);

  const installed = join(main, `node_modules/${store}/fake@1.0.0/node_modules/fake`);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({
    name: 'fake', version: '1.0.0', type: 'module', exports: './index.js',
  }));
  writeFileSync(join(installed, 'index.js'), "export default 'installed-dependency';\n");
  writeFileSync(join(installed, 'cli.sh'), '#!/bin/sh\nprintf installed-cli\n', { mode: 0o755 });
  mkdirSync(join(main, 'apps/app/node_modules/.bin'), { recursive: true });
  symlinkSync(`../../../node_modules/${store}/fake@1.0.0/node_modules/fake`, join(main, 'apps/app/node_modules/fake'));
  symlinkSync(join(main, 'packages/local'), join(main, 'apps/app/node_modules/local'));
  symlinkSync('../fake/cli.sh', join(main, 'apps/app/node_modules/.bin/fake'));
  writeFileSync(join(main, 'packages/local/index.js'), "export default 'host-source';\n");
  if (options.mismatchLock) writeFileSync(join(main, lockfile), 'different-installed-lock\n');

  return {
    main,
    worktree: realpathSync.native(worktree),
    head,
    cleanup: () => {
      try { runGit(main, ['worktree', 'remove', '--force', worktree]); } catch { /* best effort fixture cleanup */ }
      rmSync(main, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    },
  };
}

function initializeRepository(path: string): void {
  runGit(path, ['init', '-q', '-b', 'main']);
  runGit(path, ['config', 'user.email', 'crew@example.invalid']);
  runGit(path, ['config', 'user.name', 'Crew Test']);
  runGit(path, ['add', '.']);
  runGit(path, ['commit', '-qm', 'fixture']);
}

function createHungGitFixture(): {
  source: string; bin: string; snapshotMarker: string; cleanup(): void;
} {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-hung-git-')));
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  const snapshotMarker = join(root, 'snapshot-path');
  mkdirSync(source);
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "worktree" ]; then',
    `  printf 'worktree %s\\0' ${JSON.stringify(source)}`,
    '  exit 0',
    'fi',
    `printf '%s' "$PWD" > ${JSON.stringify(snapshotMarker)}`,
    'sleep 5',
    'exit 1',
  ].join('\n'), { mode: 0o755 });
  return {
    source, bin, snapshotMarker,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(path)) throw new Error(`Timed out waiting for fixture marker: ${path}`);
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
