// Journey: the Home composer's session-mode picker (capability-gated) drives the
// per-mode placeholder and chip, and the chosen mode rides through create onto
// the session header. Seeds the Mock engine as the Home model so a modes-capable
// provider is selected regardless of which real providers the host has configured.
const HOME_SCOPE = 'home:new-agent';

/** Seed one composer scope's persisted model so a known engine is preselected. */
function seedScopedModel(page, scope, pref) {
  return page.evaluate(
    ({ s, p }) => {
      localStorage.setItem(
        'nuncio-model-preference:' + encodeURIComponent(s),
        JSON.stringify(p),
      );
    },
    { s: scope, p: pref },
  );
}

export async function runSessionModes(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const step = record('modes: composer Debug picker drives placeholder + chip through create');
  await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });
  await seedScopedModel(page, HOME_SCOPE, { modelId: 'mock:default', providerId: 'mock' });
  await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });

  // The mode picker only renders for a modes-capable provider — its presence is
  // the sync point that the Mock engine is selected.
  const modeTrigger = page.getByRole('button', { name: /session mode: agent/i });
  await waitFor(() => modeTrigger.count(), { label: 'composer mode picker (mock engine selected)' });
  await modeTrigger.click();
  await page.getByRole('menuitemradio', { name: /debug/i }).click();

  await waitFor(
    async () => (await page.getByPlaceholder(/debug and troubleshoot/i).count()) > 0,
    { label: 'debug-mode composer placeholder' },
  );
  await waitFor(
    async () => (await page.getByRole('button', { name: /session mode: debug/i }).count()) > 0,
    { label: 'composer Debug mode chip' },
  );

  const modePrompt = page.getByPlaceholder(/debug and troubleshoot/i);
  await modePrompt.fill('Smoke: reproduce the debug-mode flow');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await waitFor(async () => /\/session\/[^/]+$/.test(new URL(page.url()).pathname), {
    label: 'navigation to the created debug session',
  });
  const headerChip = page.getByTestId('session-mode-chip');
  await waitFor(() => headerChip.count(), { label: 'session header mode chip' });
  if ((await headerChip.getAttribute('data-mode')) !== 'debug') {
    throw new Error('session header mode chip is not marked debug');
  }
  step.ok = true;
  step.detail = 'placeholder + chip + header chip = debug';
}
