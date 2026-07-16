// Journey: the Solo session lifecycle on the Mock provider — create, watch the
// assistant reply stream and complete, confirm the composer unlocks at IDLE,
// capture a Light-theme screenshot, steer, and archive out of the active list.
import { join } from 'node:path';
import { createMockSession, MOCK_TASK_REPLY, waitSessionIdle } from '../lib/mock-session.mjs';

export async function runSoloLifecycle(ctx) {
  const { page, baseUrl, waitFor, record, artifactsDir } = ctx;

  // Create immediately before navigating so Chrome observes a live run rather
  // than hydrating a response that completed during setup.
  const createStep = record('create live mock session (POST /api/sessions provider=mock)');
  const session = await createMockSession(baseUrl, 'Smoke: run the mock flow');
  createStep.ok = true;
  createStep.detail = `id=${session.id}`;

  const streamStep = record('stream: assistant reply appears in the transcript');
  await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
  const composer = page.getByPlaceholder(/Steer the agent/i);
  await waitFor(() => composer.count(), { label: 'session detail to hydrate' });
  const replyMark = 'I received your task';
  await waitFor(async () => (await page.getByText(replyMark, { exact: false }).count()) > 0, {
    label: 'streamed assistant reply',
  });
  await waitFor(async () => (await page.getByText(MOCK_TASK_REPLY, { exact: true }).count()) > 0, {
    label: 'exact completed assistant reply',
  });
  streamStep.ok = true;
  streamStep.detail = `matched "${replyMark}…" and exact final text`;

  const composerEnabledStep = record('composer: enabled after IDLE (deriveComposerEnabled)');
  await waitSessionIdle(baseUrl, session.id, waitFor);
  if (await composer.isDisabled()) {
    throw new Error('steer composer stayed disabled after IDLE');
  }
  composerEnabledStep.ok = true;

  // Light-theme visual gate. ModeToggle sits under the desktop sidebar rail
  // hit-target here, so set the theme the way ThemeProvider persists it.
  const lightThemeStep = record('theme: apply Light and capture session screenshot');
  await page.evaluate(() => {
    localStorage.setItem('nuncio-theme', 'light');
    document.documentElement.classList.remove('dark');
  });
  await waitFor(
    async () => !(await page.locator('html').evaluate((el) => el.classList.contains('dark'))),
    { label: 'html to leave .dark after Light theme' },
  );
  await page.screenshot({ path: join(artifactsDir, 'session-detail-light.png'), fullPage: true });
  lightThemeStep.ok = true;

  // Stop/Interrupt while RUNNING — Mock has interrupt:false and settles
  // instantly, so the control is not exercisable mid-run here.
  const interruptSkipStep = record('interrupt: skipped on mock (interrupt:false, settles instantly)');
  interruptSkipStep.ok = true;
  interruptSkipStep.detail = 'no mid-run Stop surface for Mock; contract suite covers capable providers';

  const steerStep = record('steer: partial reply renders before exact completion');
  const steerText = `steer-${Date.now()}`;
  await composer.click();
  await composer.fill(steerText);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitFor(async () => (await page.getByText(steerText, { exact: false }).count()) > 0, {
    label: 'steer echoed into transcript',
  });
  const steerReply = `Steer received: "${steerText}". Continuing in mock mode.`;
  const steerReplyHead = steerReply.slice(0, 8);
  await waitFor(
    async () =>
      (await page.getByText(steerReplyHead, { exact: false }).count()) > 0 &&
      (await page.getByText(steerReply, { exact: true }).count()) === 0,
    { interval: 10, label: 'partial mock steer reply before completion' },
  );
  await waitFor(async () => (await page.getByText(steerReply, { exact: true }).count()) > 0, {
    label: 'exact completed mock steer reply',
  });
  steerStep.ok = true;
  steerStep.detail = `saw "${steerReplyHead}…" before exact final text`;

  const archiveStep = record('archive: via UI, assert it leaves the active list');
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive session' }).click();
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      if (!res.ok) return false;
      const active = await res.json();
      return !active.some((s) => s.id === session.id);
    },
    { label: 'session to leave the active list' },
  );
  await waitFor(async () => !page.url().includes(`/session/${session.id}`), {
    label: 'UI to leave the archived session view',
  });
  archiveStep.ok = true;

  // Restore dark theme for the visual baseline the rest of the suite expects.
  await page.evaluate(() => {
    localStorage.setItem('nuncio-theme', 'dark');
    document.documentElement.classList.add('dark');
  });
}
