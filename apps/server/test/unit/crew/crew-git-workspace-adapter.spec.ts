import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewGitWorkspaceAdapter } from '../../../src/crew/crew-git-workspace.adapter';
import { GitService } from '../../../src/git/git.service';

describe('CrewGitWorkspaceAdapter crash reconciliation', () => {
  let root: string; let repo: string; let workspaces: string; let baseHead: string;
  let gitService: GitService; let adapter: CrewGitWorkspaceAdapter;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'crew-workspace-reconcile-'));
    repo = join(root, 'repo'); workspaces = join(root, 'workspaces');
    mkdirSync(repo, { recursive: true }); mkdirSync(workspaces, { recursive: true });
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'crew@nuncio.local']);
    await git(repo, ['config', 'user.name', 'Crew Test']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'init']);
    baseHead = await gitText(repo, ['rev-parse', 'main']);
    const settings = { resolve: (key: string) => key === 'NUNCIO_WORKSPACES_DIR' ? workspaces : null };
    gitService = new GitService(settings as never);
    adapter = new CrewGitWorkspaceAdapter(gitService, settings as never);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adopts the exact deterministic worktree after crash-before-workspace_prepared', async () => {
    const input = { runId: 'run-1', projectPath: repo, baseBranch: 'main', baseHead, slug: 'Ship feature' };
    const sideEffect = await gitService.createWorktree(repo, 'main', input.runId, input.slug);
    const recovered = await adapter.createWorktree(input);
    expect(recovered).toEqual({
      worktreePath: realpathSync.native(sideEffect.worktreePath), branch: sideEffect.branch, baseBranch: 'main',
    });
    expect((await gitText(recovered.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']))).toBe(recovered.branch);
  });

  it('rejects an existing deterministic worktree at a clean descendant of the frozen base', async () => {
    const input = { runId: 'run-descendant', projectPath: repo, baseBranch: 'main', baseHead, slug: 'Ship feature' };
    const sideEffect = await gitService.createWorktree(repo, 'main', input.runId, input.slug);
    writeFileSync(join(sideEffect.worktreePath, 'descendant.txt'), 'advanced\n');
    await git(sideEffect.worktreePath, ['add', '.']);
    await git(sideEffect.worktreePath, ['commit', '-m', 'advance deterministic worktree']);

    await expect(adapter.createWorktree(input)).rejects.toThrow('frozen base head');
  });

  it('adopts an exact unclaimed branch-only crash at the frozen base head', async () => {
    const branch = 'nuncio/run-2-partial';
    await git(repo, ['branch', branch, 'main']);
    const recovered = await adapter.createWorktree({
      runId: 'run-2', projectPath: repo, baseBranch: 'main', baseHead, slug: 'partial',
    });
    expect(recovered).toMatchObject({ branch, baseBranch: 'main' });
    expect(recovered.worktreePath).toBe(realpathSync.native(join(workspaces, 'run-2')));
  });

  it('rejects a branch-only partial state at the wrong head', async () => {
    const branch = 'nuncio/run-3-partial';
    await git(repo, ['branch', branch, 'main']);
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'later']);
    const movedHead = await gitText(repo, ['rev-parse', 'main']);
    await expect(adapter.createWorktree({
      runId: 'run-3', projectPath: repo, baseBranch: 'main', baseHead: movedHead, slug: 'partial',
    })).rejects.toThrow('base head');
  });

  it('creates the Crew worktree from the frozen SHA even after the base branch advances', async () => {
    const frozenHead = await gitText(repo, ['rev-parse', 'main']);
    writeFileSync(join(repo, 'advanced.txt'), 'branch moved\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'advance mutable branch']);
    const movedHead = await gitText(repo, ['rev-parse', 'main']);
    expect(movedHead).not.toBe(frozenHead);

    const created = await adapter.createWorktree({
      runId: 'run-frozen', projectPath: repo, baseBranch: 'main', baseHead: frozenHead, slug: 'frozen',
    } as never);

    expect(await gitText(created.worktreePath, ['rev-parse', 'HEAD'])).toBe(frozenHead);
    expect(created.baseBranch).toBe('main');
  });

  it('checks project files against the frozen revision instead of mutable checkout state', async () => {
    mkdirSync(join(repo, '.nuncio'), { recursive: true });
    writeFileSync(join(repo, '.nuncio', 'verify'), 'exit 0\n');
    const fileAtRevision = (adapter as unknown as {
      fileExistsAtRevision(path: string, revision: string, file: string): Promise<boolean>;
    }).fileExistsAtRevision.bind(adapter);

    expect(await fileAtRevision(repo, baseHead, '.nuncio/verify')).toBe(false);
    await git(repo, ['add', '.nuncio/verify']);
    await git(repo, ['commit', '-m', 'add verifier']);
    const verifierHead = await gitText(repo, ['rev-parse', 'HEAD']);
    expect(await fileAtRevision(repo, verifierHead, '.nuncio/verify')).toBe(true);

    rmSync(join(repo, '.nuncio', 'verify'));
    symlinkSync('../README.md', join(repo, '.nuncio', 'verify'));
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'replace verifier with symlink']);
    const symlinkHead = await gitText(repo, ['rev-parse', 'HEAD']);
    expect(await fileAtRevision(repo, symlinkHead, '.nuncio/verify')).toBe(false);

    rmSync(join(repo, '.nuncio', 'verify'));
    mkdirSync(join(repo, '.nuncio', 'verify'));
    writeFileSync(join(repo, '.nuncio', 'verify', 'nested.sh'), 'exit 0\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'replace verifier with directory']);
    const directoryHead = await gitText(repo, ['rev-parse', 'HEAD']);
    expect(await fileAtRevision(repo, directoryHead, '.nuncio/verify')).toBe(false);
    await expect(fileAtRevision(repo, 'missing-frozen-head', '.nuncio/verify'))
      .rejects.toThrow();
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text());
}
async function gitText(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text());
  return (await new Response(process.stdout).text()).trim();
}
