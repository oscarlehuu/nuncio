// Journey: the home composer's "Generate AGENTS.md" quick action appears after
// project selection and pre-fills the canned /init prompt without auto-sending.
// Drives the real project picker against a Git fixture.
import { basename, join } from 'node:path';
import { createGitProject } from '../lib/smoke-fixtures.mjs';

export async function runGenerateAgentsMd(ctx) {
  const { page, baseUrl, waitFor, record, artifactsDir, dataDir } = ctx;
  const projectPath = await createGitProject(dataDir, 'agents-md-project');

  const step = record('generate-agents-md: project pre-fills /init prompt');
  await page.setViewportSize({ width: 1280, height: 800 });
  // Earlier journeys may have persisted a project pick into localStorage — clear
  // so this case starts from a true "No repo" composer.
  await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('nuncio-project-preference');
    } catch {
      // ignore
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Hidden until a project is selected — the prompt needs a repo to analyze.
  if ((await page.getByRole('button', { name: /Generate AGENTS\.md/i }).count()) !== 0) {
    throw new Error('Generate AGENTS.md must stay hidden before a project is selected');
  }

  const projectTrigger = page.getByRole('button', { name: 'No repo', exact: true });
  await waitFor(() => projectTrigger.count(), { label: 'new-session project picker' });
  await projectTrigger.click();
  const projectOption = page.getByRole('option').filter({ hasText: basename(projectPath) });
  await waitFor(async () => (await projectOption.count()) === 1, { label: 'agents-md project option' });
  await projectOption.click();

  const action = page.getByRole('button', { name: /Generate AGENTS\.md/i });
  await waitFor(async () => (await action.count()) === 1, { label: 'Generate AGENTS.md after project select' });
  await action.click();

  const textarea = page.getByPlaceholder(/ask nuncio/i);
  await waitFor(async () => {
    const value = await textarea.inputValue();
    return value.includes('AGENTS.md') && value.includes('operating manual') && value.length > 200;
  }, { label: 'composer prefilled with AGENTS.md /init prompt' });

  // Prefill only — never auto-submit (no session should appear from this click).
  if ((await page.getByRole('link', { name: /agents\.md/i }).count()) > 0) {
    throw new Error('Generate AGENTS.md must not auto-create a session');
  }
  await page.screenshot({ path: join(artifactsDir, 'generate-agents-md-prefill.png'), fullPage: true });

  const prompt = await textarea.inputValue();

  step.ok = true;
  step.detail = `project=${basename(projectPath)}, promptBytes=${prompt.length}`;
}
