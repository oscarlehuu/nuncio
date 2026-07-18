// Provider canary: prove the REAL production path (HTTP → SessionsService →
// AgentRegistry → provider adapter → SDK → stream → event log) end-to-end for
// every available engine, on the CHEAPEST model tier only — never a flagship
// (docs/testing-and-verification.md → engine/model cost rule). Every assertion
// is mechanical (event shape + settled status), not semantic, so a weak model
// passes as reliably as a strong one.
//
// Hermetic by construction (scripts/lib/hermetic-stack.mjs): ephemeral port,
// fresh temp NUNCIO_DATA_DIR — the user's real sessions/data are never touched.
// Real-provider credentials are inherited from the machine (Pi auth file, Codex
// CLI login, Claude keychain, CURSOR_API_KEY env). Note: settings stored only in
// the real DB (e.g. a Settings-UI Cursor key) are invisible to the hermetic
// daemon — such providers report as skipped, not failed.
//
// Usage:
//   bun run canary                 local, all available real providers, cheap tier
//   bun run canary:mock            zero-credential Mock canary (CI runs this)
//   bun run canary -- --providers pi,codex --timeout 90000
//   bun run canary -- --allow-any-model   opt-in first-listed model when no cheap tier
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findFreePort, startServer } from './lib/hermetic-stack.mjs';
import {
  assessCanaryEvents,
  CANARY_MARKER,
  isCheapTierModel,
  parseCanaryArgs,
  pickCanaryModel,
  renderCanaryReport,
} from './provider-canary-utils.mjs';

const POLL_INTERVAL_MS = 500;
const CANARY_PROMPT =
  `Reply with exactly the text ${CANARY_MARKER} and nothing else. Do not use any tools.`;

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

/** GET /api/models → Map(providerId → flattened [{id, name}]). Server-filtered by isAvailable. */
async function fetchAvailableProviders(baseUrl) {
  const providers = await getJson(baseUrl, '/api/models');
  const map = new Map();
  for (const p of providers) {
    const models = (p.groups ?? []).flatMap((g) =>
      (g.models ?? []).map((m) => ({ id: m.id, name: m.name })),
    );
    map.set(p.id, models);
  }
  return map;
}

async function createSession(baseUrl, { provider, model, workspace }) {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: CANARY_PROMPT, provider, model, workspace }),
  });
  const created = await res.json().catch(() => ({}));
  if (!res.ok || !created?.id) {
    throw new Error(`create session failed: ${res.status} ${JSON.stringify(created)}`);
  }
  return created;
}

/** Poll the session until it settles IDLE/ERROR or the budget elapses. */
async function pollSettled(baseUrl, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = 'CREATED';
  while (Date.now() < deadline) {
    const dto = await getJson(baseUrl, `/api/sessions/${sessionId}`);
    status = dto.status;
    if (status === 'IDLE' || status === 'ERROR') return { status, timedOut: false };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status, timedOut: true };
}

/** Compact one-line-per-event dump of the log tail — printed on FAIL for diagnosis. */
function dumpEventTail(events, limit = 20) {
  return events
    .slice(-limit)
    .map((e) => `  #${e.seq} ${e.type} ${JSON.stringify(e.payload ?? {}).slice(0, 200)}`)
    .join('\n');
}

async function runProviderCanary(baseUrl, { provider, modelId, workspace, timeoutMs, marker }) {
  const started = Date.now();
  const session = await createSession(baseUrl, { provider, model: modelId, workspace });
  const { status, timedOut } = await pollSettled(baseUrl, session.id, timeoutMs);
  const events = await getJson(baseUrl, `/api/sessions/${session.id}/events?since=0`);
  const verdict = assessCanaryEvents({ events, sessionStatus: status, marker });
  if (!verdict.ok || timedOut) {
    console.error(`[canary] ${provider} event log tail:\n${dumpEventTail(events)}`);
  }

  const notes = [...verdict.failures];
  // The timeout is the budget guard: a cheap model that cannot finish a one-line
  // echo inside the budget is itself a regression signal (tool loop, stuck run).
  if (timedOut) notes.unshift(`timeout: not settled after ${timeoutMs}ms (status ${status})`);
  if (verdict.turns > 1) notes.push(`unexpected extra turns: ${verdict.turns}`);

  // Best-effort dispose of the provider handle before daemon teardown.
  await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, { method: 'POST' }).catch(() => {});

  return {
    provider,
    model: modelId,
    ok: verdict.ok && !timedOut,
    durationMs: Date.now() - started,
    turns: verdict.turns,
    notes,
  };
}

async function main() {
  const args = parseCanaryArgs(process.argv.slice(2));
  const port = await findFreePort();
  // hermetic-stack defaults NUNCIO_FORCE_MOCK=1; real mode overrides it off so
  // the canary sees exactly the providers a normal boot would register.
  const server = await startServer({
    port,
    env: args.mock ? {} : { NUNCIO_FORCE_MOCK: '0' },
  });

  try {
    const available = await fetchAvailableProviders(server.baseUrl);
    const targets =
      args.providers ?? (args.mock ? ['mock'] : [...available.keys()].filter((id) => id !== 'mock'));

    // Each canary run gets a scratch cwd inside the temp data dir so no provider
    // ever operates in a real project.
    const workspace = join(server.dataDir, 'canary-workspace');
    await mkdir(workspace, { recursive: true });

    const rows = [];
    for (const provider of targets) {
      const models = available.get(provider);
      if (!models) {
        // Explicitly requested but not available = FAIL: a canary that silently
        // skips what it was asked to ensure is worse than a red one.
        const requested = args.providers !== null;
        rows.push({
          provider,
          model: null,
          ok: requested ? false : null,
          durationMs: 0,
          turns: 0,
          notes: [`provider not available on this machine${requested ? '' : ' (skipped)'}`],
        });
        continue;
      }

      // A per-machine --model pin beats the cheap-tier autopick (e.g. when the
      // auto-matched haiku routes through an out-of-quota upstream).
      const pinned = args.modelOverrides[provider];
      if (pinned && !isCheapTierModel(provider, pinned)) {
        console.warn(`[canary] WARNING: pinned model ${pinned} is not a recognized cheap tier for ${provider}`);
      }
      const picked = pinned
        ? { modelId: pinned }
        : pickCanaryModel(provider, models, { allowAnyModel: args.allowAnyModel });
      if ('skip' in picked) {
        // Auto-discovered providers may skip quietly; an explicitly requested
        // one must be exercised or go red — same rule as unavailability above.
        const requested = args.providers !== null;
        rows.push({
          provider,
          model: null,
          ok: requested ? false : null,
          durationMs: 0,
          turns: 0,
          notes: [picked.skip],
        });
        continue;
      }

      console.log(`[canary] ${provider} → ${picked.modelId} …`);
      try {
        rows.push(
          await runProviderCanary(server.baseUrl, {
            provider,
            modelId: picked.modelId,
            workspace,
            timeoutMs: args.timeoutMs,
            marker: args.mock && provider === 'mock' ? null : CANARY_MARKER,
          }),
        );
      } catch (err) {
        rows.push({
          provider,
          model: picked.modelId,
          ok: false,
          durationMs: 0,
          turns: 0,
          notes: [`infra error: ${err.message}`],
        });
      }
    }

    console.log(`\n${renderCanaryReport(rows)}\n`);

    const exercised = rows.filter((r) => r.ok !== null);
    if (exercised.length === 0) {
      console.error('[canary] FAIL: no provider was exercised (nothing ensured)');
      process.exit(1);
    }
    if (rows.some((r) => r.ok === false)) process.exit(1);
    console.log(`[canary] PASS: ${exercised.length} provider(s) green`);
  } finally {
    await server.stop();
  }
}

main().catch((err) => {
  console.error('[canary] FATAL', err?.stack ?? err);
  process.exit(1);
});
