import { CrewCommandRunner } from '../../../src/crew/crew-command.runner';
import { buildCrewSandboxLaunch } from '../../../src/crew/crew-command-sandbox';
import { CrewVerifierService } from '../../../src/crew/crew-verifier.service';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const head = 'a'.repeat(40);
const boundary = {
  canonicalPath: '/repo', exists: true, symlink: false, branch: 'crew/run',
  fullHead: head, clean: true, reachable: true,
};
const stored = {
  artifact: { id: 'artifact-1' }, preview: 'bounded', truncated: true,
};
const passthroughVerificationFactory = {
  prepare: async ({ sourcePath }: { sourcePath: string }) => ({
    path: sourcePath, dependencyRoot: null, cleanup: async () => {},
  }),
};

describe('CrewVerifierService', () => {
  it('uses exit truth independent of a truncated preview', async () => {
    const inspectBoundary = jest.fn(async () => boundary);
    const writeLog = jest.fn(() => stored);
    const runner = { run: jest.fn(async () => ({
      exitCode: 0, stdout: 'ok'.repeat(5000), stderr: '', durationMs: 12,
      timedOut: false, spawnError: null, outputOverflow: false,
    })) };
    const verifier = new CrewVerifierService(
      { inspectBoundary } as never, runner as never, { writeLog } as never,
      passthroughVerificationFactory,
    );
    const result = await verifier.verify({
      runId: 'run-1', command: 'bun test', cwd: '/repo', expectedHead: head,
      expectedBranch: 'crew/run', previewBytes: 128,
    });
    expect(result).toMatchObject({
      passed: true, exitCode: 0, workspaceHead: head,
      artifactId: 'artifact-1', preview: 'bounded', previewTruncated: true,
    });
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', kind: 'verify-log', previewBytes: 128,
    }));
  });

  it.each([
    [{ exitCode: 2, stdout: '', stderr: 'failed', durationMs: 4, timedOut: false, spawnError: null }],
    [{ exitCode: null, stdout: '', stderr: '', durationMs: 50, timedOut: true, spawnError: null }],
    [{ exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, spawnError: 'ENOENT' }],
    [{ exitCode: 0, stdout: 'truncated', stderr: '', durationMs: 1, timedOut: false, spawnError: null, outputOverflow: true }],
  ])('never passes nonzero, timeout, or spawn error results', async (commandResult) => {
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => boundary } as never,
      { run: async () => commandResult } as never,
      { writeLog: () => stored } as never,
      passthroughVerificationFactory,
    );
    expect((await verifier.verify({ runId: 'r', command: 'check', cwd: '/repo', expectedHead: head })).passed).toBe(false);
  });

  it('refuses dirty or changed workspace before spawning verification', async () => {
    const run = jest.fn();
    const verifier = new CrewVerifierService(
      { inspectBoundary: async () => ({ ...boundary, clean: false }) } as never,
      { run } as never,
      { writeLog: jest.fn() } as never,
    );
    await expect(verifier.verify({ runId: 'r', command: 'check', cwd: '/repo', expectedHead: head }))
      .rejects.toThrow('clean');
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted command mutates head or dirties the workspace', async () => {
    const inspectBoundary = jest.fn()
      .mockResolvedValueOnce(boundary)
      .mockResolvedValueOnce({ ...boundary, fullHead: 'b'.repeat(40), clean: false });
    const writeLog = jest.fn(() => stored);
    const verifier = new CrewVerifierService(
      { inspectBoundary } as never,
      { run: async () => ({
        exitCode: 0, stdout: '', stderr: '', durationMs: 1,
        timedOut: false, spawnError: null, outputOverflow: false,
      }) } as never,
      { writeLog } as never,
      passthroughVerificationFactory,
    );
    const result = await verifier.verify({
      runId: 'r', command: 'mutating-check', cwd: '/repo', expectedHead: head,
      expectedBranch: 'crew/run',
    });
    expect(result.passed).toBe(false);
    expect(result.workspaceHead).toBe(head);
    expect(inspectBoundary).toHaveBeenCalledTimes(2);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        postBoundaryOk: false, postWorkspaceHead: 'b'.repeat(40), postClean: false,
      }),
    }));
  });
});

describe('CrewCommandRunner', () => {
  it('captures stdout/stderr and a nonzero exit without interpolating extra arguments', async () => {
    const result = await new CrewCommandRunner().run("printf 'out'; printf 'err' >&2; exit 3", process.cwd(), 1000);
    expect(result).toMatchObject({
      exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false, spawnError: null, outputOverflow: false,
    });
  });

  it('kills a timed-out command and reports spawn failure for an invalid cwd', async () => {
    const runner = new CrewCommandRunner();
    expect((await runner.run('sleep 1', process.cwd(), 20)).timedOut).toBe(true);
    expect((await runner.run('true', '/definitely/missing/crew-cwd', 100)).spawnError).toBeTruthy();
  });

  it('fails closed and bounds captured bytes when command output overflows', async () => {
    const result = await new CrewCommandRunner().run("printf '%0200d' 0", process.cwd(), 1000, 64);
    expect(result.outputOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
    expect(result.exitCode).toBeNull();
  });

  it('kills the detached process group so timeout children cannot survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-process-group-'));
    const sentinel = join(dir, 'survived');
    try {
      const result = await new CrewCommandRunner().run(
        `(sleep 0.15; printf alive > '${sentinel}') & wait`, process.cwd(), 20,
      );
      expect(result.timedOut).toBe(true);
      await Bun.sleep(250);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills the detached process group when the Crew owner aborts verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-abort-group-'));
    const sentinel = join(dir, 'survived');
    const controller = new AbortController();
    try {
      const pending = new CrewCommandRunner().run(
        `(sleep 0.15; printf alive > '${sentinel}') & wait`, process.cwd(), 1000, 1024,
        controller.signal,
      );
      await Bun.sleep(20);
      controller.abort();
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(result.exitCode).toBeNull();
      await Bun.sleep(250);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the abort race between the initial signal check and listener registration', async () => {
    let reads = 0;
    const racedSignal = {
      get aborted() { reads += 1; return reads > 1; },
      addEventListener: () => {}, removeEventListener: () => {},
    } as unknown as AbortSignal;
    const result = await new CrewCommandRunner().run('sleep 1', process.cwd(), 2000, 1024, racedSignal);
    expect(result).toMatchObject({ aborted: true, exitCode: null });
  });

  it('denies network, ambient secrets, host reads/writes, and .git mutation while allowing workspace output', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crew-sandbox-workspace-'));
    const outsideRead = join(homedir(), `.crew-sandbox-secret-${process.pid}`);
    const outsideTmpRead = join(tmpdir(), `crew-sandbox-read-${process.pid}`);
    const outsideWrite = join(homedir(), `.crew-sandbox-write-${process.pid}`);
    writeFileSync(outsideRead, 'host-secret');
    writeFileSync(outsideTmpRead, 'tmp-secret');
    expect(existsSync(outsideRead)).toBe(true);
    mkdirSync(join(workspace, '.git'));
    process.env.NUNCIO_SANDBOX_SECRET = 'ambient-secret';
    const runner = new CrewCommandRunner();
    try {
      expect((await runner.run(`cat '${outsideRead}' >/dev/null`, workspace, 1000)).exitCode).not.toBe(0);
      expect((await runner.run(`cat '${outsideTmpRead}' >/dev/null`, workspace, 1000)).exitCode).not.toBe(0);
      expect((await runner.run(`printf bad > '${outsideWrite}'`, workspace, 1000)).exitCode).not.toBe(0);
      expect((await runner.run('test -z "$NUNCIO_SANDBOX_SECRET"', workspace, 1000)).exitCode).toBe(0);
      expect((await runner.run('printf discarded >/dev/null', workspace, 1000)).exitCode).toBe(0);
      expect((await runner.run('ps eww -p $PPID >/dev/null', workspace, 1000)).exitCode).not.toBe(0);
      if (process.platform === 'darwin') {
        expect((await runner.run('cat /private/etc/hosts >/dev/null', workspace, 1000)).exitCode)
          .not.toBe(0);
        expect((await runner.run('/usr/bin/security list-keychains >/dev/null', workspace, 1000)).exitCode).not.toBe(0);
      }
      expect((await runner.run('printf bad > .git/config', workspace, 1000)).exitCode).not.toBe(0);
      expect(existsSync(join(workspace, '.git', 'config'))).toBe(false);
      rmSync(join(workspace, '.git'), { recursive: true, force: true });
      writeFileSync(join(workspace, '.git'), 'gitdir: /outside/crew-git-dir\n');
      expect((await runner.run('printf bad > .git', workspace, 1000)).exitCode).not.toBe(0);
      expect(await Bun.file(join(workspace, '.git')).text()).toBe('gitdir: /outside/crew-git-dir\n');
      expect((await runner.run('curl --max-time 1 -sS https://example.com >/dev/null', workspace, 2000)).exitCode)
        .not.toBe(0);
      expect((await runner.run('printf safe > result.txt', workspace, 1000)).exitCode).toBe(0);
      expect(await Bun.file(join(workspace, 'result.txt')).text()).toBe('safe');
      expect(existsSync(outsideWrite)).toBe(false);
    } finally {
      delete process.env.NUNCIO_SANDBOX_SECRET;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outsideRead, { force: true });
      rmSync(outsideTmpRead, { force: true });
      rmSync(outsideWrite, { force: true });
    }
  });

  it('runs an advertised Homebrew Node toolchain inside the macOS sandbox', async () => {
    if (process.platform !== 'darwin' || !existsSync('/opt/homebrew/bin/node')) return;
    const result = await new CrewCommandRunner().run('node --version', process.cwd(), 2000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null });
    expect(result.stdout.trim()).toMatch(/^v\d+/);
  });

  it('fails closed when no supported verifier sandbox is available', () => {
    expect(() => buildCrewSandboxLaunch('true', process.cwd(), 'linux', '/missing/bwrap'))
      .toThrow('refusing unsandboxed');
    expect(() => buildCrewSandboxLaunch('true', process.cwd(), 'darwin', '/missing/sandbox-exec'))
      .toThrow('refusing unsandboxed');
  });

  it('denies macOS global service lookup and Apple Events in the generated profile', () => {
    const launch = buildCrewSandboxLaunch('true', process.cwd(), 'darwin', '/usr/bin/true');
    expect(launch.argv[2]).toContain('(deny mach-lookup)');
    expect(launch.argv[2]).toContain('(deny appleevent-send)');
    expect(launch.argv[2]).toContain(`(require-not (literal ${JSON.stringify(dirname(process.cwd()))}))`);
    expect(launch.argv[2]).not.toContain(`(literal ${JSON.stringify(join(dirname(process.cwd()), 'sibling'))})`);
  });

  it('maps Linux verification to an isolated bubblewrap argv without an unsandboxed shell fallback', () => {
    const launch = buildCrewSandboxLaunch('true', process.cwd(), 'linux', '/usr/bin/true');
    expect(launch.argv).toEqual(expect.arrayContaining([
      '/usr/bin/true', '--unshare-all', '--clearenv', '--bind', '/tmp', '--chdir', '/workspace', '/bin/sh', '-c', 'true',
    ]));
  });

  it('rejects a Linux source worktree exposed by a required host bind', () => {
    expect(() => buildCrewSandboxLaunch(
      'true', process.cwd(), 'linux', '/usr/bin/true', { sourceRoot: '/usr/local' },
    )).toThrow('overlaps a Linux host bind');
  });

  it('exposes installed dependencies read-only on macOS and Linux', () => {
    const dependencyRoot = realpathSync.native(join(process.cwd(), 'node_modules'));
    const sourceRoot = realpathSync.native(tmpdir());
    const mac = buildCrewSandboxLaunch(
      'true', process.cwd(), 'darwin', '/usr/bin/true', { dependencyRoot, sourceRoot },
    );
    expect(mac.argv[2]).toContain(`(require-not (subpath ${JSON.stringify(dependencyRoot)}))`);
    expect(mac.argv[2]).toContain(`(deny file-write* (subpath ${JSON.stringify(dependencyRoot)}))`);
    expect(mac.argv[2]).toContain(`(deny file-read-data (subpath ${JSON.stringify(sourceRoot)}))`);
    const linux = buildCrewSandboxLaunch(
      'true', process.cwd(), 'linux', '/usr/bin/true', { dependencyRoot, sourceRoot },
    );
    expect(linux.argv).toEqual(expect.arrayContaining([
      '--ro-bind', dependencyRoot, '/nuncio-deps',
    ]));
  });
});
