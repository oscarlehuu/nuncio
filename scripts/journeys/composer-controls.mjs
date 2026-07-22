// Journey: the new-session composer renders remote refs and fits both desktop
// and a 390px mobile viewport. Drives the real project + branch pickers against
// a committed Git fixture.
import { basename, join } from 'node:path';
import { createGitProject } from '../lib/smoke-fixtures.mjs';

export async function runComposerControls(ctx) {
  const { page, baseUrl, waitFor, record, artifactsDir, dataDir } = ctx;
  const projectPath = await createGitProject(dataDir, 'smoke-project');

  const step = record('composer: remote refs work at desktop + mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });

  const projectTrigger = page.getByRole('button', { name: 'No repo', exact: true });
  await waitFor(() => projectTrigger.count(), { label: 'new-session project picker' });
  await projectTrigger.click();
  const projectOption = page.getByRole('option').filter({ hasText: basename(projectPath) });
  await waitFor(async () => (await projectOption.count()) === 1, { label: 'smoke project option' });
  await projectOption.click();

  const branchResponse = await fetch(
    `${baseUrl}/api/projects/branches?path=${encodeURIComponent(projectPath)}`,
  );
  const branches = await branchResponse.json();
  const currentBranch = branches.find((branch) => branch.isCurrent)?.name;
  const remoteBranch = branches.find((branch) => branch.name.startsWith('origin/'))?.name;
  if (!currentBranch || !remoteBranch) {
    throw new Error(`branch catalog missing current/remote refs: ${JSON.stringify(branches)}`);
  }
  const branchTrigger = page.getByRole('button', { name: currentBranch, exact: true });
  await waitFor(() => branchTrigger.count(), { label: 'selected base branch' });
  await branchTrigger.click();
  const remoteBranchOption = page.getByRole('option', { name: remoteBranch, exact: true });
  await waitFor(() => remoteBranchOption.count(), { label: 'remote branch option' });
  await page.screenshot({ path: join(artifactsDir, 'branch-picker-remote-refs.png'), fullPage: true });
  await page.keyboard.press('Escape');

  await page.screenshot({ path: join(artifactsDir, 'composer-controls-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const fitsViewport = await page
    .locator('html')
    .evaluate((element) => element.scrollWidth <= element.clientWidth);
  if (!fitsViewport) throw new Error('composer overflows the 390px viewport');
  await page.screenshot({ path: join(artifactsDir, 'composer-controls-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  step.ok = true;
  step.detail = `current=${currentBranch}, remote=${remoteBranch}`;
}
