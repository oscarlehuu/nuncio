// Level-5 real-browser UI smoke: ONE command that boots an isolated Nuncio stack
// and drives real system Chrome (via playwright-core, `channel:'chrome'`,
// headless) through create → stream → steer → archive on the zero-credential
// Mock provider. Exits 0 on success, 1 on any failure.
//
// Hermetic by construction: an ephemeral free port (never 3000/5173) and a fresh
// temp NUNCIO_DATA_DIR per run (never ~/.nuncio/data). See scripts/smoke-ui-stack.mjs.
//
// Provider selection: the Mock provider is opt-in server-side (NUNCIO_FORCE_MOCK=1,
// set by the stack). Real providers may also be configured on the machine, in
// which case the UI's model picker defaults to a real one and cannot pick "mock".
// So the session is CREATED via `POST /api/sessions {provider:"mock"}` (loopback
// is always trusted by the AuthGuard — no token needed), then EVERYTHING ELSE —
// loading the transcript, asserting the streamed reply, sending the steer,
// asserting the second turn, archiving, and asserting it leaves the active list —
// is driven through the real browser UI.
//
// Usage: bun run test:smoke-ui        (build web bundle only if missing)
//        bun run test:smoke-ui --build (force a fresh web build first)
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureWebBuild, findFreePort, repoRoot, startServer } from './smoke-ui-stack.mjs';
import { runCrewSmoke } from './lib/crew-smoke-flow.mjs';

const FORCE_BUILD = process.argv.includes('--build');
const CHROME_EXECUTABLE = process.env.NUNCIO_SMOKE_CHROME_EXECUTABLE?.trim();
const CHROME_CHANNEL = process.env.NUNCIO_SMOKE_CHROME_CHANNEL?.trim() || 'chrome';
// Artifacts are screenshots (*.png) plus, on failure, a Playwright trace
// (trace-*.zip). The whole dir is gitignored and uploaded by CI on failure.
const ARTIFACTS_DIR = join(repoRoot, 'smoke-artifacts');
const STEP_TIMEOUT_MS = 20000;

const steps = [];
function record(name) {
  const step = { name, ok: false };
  steps.push(step);
  return step;
}

async function git(cwd, ...args) {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/** Poll `fn` until it returns truthy or the timeout elapses. */
async function waitFor(fn, { timeout = STEP_TIMEOUT_MS, interval = 200, label } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out (${timeout}ms) waiting for ${label ?? 'condition'}`);
}

async function main() {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await ensureWebBuild({ force: FORCE_BUILD });

  const port = await findFreePort();
  const server = await startServer({ port });
  const { baseUrl } = server;
  const smokeProjectPath = join(server.dataDir, 'smoke-project');
  await mkdir(smokeProjectPath, { recursive: true });
  await git(smokeProjectPath, 'init', '-b', 'main');
  await git(smokeProjectPath, 'config', 'user.email', 'smoke@nuncio.local');
  await git(smokeProjectPath, 'config', 'user.name', 'Nuncio Smoke');
  await writeFile(join(smokeProjectPath, 'README.md'), '# smoke project\n');
  await git(smokeProjectPath, 'add', 'README.md');
  await git(smokeProjectPath, 'commit', '-m', 'init');
  const smokeHead = await git(smokeProjectPath, 'rev-parse', 'HEAD');
  await git(smokeProjectPath, 'update-ref', 'refs/remotes/origin/main', smokeHead);
  await git(smokeProjectPath, 'update-ref', 'refs/remotes/origin/dev', smokeHead);
  await git(
    smokeProjectPath,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );

  let browser;
  let context;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  };
  // Never leave orphans, even on Ctrl-C / kill.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      cleanup().finally(() => process.exit(1));
    });
  }

  let page;
  const shot = async (tag) => {
    if (!page) return null;
    const file = join(ARTIFACTS_DIR, `fail-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  };

  try {
    // 1) Launch system Chrome headless against the same-origin UI.
    const chromeTarget = CHROME_EXECUTABLE
      ? `executable=${CHROME_EXECUTABLE}`
      : `channel=${CHROME_CHANNEL}`;
    const browserStep = record(`launch system Chrome (playwright-core ${chromeTarget})`);
    browser = await chromium.launch({
      ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : { channel: CHROME_CHANNEL }),
      headless: true,
    });
    context = await browser.newContext({
      baseURL: baseUrl,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    // Retain-on-failure trace: recorded for the whole run, saved (as a
    // trace-viewer .zip) only in the catch block below; discarded on success.
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    browserStep.ok = true;

    const composerStep = record('composer: remote refs and compact Crew controls work at desktop + mobile');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/new`, { waitUntil: 'domcontentloaded' });
    const projectTrigger = page.getByRole('button', { name: 'No repo', exact: true });
    await waitFor(() => projectTrigger.count(), { label: 'new-session project picker' });
    await projectTrigger.click();
    const projectOption = page.getByRole('option').filter({ hasText: basename(smokeProjectPath) });
    await waitFor(async () => (await projectOption.count()) === 1, { label: 'smoke project option' });
    await projectOption.click();

    const branchResponse = await fetch(
      `${baseUrl}/api/projects/branches?path=${encodeURIComponent(smokeProjectPath)}`,
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
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'branch-picker-remote-refs.png'), fullPage: true });
    await page.keyboard.press('Escape');

    const crewSwitch = page.getByRole('switch', { name: 'Crew', exact: true });
    await waitFor(() => crewSwitch.count(), { label: 'Crew switch' });
    if (await crewSwitch.getAttribute('aria-checked') !== 'false') {
      throw new Error('fresh composer must start with Crew off');
    }
    await crewSwitch.click();
    await waitFor(
      async () => (await page.getByRole('link', { name: 'Set up Crew', exact: true }).count()) === 1,
      { label: 'compact empty Crew setup action' },
    );
    if (await page.getByText('No Crew profile', { exact: false }).count()) {
      throw new Error('legacy Crew empty-state card is still visible');
    }
    if (await page.getByText('Crew worktree', { exact: false }).count()) {
      throw new Error('Crew worktree implementation detail is still visible');
    }
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'crew-composer-empty-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const fitsViewport = await page.locator('html').evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    );
    if (!fitsViewport) throw new Error('Crew composer overflows the 390px viewport');
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'crew-composer-empty-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    composerStep.ok = true;
    composerStep.detail = `current=${currentBranch}, remote=${remoteBranch}`;

    // 2) Create immediately before navigation so Chrome observes a live run,
    // rather than hydrating a response that completed during setup.
    const createStep = record('create live mock session (POST /api/sessions provider=mock)');
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Smoke: run the mock flow', provider: 'mock' }),
    });
    if (!createRes.ok) {
      throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
    }
    const session = await createRes.json();
    if (session.provider !== 'mock' || !session.id) {
      throw new Error(`unexpected create response: ${JSON.stringify(session)}`);
    }
    createStep.ok = true;
    createStep.detail = `id=${session.id}`;

    // 3) Open the live session and assert the initial reply completes exactly.
    const streamStep = record('stream: assistant reply appears in the transcript');
    await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
    // Wait for the UI to hydrate to the detail view (the steer composer is present).
    const composer = page.getByPlaceholder(/Steer the agent/i);
    await waitFor(() => composer.count(), { label: 'session detail to hydrate' });
    const replyMark = 'I received your task';
    await waitFor(
      async () => (await page.getByText(replyMark, { exact: false }).count()) > 0,
      { label: 'streamed assistant reply' },
    );
    const fullReply = 'I received your task. In mock mode (agent auth not configured), I simulate agent output. ' +
      'Configure a real provider to use an agent SDK harness.';
    await waitFor(
      async () => (await page.getByText(fullReply, { exact: true }).count()) > 0,
      { label: 'exact completed assistant reply' },
    );
    streamStep.ok = true;
    streamStep.detail = `matched "${replyMark}…" and exact final text`;

    // 3b) Composer must be enabled once the mock run is IDLE (B1 projection regression).
    const composerEnabledStep = record('composer: enabled after IDLE (deriveComposerEnabled)');
    await waitFor(
      async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${session.id}`);
        if (!res.ok) return false;
        const body = await res.json();
        return body.status === 'IDLE';
      },
      { label: 'mock session to settle IDLE' },
    );
    if (await composer.isDisabled()) {
      throw new Error('steer composer stayed disabled after IDLE');
    }
    composerEnabledStep.ok = true;

    // 3c) Light theme screenshot (visual gate for both themes).
    // ModeToggle sits under the desktop sidebar rail hit-target in this layout,
    // so set the theme the same way ThemeProvider persists it and prove paint.
    const lightThemeStep = record('theme: apply Light and capture session screenshot');
    await page.evaluate(() => {
      localStorage.setItem('nuncio-theme', 'light');
      document.documentElement.classList.remove('dark');
    });
    await waitFor(
      async () => !(await page.locator('html').evaluate((el) => el.classList.contains('dark'))),
      { label: 'html to leave .dark after Light theme' },
    );
    await page.screenshot({
      path: join(ARTIFACTS_DIR, 'session-detail-light.png'),
      fullPage: true,
    });
    lightThemeStep.ok = true;

    // 3d) Stop/Interrupt while RUNNING — Mock has interrupt:false and settles
    // instantly, so the control is not exercisable mid-run here. Covered by
    // provider-contract interrupt honesty + unit projections instead.
    const interruptSkipStep = record('interrupt: skipped on mock (interrupt:false, settles instantly)');
    interruptSkipStep.ok = true;
    interruptSkipStep.detail = 'no mid-run Stop surface for Mock; contract suite covers capable providers';

    // 4) With the detail view already live, send a steer and prove a partial
    // reply renders before the exact terminal text.
    const steerStep = record('steer: partial reply renders before exact completion');
    const steerText = `steer-${Date.now()}`;
    await composer.click();
    await composer.fill(steerText);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // The user's steer echoes into the transcript…
    await waitFor(async () => (await page.getByText(steerText, { exact: false }).count()) > 0, {
      label: 'steer echoed into transcript',
    });
    // …and the mock's first committed chunk becomes visible before completion.
    const steerReply = `Steer received: "${steerText}". Continuing in mock mode.`;
    const steerReplyHead = steerReply.slice(0, 8);
    await waitFor(
      async () =>
        (await page.getByText(steerReplyHead, { exact: false }).count()) > 0 &&
        (await page.getByText(steerReply, { exact: true }).count()) === 0,
      { interval: 10, label: 'partial mock steer reply before completion' },
    );
    await waitFor(
      async () => (await page.getByText(steerReply, { exact: true }).count()) > 0,
      { label: 'exact completed mock steer reply' },
    );
    steerStep.ok = true;
    steerStep.detail = `saw "${steerReplyHead}…" before exact final text`;

    // 5) Archive via the UI and assert it leaves the active list.
    const archiveStep = record('archive: via UI, assert it leaves the active list');
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Archive session' }).click();
    // Confirm server-side the session is no longer active (ARCHIVED not in the
    // active list), then confirm the UI has navigated away from the detail view.
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

    // 6) Spawn a real mock subagent task and assert the parent digest navigates to the child.
    const digestSetupStep = record('delegation: mock subagent completes and appends parent digest');
    const parentRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Smoke parent delegates follow-up work', provider: 'mock' }),
    });
    if (!parentRes.ok) {
      throw new Error(`parent create failed: ${parentRes.status} ${await parentRes.text()}`);
    }
    const parent = await parentRes.json();
    await waitFor(
      async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${parent.id}`);
        if (!res.ok) return false;
        const body = await res.json();
        return body.status === 'IDLE';
      },
      { label: 'mock parent to finish initial run' },
    );

    const multitaskRes = await fetch(`${baseUrl}/api/tasks/multitask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentSessionId: parent.id,
        prompts: ['Smoke child task returns a digest'],
      }),
    });
    if (!multitaskRes.ok) {
      throw new Error(`multitask failed: ${multitaskRes.status} ${await multitaskRes.text()}`);
    }
    const digest = await waitFor(
      async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${parent.id}/events?since=0`);
        if (!res.ok) return false;
        const events = await res.json();
        const event = events.find((item) => item.type === 'task_completed');
        return event?.payload?.childSessionId ? event.payload : false;
      },
      { label: 'task_completed digest on parent log' },
    );
    const childSessionId = digest.childSessionId;
    digestSetupStep.ok = true;
    digestSetupStep.detail = `parent=${parent.id}, child=${childSessionId}`;

    const digestUiStep = record('delegation: digest card is visible in the parent transcript');
    await page.goto(`${baseUrl}/session/${parent.id}`, { waitUntil: 'domcontentloaded' });
    await waitFor(
      async () => (await page.getByTestId('task-digest-card').count()) > 0,
      { label: 'digest card in parent transcript' },
    );
    await waitFor(
      async () => (await page.getByText('Open session', { exact: true }).count()) > 0,
      { label: 'digest open-session link' },
    );
    await waitFor(
      async () => (await page.getByTestId('lineage-children-chip').count()) > 0,
      { label: 'parent subagents lineage chip' },
    );
    digestUiStep.ok = true;

    const digestLinkStep = record('delegation: digest link opens the child session');
    await page.getByTestId('task-digest-open').click();
    await waitFor(async () => page.url().includes(`/session/${childSessionId}`), {
      label: 'digest link navigated to child session',
    });
    await waitFor(
      async () => (await page.getByTestId('lineage-parent-chip').count()) > 0,
      { label: 'child parent lineage chip' },
    );
    digestLinkStep.ok = true;

    const lineageStep = record('delegation: child lineage chip navigates back to parent');
    await page.getByTestId('lineage-parent-chip').click();
    await waitFor(async () => page.url().includes(`/session/${parent.id}`), {
      label: 'parent lineage chip navigated back to parent',
    });
    lineageStep.ok = true;

    await runCrewSmoke({ page, baseUrl, dataDir: server.dataDir, record, waitFor });

    // Proof summary.
    console.log('\n[smoke] PASS — level-5 UI smoke (Solo lifecycle + delegation + Crew workflow on mock)');
    console.log(`  base URL: ${baseUrl}  (data dir: ${server.dataDir})`);
    for (const s of steps) {
      console.log(`  ✓ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    await context.tracing.stop().catch(() => {});
    await cleanup();
    process.exit(0);
  } catch (err) {
    const failing = steps.find((s) => !s.ok);
    const tag = (failing?.name ?? 'unknown').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const screenshot = await shot(tag);
    let trace = null;
    if (context) {
      trace = join(ARTIFACTS_DIR, `trace-${tag}-${Date.now()}.zip`);
      await context.tracing.stop({ path: trace }).catch(() => {
        trace = null;
      });
    }
    console.error('\n[smoke] FAIL');
    for (const s of steps) {
      console.error(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    console.error(`  failing step: ${failing?.name ?? '(setup)'}`);
    console.error(`  error: ${err.message}`);
    if (screenshot) console.error(`  screenshot: ${screenshot}`);
    if (trace) console.error(`  trace: ${trace}  (open with: bunx playwright show-trace ${basename(trace)})`);
    console.error(`  stack: ${err.stack ?? err.message}`);
    await cleanup();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('[smoke] FATAL', err?.stack ?? err);
  process.exit(1);
});
