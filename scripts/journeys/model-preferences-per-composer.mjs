// Journey (regression guard): model selection is scoped per composer host.
// Choosing a model in the Home composer must NOT leak into the Workbench slot
// composer, and vice-versa — each owns a distinct scoped preference key.
const HOME_SCOPE = 'home:new-agent';
const SLOT_SCOPE = 'workbench-slot:0';

/** Read one composer scope's persisted model id from the page's localStorage. */
function readScopedModelId(page, scope) {
  return page.evaluate((s) => {
    const raw = localStorage.getItem('nuncio-model-preference:' + encodeURIComponent(s));
    if (!raw) return null;
    try {
      return JSON.parse(raw).modelId ?? null;
    } catch {
      return null;
    }
  }, scope);
}

/** Open the given model-picker trigger and pick the row matching `modelName`. */
async function pickModel(page, waitFor, trigger, modelName) {
  await trigger.click();
  const search = page.getByPlaceholder('Search models');
  await waitFor(() => search.count(), { label: `model search open for "${modelName}"` });
  await search.fill(modelName);
  const row = page.getByRole('menuitem').filter({ hasText: modelName }).first();
  await waitFor(async () => (await row.count()) > 0, { label: `model row "${modelName}"` });
  await row.click();
}

export async function runModelPreferencesPerComposer(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const homeStep = record('model-prefs: Home composer selects its own model (home:new-agent scope)');
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  // Start from a clean slate so we assert on picks made in THIS journey only.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('nuncio-model-preference')) localStorage.removeItem(key);
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const homeTrigger = page.locator('[data-slot="model-picker-trigger"]').first();
  await waitFor(async () => (await homeTrigger.count()) > 0, { label: 'Home model picker trigger' });
  await pickModel(page, waitFor, homeTrigger, 'Mock Builder');
  await waitFor(async () => (await readScopedModelId(page, HOME_SCOPE)) === 'mock:builder', {
    label: 'Home scope persists mock:builder',
  });
  homeStep.ok = true;

  const slotStep = record('model-prefs: Workbench slot composer is independent, no cross-leak');
  await page.goto(`${baseUrl}/grid`, { waitUntil: 'domcontentloaded' });
  const slotTrigger = page.locator('[data-slot="model-picker-trigger"]').first();
  await waitFor(async () => (await slotTrigger.count()) > 0, { label: 'Workbench slot model picker' });
  // Independence on mount: the slot must not inherit Home's Builder choice.
  const slotTriggerText = (await slotTrigger.innerText()).trim();
  if (/Mock Builder/i.test(slotTriggerText)) {
    throw new Error(`Workbench slot inherited Home's model choice: "${slotTriggerText}"`);
  }
  await pickModel(page, waitFor, slotTrigger, 'Mock Reviewer');
  await waitFor(async () => (await readScopedModelId(page, SLOT_SCOPE)) === 'mock:reviewer', {
    label: 'Workbench slot scope persists mock:reviewer',
  });
  // No leak in either direction: Home keeps Builder while the slot holds Reviewer.
  const homeAfter = await readScopedModelId(page, HOME_SCOPE);
  if (homeAfter !== 'mock:builder') {
    throw new Error(`Home scope changed after slot pick — leaked: home=${homeAfter}`);
  }
  slotStep.ok = true;
  slotStep.detail = `home=mock:builder, ${SLOT_SCOPE}=mock:reviewer (no cross-leak)`;
}
