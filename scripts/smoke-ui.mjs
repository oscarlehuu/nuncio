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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureWebBuild, findFreePort, repoRoot, startServer } from './smoke-ui-stack.mjs';

const FORCE_BUILD = process.argv.includes('--build');
const CHROME_EXECUTABLE = process.env.NUNCIO_SMOKE_CHROME_EXECUTABLE?.trim();
const CHROME_CHANNEL = process.env.NUNCIO_SMOKE_CHROME_CHANNEL?.trim() || 'chrome';
// Artifacts are screenshots only (*.png), which the repo .gitignore already
// ignores globally — so this dir never shows up in git status.
const ARTIFACTS_DIR = join(repoRoot, 'smoke-artifacts');
const STEP_TIMEOUT_MS = 20000;

const steps = [];
function record(name) {
  const step = { name, ok: false };
  steps.push(step);
  return step;
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

  let browser;
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
    // 1) Create the session on the Mock provider via the API (see header note).
    const createStep = record('create mock session (POST /api/sessions provider=mock)');
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

    // 2) Launch system Chrome headless against the same-origin UI.
    const chromeTarget = CHROME_EXECUTABLE
      ? `executable=${CHROME_EXECUTABLE}`
      : `channel=${CHROME_CHANNEL}`;
    const browserStep = record(`launch system Chrome (playwright-core ${chromeTarget})`);
    browser = await chromium.launch({
      ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : { channel: CHROME_CHANNEL }),
      headless: true,
    });
    const context = await browser.newContext({ baseURL: baseUrl });
    page = await context.newPage();
    browserStep.ok = true;

    // 3) Open the session in the UI and assert the streamed assistant text.
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
    streamStep.ok = true;
    streamStep.detail = `matched "${replyMark}…"`;

    // 4) Send a steer through the UI composer and assert the second turn.
    const steerStep = record('steer: send via UI, assert the reply turn appears');
    const steerText = `steer-${Date.now()}`;
    await composer.click();
    await composer.fill(steerText);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // The user's steer echoes into the transcript…
    await waitFor(async () => (await page.getByText(steerText, { exact: false }).count()) > 0, {
      label: 'steer echoed into transcript',
    });
    // …and the mock's steer-specific reply streams back.
    const steerReplyMark = 'Steer received';
    await waitFor(
      async () => (await page.getByText(steerReplyMark, { exact: false }).count()) > 0,
      { label: 'mock steer reply' },
    );
    steerStep.ok = true;
    steerStep.detail = `sent "${steerText}", saw "${steerReplyMark}…"`;

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

    // Proof summary.
    console.log('\n[smoke] PASS — level-5 UI smoke (create → stream → steer → archive + delegation on mock)');
    console.log(`  base URL: ${baseUrl}  (data dir: ${server.dataDir})`);
    for (const s of steps) {
      console.log(`  ✓ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    await cleanup();
    process.exit(0);
  } catch (err) {
    const failing = steps.find((s) => !s.ok);
    const tag = (failing?.name ?? 'unknown').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const screenshot = await shot(tag);
    console.error('\n[smoke] FAIL');
    for (const s of steps) {
      console.error(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    console.error(`  failing step: ${failing?.name ?? '(setup)'}`);
    console.error(`  error: ${err.message}`);
    if (screenshot) console.error(`  screenshot: ${screenshot}`);
    console.error(`  stack: ${err.stack ?? err.message}`);
    await cleanup();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('[smoke] FATAL', err?.stack ?? err);
  process.exit(1);
});
