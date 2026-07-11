import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCrewDependencies } from './crew-dependency-projection';

export const CREW_VERIFICATION_WORKSPACE_FACTORY = Symbol('CREW_VERIFICATION_WORKSPACE_FACTORY');

export interface CrewPreparedVerificationWorkspace {
  path: string;
  dependencyRoot: string | null;
  cleanup(): Promise<void>;
}

export interface CrewVerificationWorkspaceFactory {
  prepare(input: {
    sourcePath: string;
    expectedHead: string;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<CrewPreparedVerificationWorkspace>;
}

export class CrewVerificationPreparationStopped extends Error {
  constructor(readonly reason: 'aborted' | 'timed_out') {
    super(reason === 'aborted'
      ? 'Crew verification setup aborted'
      : 'Crew verification setup timed out');
    this.name = 'CrewVerificationPreparationStopped';
  }
}

export const defaultCrewVerificationWorkspaceFactory: CrewVerificationWorkspaceFactory = {
  prepare: prepareCrewVerificationWorkspace,
};

export async function prepareCrewVerificationWorkspace(input: {
  sourcePath: string;
  expectedHead: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<CrewPreparedVerificationWorkspace> {
  if (!/^[0-9a-f]{40,64}$/i.test(input.expectedHead)) {
    throw new Error('Crew verification head must be a full Git object id');
  }
  const control: PreparationControl = {
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? Date.now() + 120_000,
  };
  assertPreparationActive(control);
  const sourcePath = realpathSync.native(input.sourcePath);
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'nuncio-crew-snapshot-')));
  try {
    const worktrees = await listGitWorktrees(sourcePath, control);
    await runGit(path, ['init', '-q'], control);
    await runGit(path, [
      '-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=/dev/null',
      'fetch', '-q', '--no-tags', '--depth=1', sourcePath, input.expectedHead,
    ], control);
    await runGit(
      path, ['-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '--detach', 'FETCH_HEAD'], control,
    );
    const actualHead = (await runGit(path, ['rev-parse', 'HEAD'], control)).trim();
    if (actualHead !== input.expectedHead.toLowerCase()) {
      throw new Error('Crew verification snapshot did not resolve the frozen head');
    }
    assertPreparationActive(control);
    const dependencyRoot = projectCrewDependencies({ snapshotPath: path, sourcePath, worktrees });
    assertPreparationActive(control);
    return preparedWorkspace(path, dependencyRoot);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }

}

function preparedWorkspace(path: string, dependencyRoot: string | null): CrewPreparedVerificationWorkspace {
  let cleaned = false;
  return { path, dependencyRoot, cleanup: async () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(path, { recursive: true, force: true });
  } };
}

async function listGitWorktrees(sourcePath: string, control: PreparationControl): Promise<string[]> {
  const output = await runGit(sourcePath, ['worktree', 'list', '--porcelain', '-z'], control);
  return output.split('\0').filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

async function runGit(cwd: string, args: string[], control: PreparationControl): Promise<string> {
  assertPreparationActive(control);
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: gitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let stopped: CrewVerificationPreparationStopped['reason'] | null = null;
  let terminated = false;
  const terminate = (reason: CrewVerificationPreparationStopped['reason']) => {
    if (stopped === null) stopped = reason;
    if (terminated) return;
    terminated = true;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* process already exited */ } }
  };
  const onAbort = () => terminate('aborted');
  control.signal?.addEventListener('abort', onAbort, { once: true });
  if (control.signal?.aborted) onAbort();
  const timer = setTimeout(() => terminate('timed_out'), Math.max(1, control.deadlineAt - Date.now()));
  try {
    const [stdout, stderr, settled] = await Promise.all([
      readOutput(child.stdout as ReadableStream<Uint8Array>),
      readOutput(child.stderr as ReadableStream<Uint8Array>),
      child.exited.then(
        (exitCode) => ({ exitCode, error: null as string | null }),
        (error) => ({ exitCode: null, error: error instanceof Error ? error.message : String(error) }),
      ),
    ]);
    if (stopped) throw new CrewVerificationPreparationStopped(stopped);
    if (settled.error) throw new Error(`Crew verification Git setup failed: ${settled.error}`);
    if (settled.exitCode !== 0) {
      throw new Error(`Crew verification Git setup failed: ${stderr.trim() || settled.exitCode}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    control.signal?.removeEventListener('abort', onAbort);
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  try { return await new Response(stream).text(); } catch { return ''; }
}

function assertPreparationActive(control: PreparationControl): void {
  if (control.signal?.aborted) throw new CrewVerificationPreparationStopped('aborted');
  if (Date.now() >= control.deadlineAt) throw new CrewVerificationPreparationStopped('timed_out');
}

function gitEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

interface PreparationControl {
  signal?: AbortSignal;
  deadlineAt: number;
}
