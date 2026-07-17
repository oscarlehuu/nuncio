// Level-5 real-browser JOURNEY SUITE. ONE command boots an isolated Nuncio
// stack and drives real system Chrome (playwright-core, `channel:'chrome'`,
// headless) through a set of small, named per-feature journeys on the
// zero-credential Mock provider. Exits 0 on success, 1 on any failure.
//
// Hermetic by construction: an ephemeral free port (never 3000/5173) and a fresh
// temp NUNCIO_DATA_DIR per run (never ~/.nuncio/data). See scripts/smoke-ui-stack.mjs.
//
// Each journey is a module under scripts/journeys/ that registers named steps via
// the shared record() and asserts through the real UI. The orchestrator owns the
// browser, the server lifecycle (including a mid-run restart for the reconnect
// journey), tracing, and per-journey failure artifacts.
//
// Provider selection: the Mock provider is opt-in server-side (NUNCIO_FORCE_MOCK=1,
// set by the stack). Sessions are CREATED via loopback REST (always trusted by the
// AuthGuard — no token) so the browser then drives/observes everything else.
//
// Usage: bun run test:smoke-ui        (build web bundle only if missing)
//        bun run test:smoke-ui --build (force a fresh web build first)
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureWebBuild, findFreePort, repoRoot, startServer } from './smoke-ui-stack.mjs';
import { runCrewSmoke } from './lib/crew-smoke-flow.mjs';
import { runComposerControls } from './journeys/composer-controls.mjs';
import { runSessionModes } from './journeys/session-modes.mjs';
import { runSoloLifecycle } from './journeys/solo-session-lifecycle.mjs';
import { runSubagentDelegation } from './journeys/subagent-delegation.mjs';
import { runMultitaskFanout } from './journeys/multitask-fanout.mjs';
import { runSessionChips } from './journeys/session-chips.mjs';
import { runDebugReproduceGate } from './journeys/debug-reproduce-gate.mjs';
import { runArchiveLastSession } from './journeys/archive-last-session.mjs';
import { runModelPreferencesPerComposer } from './journeys/model-preferences-per-composer.mjs';
import { runTranscriptSelectionCopy } from './journeys/transcript-selection-copy.mjs';
import { runThemeSwitchMidSession } from './journeys/theme-switch-mid-session.mjs';
import { runWebsocketReconnect } from './journeys/websocket-reconnect.mjs';

const FORCE_BUILD = process.argv.includes('--build');
const CHROME_EXECUTABLE = process.env.NUNCIO_SMOKE_CHROME_EXECUTABLE?.trim();
const CHROME_CHANNEL = process.env.NUNCIO_SMOKE_CHROME_CHANNEL?.trim() || 'chrome';
// Artifacts are screenshots (*.png) plus, on failure, a Playwright trace
// (trace-*.zip). The whole dir is gitignored and uploaded by CI on failure.
const ARTIFACTS_DIR = join(repoRoot, 'smoke-artifacts');
const STEP_TIMEOUT_MS = 20000;

// Ordered journeys. archive-last runs first for a clean, deterministic "last
// remaining session"; reconnect (which restarts the server) runs before the long
// Crew flow so it never disrupts a live Crew run.
const JOURNEYS = [
  { name: 'archive-last-session', run: runArchiveLastSession },
  { name: 'composer-controls', run: runComposerControls },
  { name: 'session-modes', run: runSessionModes },
  { name: 'solo-session-lifecycle', run: runSoloLifecycle },
  { name: 'subagent-delegation', run: runSubagentDelegation },
  { name: 'multitask-fanout', run: runMultitaskFanout },
  { name: 'session-chips', run: runSessionChips },
  { name: 'debug-reproduce-gate', run: runDebugReproduceGate },
  { name: 'model-preferences-per-composer', run: runModelPreferencesPerComposer },
  { name: 'transcript-selection-copy', run: runTranscriptSelectionCopy },
  { name: 'theme-switch-mid-session', run: runThemeSwitchMidSession },
  { name: 'websocket-reconnect', run: runWebsocketReconnect },
  { name: 'crew-workflow', run: runCrewSmoke },
];

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

const slug = (text) => (text ?? 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);

async function main() {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await ensureWebBuild({ force: FORCE_BUILD });

  const port = await findFreePort();
  // Mutable so the reconnect journey can reboot the daemon on the same durable DB.
  let server = await startServer({ port });
  const { baseUrl, dataDir } = server;

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

  // Kill the daemon (keeping its DB) and reboot it on the same port + data dir.
  const restartServer = async () => {
    await server.stop({ removeDataDir: false });
    server = await startServer({ port, dataDir });
    return server.baseUrl;
  };

  let page;
  const shot = async (tag) => {
    if (!page) return null;
    const file = join(ARTIFACTS_DIR, `fail-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  };

  let currentJourney = 'setup';
  try {
    // Launch system Chrome headless against the same-origin UI.
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
      // The transcript auto-copy journey reads/writes the clipboard.
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    // Retain-on-failure trace: recorded for the whole run, saved (as a
    // trace-viewer .zip) only in the catch block below; discarded on success.
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    browserStep.ok = true;

    const ctx = { page, baseUrl, dataDir, waitFor, record, artifactsDir: ARTIFACTS_DIR, restartServer };
    for (const journey of JOURNEYS) {
      currentJourney = journey.name;
      await journey.run(ctx);
    }

    console.log('\n[smoke] PASS — level-5 UI journey suite on the Mock provider');
    console.log(`  base URL: ${baseUrl}  (data dir: ${dataDir})`);
    for (const s of steps) {
      console.log(`  ✓ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    await context.tracing.stop().catch(() => {});
    await cleanup();
    process.exit(0);
  } catch (err) {
    const failing = steps.find((s) => !s.ok);
    const tag = `${slug(currentJourney)}-${slug(failing?.name ?? 'setup')}`;
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
    console.error(`  failing journey: ${currentJourney}`);
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
