// Journey (regression guard): switching theme (dark <-> light) mid-session keeps
// the transcript and steer composer usable and fully styled — the flip is only a
// class change on <html>, never an unstyled flash.
import { createMockSession, MOCK_TASK_REPLY, waitSessionIdle } from '../lib/mock-session.mjs';

async function htmlIsDark(page) {
  return page.locator('html').evaluate((el) => el.classList.contains('dark'));
}

/** Body background-color as the browser computes it (proves CSS is applied). */
function bodyBackground(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function assertUsableAndStyled(page, waitFor, themeLabel) {
  // Transcript still rendered with its content.
  if ((await page.getByText(MOCK_TASK_REPLY, { exact: true }).count()) === 0) {
    throw new Error(`transcript lost its content after switching to ${themeLabel}`);
  }
  // Steer composer still present and enabled.
  const composer = page.getByPlaceholder(/Steer the agent/i);
  if ((await composer.count()) === 0 || (await composer.isDisabled())) {
    throw new Error(`steer composer not usable after switching to ${themeLabel}`);
  }
  // No unstyled flash: the surface keeps a real (non-transparent) themed color.
  const bg = await bodyBackground(page);
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
    throw new Error(`unstyled surface after switching to ${themeLabel}: background=${bg}`);
  }
  return bg;
}

export async function runThemeSwitchMidSession(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const setup = record('theme: open a settled mock session, then reveal the theme control');
  const session = await createMockSession(baseUrl, 'Theme smoke: session that survives theme flips');
  await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await page.getByText(MOCK_TASK_REPLY, { exact: true }).count()) > 0, {
    label: 'reply present before theme flips',
  });
  await waitSessionIdle(baseUrl, session.id, waitFor);
  // Pin the sidebar so the ModeToggle is a clickable control (the collapsed rail
  // flyout is pointer-events-none).
  await page.locator('[data-testid="desktop-nav-toggle"]').first().click();
  const sidebar = page.locator('[data-testid="desktop-sidebar-pinned"]');
  await waitFor(() => sidebar.count(), { label: 'pinned sidebar with theme control' });
  const toggle = sidebar.getByRole('button', { name: 'Toggle theme' });
  await waitFor(() => toggle.count(), { label: 'theme toggle' });
  setup.ok = true;

  const setTheme = async (label) => {
    await toggle.click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };

  // Baseline Dark, then flip Light -> Dark, asserting usability + styling each time.
  const flip = record('theme: dark -> light -> dark keeps transcript + composer usable and styled');
  await setTheme('Dark');
  await waitFor(async () => await htmlIsDark(page), { label: 'html is dark (baseline)' });
  const darkBg = await assertUsableAndStyled(page, waitFor, 'Dark');

  await setTheme('Light');
  await waitFor(async () => !(await htmlIsDark(page)), { label: 'html leaves .dark for Light' });
  const lightBg = await assertUsableAndStyled(page, waitFor, 'Light');
  if (lightBg === darkBg) {
    throw new Error(`theme flip did not restyle the surface (dark and light share ${lightBg})`);
  }

  await setTheme('Dark');
  await waitFor(async () => await htmlIsDark(page), { label: 'html returns to .dark' });
  await assertUsableAndStyled(page, waitFor, 'Dark');
  flip.ok = true;
  flip.detail = `dark=${darkBg}, light=${lightBg}`;

  // Restore the collapsed rail so later journeys start from the shared baseline.
  await page.locator('[data-testid="desktop-nav-toggle"]').first().click();
}
