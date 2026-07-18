// Pure helpers for the provider canary (scripts/provider-canary.mjs). The cost
// rule (never burn a flagship) and the event-shape verdict live here as plain
// functions so they are table-testable without booting a daemon or spending a
// model turn. See docs/testing-and-verification.md → "Provider canary".

/**
 * The deterministic marker a real model must echo back. The canary prompt is
 * intentionally trivial ("reply with exactly …") so the CHEAPEST tier of every
 * provider completes it near-deterministically — the canary proves harness
 * plumbing (HTTP → provider → SDK → stream → event log), not model smarts.
 */
export const CANARY_MARKER = 'NUNCIO_CANARY_OK';

export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Cheap-tier match per provider, applied to model id AND display name. This is
 * the executable form of the engine/model cost rule in
 * docs/testing-and-verification.md: Pi/Claude → haiku, Codex → mini tier,
 * Cursor → composer, Mock → its default. No entry ever matches a flagship.
 */
const CHEAP_TIER_PATTERNS = {
  pi: /haiku/i,
  claude: /haiku/i,
  codex: /mini/i,
  cursor: /composer/i,
  mock: /^(mock:default|Mock Agent)$/i,
};

/**
 * Pick the model the canary may spend tokens on for `providerId`.
 *
 * @param {string} providerId
 * @param {{ id: string, name?: string }[]} models flattened live catalog rows
 * @param {{ allowAnyModel?: boolean }} [opts] opt-in fallback to the first
 *   listed model when no cheap tier matches (still never silent)
 * @returns {{ modelId: string } | { skip: string }}
 */
export function pickCanaryModel(providerId, models, { allowAnyModel = false } = {}) {
  if (!models.length) return { skip: `skipped: ${providerId} listed no models` };

  const pattern = CHEAP_TIER_PATTERNS[providerId];
  const cheap = pattern
    ? models.find((m) => pattern.test(m.id) || pattern.test(m.name ?? ''))
    : undefined;
  if (cheap) return { modelId: cheap.id };

  if (allowAnyModel) return { modelId: models[0].id };
  return {
    skip: `skipped: no cheap-tier model for ${providerId} (pass --allow-any-model to use ${models[0].id})`,
  };
}

/** True when `modelId` matches the provider's cheap-tier pattern — used to warn on expensive pins. */
export function isCheapTierModel(providerId, modelId) {
  const pattern = CHEAP_TIER_PATTERNS[providerId];
  return pattern ? pattern.test(modelId) : false;
}

/**
 * Judge a finished canary session purely from its durable event log + settled
 * status — the same evidence a client replays. All assertions are MECHANICAL
 * (shape, not semantics), except the marker echo which is deliberately trivial.
 *
 * @param {object} input
 * @param {{ type: string, payload?: any }[]} input.events full log (since=0)
 * @param {string} input.sessionStatus settled session status
 * @param {string | null} input.marker expected echo text; null skips the check
 *   (Mock mode — the mock's reply is fixed and the shape alone is the proof)
 * @returns {{ ok: boolean, failures: string[], turns: number }}
 */
export function assessCanaryEvents({ events, sessionStatus, marker }) {
  const failures = [];

  if (sessionStatus !== 'IDLE') {
    failures.push(`session settled ${sessionStatus}, expected IDLE`);
  }
  if (!events.some((e) => e.type === 'status' && e.payload?.status === 'RUNNING')) {
    failures.push('no RUNNING status event was emitted');
  }
  if (!events.some((e) => e.type === 'assistant_delta')) {
    failures.push('no assistant_delta events streamed');
  }

  const messages = events.filter((e) => e.type === 'assistant_message');
  if (messages.length === 0) {
    failures.push('no terminal assistant_message event');
  } else if (
    marker !== null &&
    !messages.some((e) => typeof e.payload?.text === 'string' && e.payload.text.includes(marker))
  ) {
    failures.push(`no assistant_message contained the marker ${marker}`);
  }

  for (const e of events) {
    if (e.type === 'error') {
      failures.push(`error event: ${e.payload?.message ?? 'unknown'}`);
    }
  }

  return { ok: failures.length === 0, failures, turns: messages.length };
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ mock: boolean, providers: string[] | null, allowAnyModel: boolean, timeoutMs: number, modelOverrides: Record<string, string> }}
 */
export function parseCanaryArgs(argv) {
  const out = {
    mock: false,
    providers: null,
    allowAnyModel: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    modelOverrides: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mock') out.mock = true;
    else if (arg === '--allow-any-model') out.allowAnyModel = true;
    else if (arg === '--providers') {
      out.providers = (argv[(i += 1)] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (out.providers.length === 0) throw new Error('--providers expects a comma-separated list');
    } else if (arg === '--model') {
      // Repeatable per-machine pin: --model pi=cliproxyapi:claude-haiku-4.5
      // (the model id may itself contain '=' — split on the FIRST one only).
      const raw = argv[(i += 1)] ?? '';
      const eq = raw.indexOf('=');
      if (eq <= 0 || eq === raw.length - 1) {
        throw new Error(`--model expects provider=modelId, got "${raw}"`);
      }
      out.modelOverrides[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
    } else if (arg === '--timeout') {
      const raw = argv[(i += 1)];
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout expects milliseconds, got "${raw}"`);
      out.timeoutMs = ms;
    } else {
      // Fail closed: a typo'd flag must never silently flip the canary into a
      // different (token-spending) mode on a credentialed machine.
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return out;
}

/**
 * @param {{ provider: string, model: string | null, ok: boolean | null, durationMs: number, turns: number, notes: string[] }[]} rows
 *   ok: true = PASS, false = FAIL, null = SKIP (provider not exercised)
 */
export function renderCanaryReport(rows) {
  const lines = [
    '| provider | model | verdict | duration | turns | notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const verdict = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP';
    lines.push(
      `| ${r.provider} | ${r.model ?? '—'} | ${verdict} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.turns} | ${r.notes.join('; ') || '—'} |`,
    );
  }
  return lines.join('\n');
}
