import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const OBJECTIVE = 'Exercise the automatic Crew browser flow';

export async function runCrewSmoke({ page, baseUrl, dataDir, record, waitFor }) {
  const setup = record('crew: create a real Git fixture and independent Mock role profile');
  const repo = await createCrewFixture(dataDir);
  const profile = await postJson(`${baseUrl}/api/crew/profiles`, {
    name: 'Smoke Quality Crew',
    presetId: 'quality',
    definition: {
      bindings: {
        foreman: { provider: 'mock', model: 'mock:foreman', label: 'Mock Foreman' },
        builder: { provider: 'mock', model: 'mock:builder', label: 'Mock Builder' },
        reviewer: { provider: 'mock', model: 'mock:reviewer', label: 'Mock Reviewer' },
      },
      policy: {
        verifyCommand: null,
        maxVerifyRetries: 2,
        maxReviewRetries: 2,
        strictFreshFinalReviewer: true,
      },
    },
  });
  setup.ok = true;
  setup.detail = `repo=${repo}, profile=${profile.profile.id}`;

  const create = record('crew: select Crew/project/profile and delegate through the UI');
  await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /No repo/i }).click();
  await waitFor(async () => (await page.getByText(repo, { exact: true }).count()) > 0, {
    label: 'Crew fixture in project picker',
  });
  await page.getByText(repo, { exact: true }).click();
  await page.getByRole('radio', { name: 'Crew', exact: true }).click();
  const profileSelect = page.getByLabel('Crew profile');
  await waitFor(async () => !(await profileSelect.isDisabled()), { label: 'Crew profile picker' });
  await profileSelect.selectOption(profile.profile.id);
  await waitFor(async () => (await page.getByText('Ready', { exact: true }).count()) > 0, {
    label: 'Crew profile to resolve Ready',
  });
  await page.getByPlaceholder(/Ask Nuncio to build/i).fill(OBJECTIVE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitFor(() => page.url().includes('/crew/'), { label: 'Crew task route' });
  create.ok = true;

  const finish = record('crew: fixed six-stage workflow reaches current-head terminal success');
  const taskId = decodeURIComponent(new URL(page.url()).pathname.split('/crew/')[1] ?? '');
  const terminal = await waitFor(async () => {
    const task = await getJson(`${baseUrl}/api/crew/tasks/${encodeURIComponent(taskId)}`);
    const run = task.runs?.at(-1);
    if (run?.status?.startsWith('BLOCKED')) throw new Error(`Crew blocked: ${JSON.stringify(run)}`);
    if (run?.status !== 'TERMINAL') return false;
    return getJson(`${baseUrl}/api/crew-runs/${encodeURIComponent(run.id)}`);
  }, { timeout: 30_000, label: 'Crew run terminal success' });
  if (terminal.run.outcome !== 'SUCCEEDED') {
    throw new Error(`Crew outcome was ${terminal.run.outcome}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await page.getByText(OBJECTIVE, { exact: true }).count()) > 0, {
    label: 'Crew detail to hydrate',
  });
  const progress = page.getByRole('list', { name: 'Crew run progress' });
  if ((await progress.locator(':scope > li').count()) !== 6) throw new Error('Crew progress must show six stages');
  await waitFor(async () => (await page.getByText('Mock Crew smoke run completed.', { exact: true }).count()) > 0, {
    label: 'Crew synthesis summary',
  });
  await waitFor(async () => (await page.getByText('Deterministic smoke verification passed.', { exact: true }).count()) > 0, {
    label: 'Crew deterministic verification evidence',
  });
  if ((await page.getByText('passed', { exact: true }).count()) < 2) {
    throw new Error('Crew verify and review gates must both pass');
  }
  finish.ok = true;
  finish.detail = `run=${terminal.run.id}, head=${terminal.run.workspaceHead}`;

  const responsive = record('crew: narrow detail has no horizontal overflow');
  await page.setViewportSize({ width: 390, height: 844 });
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  if (!noOverflow) throw new Error('Crew detail overflows at 390px');
  responsive.ok = true;

  const member = record('crew: member session is inspect-only and visibly Crew-managed');
  await page.getByRole('link', { name: 'Open mock:builder member session' }).click();
  await waitFor(async () => (await page.getByText(/Managed by Crew/i).count()) > 0, {
    label: 'Crew-managed member session banner',
  });
  if ((await page.getByPlaceholder(/Steer the agent/i).count()) > 0) {
    throw new Error('Crew-owned member session exposed the public steer composer');
  }
  member.ok = true;
}

async function createCrewFixture(dataDir) {
  const repo = join(dataDir, 'smoke-crew-repo');
  await mkdir(join(repo, '.nuncio'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# Crew smoke fixture\n');
  await writeFile(join(repo, '.nuncio', 'verify'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await command('git', ['init', '-b', 'main'], repo);
  await command('git', ['config', 'user.email', 'crew-smoke@nuncio.local'], repo);
  await command('git', ['config', 'user.name', 'Crew Smoke'], repo);
  await command('git', ['add', '.'], repo);
  await command('git', ['commit', '-m', 'test: initialize Crew smoke fixture'], repo);
  return repo;
}

async function command(program, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}: ${stderr}`)));
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}
