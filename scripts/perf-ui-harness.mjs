// UI smoothness measurement pass. Rides the SAME hermetic stack as the level-5
// smoke (isolated ephemeral-port daemon, NUNCIO_FORCE_MOCK=1, real system Chrome
// via playwright-core) and measures four things a user feels: time-to-first-delta,
// main-thread blocking while a reply streams, scroll cost on a long transcript,
// and composer input latency. Each metric is the MEDIAN of N samples (default 5,
// min 3) so a single noisy frame can't move it; the numbers are written to
// scripts/perf-metrics.json for the ratchet gate (scripts/check-perf-ratchet.mjs).
//
// Usage: bun run perf:ui                 (measure; reuses an existing web build)
//        bun run perf:ui --build         (force a fresh web build first)
//        bun run perf:ui --samples 7     (override the sample count)
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureWebBuild, findFreePort, repoRoot, startServer } from './smoke-ui-stack.mjs';
import { createMockSession, seedTranscript, waitSessionIdle } from './lib/mock-session.mjs';
import {
  measureKeyEchoSample,
  measureScrollSample,
  measureStreamingSample,
  SEED_TURNS,
} from './lib/perf-ui-probe.mjs';
import { summarize } from './perf-ratchet-utils.mjs';

const FORCE_BUILD = process.argv.includes('--build');
const CHROME_EXECUTABLE = process.env.NUNCIO_SMOKE_CHROME_EXECUTABLE?.trim();
const CHROME_CHANNEL = process.env.NUNCIO_SMOKE_CHROME_CHANNEL?.trim() || 'chrome';
const METRICS_PATH = join(repoRoot, 'scripts', 'perf-metrics.json');
const SAMPLES = Math.max(3, Number(argFlag('--samples') ?? process.env.PERF_SAMPLES ?? 5));
const STEP_TIMEOUT_MS = 30000;

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function waitFor(fn, { timeout = STEP_TIMEOUT_MS, interval = 100, label } = {}) {
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
  throw new Error(`perf: timed out (${timeout}ms) waiting for ${label ?? 'condition'}`);
}

async function main() {
  await ensureWebBuild({ force: FORCE_BUILD });
  const port = await findFreePort();
  const server = await startServer({ port });
  const { baseUrl, dataDir } = server;

  let browser;
  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => cleanup().finally(() => process.exit(1)));
  }

  try {
    // Build one large, IDLE mock session, seed a long transcript straight into
    // the durable log, then load it once — every metric is measured under this
    // realistic DOM weight.
    const session = await createMockSession(baseUrl, 'Perf: measure UI smoothness');
    await waitSessionIdle(baseUrl, session.id, waitFor);
    const { inserted } = seedTranscript(dataDir, session.id, SEED_TURNS);

    browser = await chromium.launch({
      ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : { channel: CHROME_CHANNEL }),
      headless: true,
    });
    const context = await browser.newContext({
      colorScheme: 'dark',
      reducedMotion: 'reduce', // instant scrolls; no CSS transition noise
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.getByPlaceholder(/Steer the agent/i).count(), {
      label: 'session detail to hydrate',
    });
    await waitFor(
      async () =>
        (await page.evaluate(
          () => document.querySelector('[data-chat-transcript]')?.children.length ?? 0,
        )) >= SEED_TURNS,
      { label: 'seeded transcript to render' },
    );

    // Warm-up (JIT + first-layout settle) — measured then discarded.
    await measureStreamingSample(page, -1);
    await waitSessionIdle(baseUrl, session.id, waitFor);
    await measureScrollSample(page);

    const raw = { ttfdMs: [], streamBlockingMs: [], keyEchoMs: [], scrollSweepMs: [] };
    let scrollBlocks = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const stream = await measureStreamingSample(page, i);
      raw.ttfdMs.push(stream.ttfdMs);
      raw.streamBlockingMs.push(stream.streamBlockingMs);
      await waitSessionIdle(baseUrl, session.id, waitFor);
      const echo = await measureKeyEchoSample(page);
      raw.keyEchoMs.push(echo.keyEchoMs);
      const scroll = await measureScrollSample(page);
      raw.scrollSweepMs.push(scroll.scrollSweepMs);
      scrollBlocks = scroll.scrollBlocks;
    }

    const metrics = Object.fromEntries(
      Object.entries(raw).map(([name, samples]) => [name, summarize(samples)]),
    );
    const machine = {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      platform: `${process.platform}/${process.arch}`,
      runtime: `bun ${process.versions.bun}`,
      date: new Date().toISOString().slice(0, 10),
    };
    const report = {
      machine,
      samples: SAMPLES,
      seedTurns: SEED_TURNS,
      scrollBlocks,
      seededEvents: inserted,
      metrics,
    };
    await writeFile(METRICS_PATH, `${JSON.stringify(report, null, 2)}\n`);
    printTable(report);
    console.log(`\n[perf] wrote ${METRICS_PATH}`);
    await cleanup();
    process.exit(0);
  } catch (err) {
    console.error('\n[perf] FAIL', err?.stack ?? err?.message ?? err);
    await cleanup();
    process.exit(1);
  }
}

function printTable(report) {
  console.log(
    `\n[perf] ${report.machine.cpu} (${report.machine.cores}c) ${report.machine.platform} ${report.machine.runtime}`,
  );
  console.log(
    `[perf] ${report.samples} samples · ${report.scrollBlocks} transcript blocks (${report.seededEvents} seeded events)`,
  );
  console.log('metric              median     min     max      cv');
  for (const [name, s] of Object.entries(report.metrics)) {
    console.log(
      `${name.padEnd(18)} ${String(s.median).padStart(7)} ${String(s.min).padStart(7)} ` +
        `${String(s.max).padStart(7)} ${String(s.cv).padStart(7)}`,
    );
  }
}

main().catch(async (err) => {
  console.error('[perf] FATAL', err?.stack ?? err);
  process.exit(1);
});
