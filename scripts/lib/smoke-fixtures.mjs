// Shared fixtures for the level-5 UI journey suite. A journey that needs a real
// project in the picker calls createGitProject(); it is a plain local Git repo
// under the hermetic data dir (never a user path), with an origin/main+origin/dev
// ref pair so the branch picker has remote refs to show.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function git(cwd, ...args) {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

/**
 * Initialize a committed Git repo under `dataDir/<name>` with remote-tracking
 * refs, so the composer's project + branch pickers have real refs to render.
 * @returns {Promise<string>} the absolute repo path
 */
export async function createGitProject(dataDir, name = 'smoke-project') {
  const repo = join(dataDir, name);
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'smoke@nuncio.local');
  await git(repo, 'config', 'user.name', 'Nuncio Smoke');
  await writeFile(join(repo, 'README.md'), '# smoke project\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-m', 'init');
  const head = (await gitOut(repo, 'rev-parse', 'HEAD')).trim();
  await git(repo, 'update-ref', 'refs/remotes/origin/main', head);
  await git(repo, 'update-ref', 'refs/remotes/origin/dev', head);
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return repo;
}

async function gitOut(cwd, ...args) {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
}
