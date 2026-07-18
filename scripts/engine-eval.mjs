// Behavioral eval harness orchestrator. For every (engine, model, task) it:
//   1. builds a fresh deterministic tmp git repo from the task's fixture,
//   2. boots a HERMETIC daemon (temp NUNCIO_DATA_DIR, ephemeral port) with the
//      task's verifyCommand wired as NUNCIO_VERIFY_COMMAND,
//   3. seeds setup.facts via the context-facts HTTP API,
//   4. enqueues the task via POST /api/tasks (projectPath = fixture, provider,
//      model, contextBrief),
//   5. polls the task to terminal within timeoutMs (timeout => fail row),
//   6. scores pass = verifyPassed AND hidden-check pass,
//   7. tears the daemon + tmp dir down — every run is independent.
// Engine availability is discovered ONLY through the daemon's HTTP surface
// (GET /api/models is server-filtered by isAvailable); no server modules are
// imported here. Serial execution. Usage:
//   bun run eval:engines -- --engines mock --tasks smoke-mock-echo
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreePort, startServer } from './lib/hermetic-stack.mjs';
import { buildRepoWorkspace, isRecordedFixture, promptWithSteers } from './lib/eval-extract.mjs';
import {
  baselinesDir,
  buildReport as buildReportBase,
  isCompleteReport,
  loadFixtureSetup,
  loadHiddenCheck,
  loadTasks,
  renderMarkdownTable,
  reportStamp,
  reportsDir,
} from './lib/eval-suite.mjs';

const POLL_INTERVAL_MS = 500;
// profileVersion: this branch ships no prompt-profile HTTP surface (D1/D2
// unshipped), so there is nothing to read — report 0 with a note rather than
// adding a server endpoint just for the harness.
const PROFILE_VERSION = 0;
const PROFILE_NOTE = 'profileVersion=0: no prompt-profile HTTP surface on this build';

// The hermetic-stack lib already installs a synchronous process-exit safety net
// that SIGKILLs any live daemon and removes its data dir — including a signal
// that lands mid-boot. It does NOT know about the fixture dir this runner
// creates, so we register a synchronous 'exit' handler for the currently-live
// fixture dir here. Synchronous (rmSync) because Node ignores async work in an
// 'exit' handler, and the lib turns SIGINT/SIGTERM into a normal exit.
let activeFixtureDir = null;
process.on('exit', () => {
  if (activeFixtureDir) {
    try {
      rmSync(activeFixtureDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function parseArgs(argv) {
  const out = { tasks: null, engines: null, models: null, baseline: false, stampProfile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    if (arg === '--tasks') out.tasks = split(take());
    else if (arg === '--engines') out.engines = split(take());
    else if (arg === '--models') out.models = split(take());
    else if (arg === '--baseline') out.baseline = true;
    else if (arg === '--stamp-profile') out.stampProfile = true;
  }
  return out;
}

const split = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/** GET /api/models → available providers (server already filters isAvailable). */
async function fetchAvailableEngines(baseUrl) {
  const res = await fetch(`${baseUrl}/api/models`);
  if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
  const providers = await res.json();
  const map = new Map();
  for (const p of providers) {
    const models = (p.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => m.id));
    map.set(p.id, models);
  }
  return map;
}

async function seedFacts(baseUrl, projectPath, facts) {
  for (const fact of facts) {
    const res = await fetch(`${baseUrl}/api/context-facts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath, key: fact.key, value: fact.value, pinned: fact.pinned === true }),
    });
    if (!res.ok) throw new Error(`seed fact "${fact.key}" failed: ${res.status} ${await res.text()}`);
  }
}

async function enqueueTask(baseUrl, { task, provider, model, projectPath }) {
  // Recorded tasks may carry the human's mid-session follow-up steers; they
  // fold into the prompt (mid-run replay would be timing-dependent).
  const body = {
    prompt: promptWithSteers(task),
    projectPath,
    provider,
    ...(model ? { model } : {}),
    ...(task.setup?.brief ? { contextBrief: task.setup.brief } : {}),
  };
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const created = await res.json().catch(() => ({}));
  if (!res.ok || created?.error || !created?.id) {
    throw new Error(`enqueue failed: ${res.status} ${created?.error ?? JSON.stringify(created)}`);
  }
  return created;
}

const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED']);

/** Poll GET /api/tasks for `taskId` until terminal or the deadline elapses. */
async function pollTerminal(baseUrl, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/tasks`);
    if (res.ok) {
      const list = await res.json();
      const dto = list.find((t) => t.id === taskId);
      if (dto && TERMINAL.has(dto.status)) return { dto, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { dto: null, timedOut: true };
}

async function fetchEvents(baseUrl, sessionId) {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?since=0`);
  if (!res.ok) return [];
  return res.json();
}

/** verifyPassed is the last verify_result.ok in the session log (single truth). */
function lastVerifyOk(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'verify_result') return events[i]?.payload?.ok === true;
  }
  return false;
}

/** rounds = count of completed agent turns (assistant_message events). */
function countRounds(events) {
  return events.filter((e) => e?.type === 'assistant_message').length;
}

async function runOneTask(baseUrl, { task, provider, model }) {
  const started = Date.now();
  const fixtureLabel = isRecordedFixture(task.fixture) ? 'recorded' : task.fixture;
  const fixtureDir = await mkdtemp(join(tmpdir(), `nuncio-eval-${fixtureLabel}-`));
  activeFixtureDir = fixtureDir; // so a signal mid-task removes it
  try {
    if (isRecordedFixture(task.fixture)) {
      // Recorded-session task: clone the real repo hard-pinned at its baseSha.
      await buildRepoWorkspace(task.fixture, fixtureDir);
    } else {
      const setup = await loadFixtureSetup(task.fixture);
      await setup(fixtureDir);
    }

    if (Array.isArray(task.setup?.facts) && task.setup.facts.length) {
      await seedFacts(baseUrl, fixtureDir, task.setup.facts);
    }

    const created = await enqueueTask(baseUrl, { task, provider, model, projectPath: fixtureDir });
    const { dto, timedOut } = await pollTerminal(baseUrl, created.id, task.timeoutMs);

    if (timedOut) {
      return row(task, { pass: false, verifyPassed: false, hiddenPassed: false, durationMs: Date.now() - started, rounds: 0, notes: [`timeout after ${task.timeoutMs}ms`] });
    }

    const events = dto.sessionId ? await fetchEvents(baseUrl, dto.sessionId) : [];
    // A task with no verifyCommand has no visible layer: verifyPassed is null
    // (reported '—') and the score rests on the hidden check alone. A task WITH
    // a verifyCommand that produced no verify event is a genuine false.
    const hasVerify = typeof task.verifyCommand === 'string' && task.verifyCommand.length > 0;
    const verifyPassed = hasVerify ? lastVerifyOk(events) : null;
    const rounds = countRounds(events);

    // A hidden check that fails to LOAD (bad import, syntax error) or THROWS at
    // runtime must score the task as failing — never a silent pass. Both paths
    // keep verifyPassed/rounds so the row stays honest about what did happen.
    let hidden;
    try {
      const check = await loadHiddenCheck(task.id);
      // baseUrl is passed so delegation/fact checks can query the daemon HTTP
      // API (task rows, context facts). Existing checks ignore the extra field.
      hidden = await check({ fixtureDir, taskDto: dto, sessionEvents: events, baseUrl });
    } catch (err) {
      hidden = { pass: false, notes: [`hidden check error: ${err.message}`] };
    }
    const hiddenPassed = hidden?.pass === true;
    const pass = hasVerify ? verifyPassed === true && hiddenPassed : hiddenPassed;

    return row(task, {
      pass,
      verifyPassed,
      hiddenPassed,
      durationMs: Date.now() - started,
      rounds,
      notes: [`task ${dto.status}`, ...(hidden?.notes ?? [])],
    });
  } catch (err) {
    return row(task, { pass: false, verifyPassed: false, hiddenPassed: false, durationMs: Date.now() - started, rounds: 0, notes: [`infra error: ${err.message}`] });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    if (activeFixtureDir === fixtureDir) activeFixtureDir = null;
  }
}

const row = (task, r) => ({ taskId: task.id, informational: task.informational === true, ...r });

async function writeReport(report, stamp) {
  await mkdir(reportsDir, { recursive: true });
  const file = join(
    reportsDir,
    `${stamp}-${report.engine}-${slug(report.model)}-p${report.profileVersion}.json`,
  );
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

const slug = (s) => String(s ?? 'default').replace(/[^a-z0-9]+/gi, '-');

/** Freeze a complete report as the committed baseline for its (engine, model). */
async function writeBaseline(report) {
  await mkdir(baselinesDir, { recursive: true });
  const file = join(baselinesDir, `${report.engine}-${slug(report.model)}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Produce the ready-to-paste evalScore stamp. The hermetic eval daemons are dead
 * by now (by design — no live shared daemon), so instead of a settings write we
 * emit a YAML block + the exact settings key for the founder to paste, and save a
 * copy under eval/reports/. `at` comes from the run's own timestamp (the report
 * stamp), never a fresh Date.now().
 */
async function writeStamp(report, stamp) {
  const settingsKey = `NUNCIO_PROMPT_PROFILE_${report.engine.toUpperCase()}`;
  const at = stamp; // the run timestamp from the report filename
  const yaml = [
    '# Paste under the profile document frontmatter (DB-override), settings key:',
    `#   ${settingsKey}`,
    `evalScore: { passRate: ${report.passRate}, suiteVersion: ${report.suiteVersion}, at: ${at} }`,
    '',
  ].join('\n');
  await mkdir(reportsDir, { recursive: true });
  const file = join(reportsDir, `${stamp}-stamp-${report.engine}.txt`);
  await writeFile(file, yaml, 'utf8');
  return { file, yaml, settingsKey };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allTasks = await loadTasks();
  const tasks = args.tasks ? allTasks.filter((t) => args.tasks.includes(t.id)) : allTasks;
  if (!tasks.length) {
    console.error(`no tasks matched --tasks ${args.tasks?.join(',') ?? '(all)'}`);
    process.exit(1);
  }

  // One hermetic daemon per (engine, task): the task's verifyCommand is a
  // boot-time env var (NUNCIO_VERIFY_COMMAND), so a fresh daemon per task is the
  // clean way to give each task its own verify check with zero shared state.
  // Results accumulate per (engine, model) so each run produces ONE aggregated
  // report — the unit baseline/compare operate on.
  const requestedEngines = args.engines ?? ['mock'];
  const runStamp = reportStamp();
  const perTarget = new Map(); // "engine model" -> { engine, model, results }
  const targetOf = (engine, model) => {
    const key = `${engine} ${model ?? 'default'}`;
    if (!perTarget.has(key)) perTarget.set(key, { engine, model, results: [] });
    return perTarget.get(key);
  };

  for (const engine of requestedEngines) {
    for (const task of tasks) {
      const port = await findFreePort();
      const server = await startServer({
        port,
        env: {
          // Only wire a verify command when the task declares one; a verify-less
          // task must produce no verify_result event at all.
          ...(task.verifyCommand ? { NUNCIO_VERIFY_COMMAND: task.verifyCommand } : {}),
          // daemonEnv is validateTask-allowlisted (orchestration tools / routing)
          // — it flips server behavior on for the delegation-family tasks.
          ...(task.daemonEnv ?? {}),
        },
      });
      try {
        const available = await fetchAvailableEngines(server.baseUrl);
        if (!available.has(engine)) {
          targetOf(engine, args.models?.[0] ?? null).results.push(
            row(task, { pass: false, verifyPassed: false, hiddenPassed: false, durationMs: 0, rounds: 0, notes: ['skipped: not installed'] }),
          );
          continue;
        }
        const models = args.models ?? [available.get(engine)?.[0] ?? null];
        for (const model of models) {
          const result = await runOneTask(server.baseUrl, { task, provider: engine, model });
          targetOf(engine, model).results.push(result);
        }
      } finally {
        await server.stop();
      }
    }
  }

  // Emit one aggregated report per (engine, model); baseline/stamp per target.
  let overallExit = 0;
  for (const { engine, model, results } of perTarget.values()) {
    const report = buildReport(engine, model, results);
    await emit(report, runStamp);
    // Informational (control) rows are excluded from the exit code, just as they
    // are from the pass rate.
    if (results.some((r) => r.pass !== true && r.informational !== true)) overallExit = 1;

    const complete = isCompleteReport(report);
    if (args.baseline) {
      if (!complete) {
        console.error(`[eval] refusing --baseline for ${engine}/${report.model}: run had infra skips/timeouts (a partial run must not become the yardstick)`);
        overallExit = 1;
      } else {
        const file = await writeBaseline(report);
        console.log(`[eval] baseline written → ${file}`);
      }
    }
    if (args.stampProfile) {
      if (!complete) {
        console.error(`[eval] refusing --stamp-profile for ${engine}/${report.model}: run had infra skips/timeouts`);
        overallExit = 1;
      } else {
        const { file, yaml, settingsKey } = await writeStamp(report, runStamp);
        console.log(`[eval] evalScore stamp for ${settingsKey} → ${file}\n${yaml}`);
      }
    }
  }
  process.exit(overallExit);
}

function buildReport(engine, model, results) {
  return buildReportBase({ engine, model, results, profileVersion: PROFILE_VERSION, notes: [PROFILE_NOTE] });
}

async function emit(report, stamp) {
  const file = await writeReport(report, stamp);
  console.log(`\n## ${report.engine} / ${report.model} (suite v${report.suiteVersion}, profile p${report.profileVersion})`);
  console.log(renderMarkdownTable(report.results));
  console.log(`passRate: ${(report.passRate * 100).toFixed(0)}%  →  ${file}`);
  return file;
}

main().catch((err) => {
  console.error('[eval] FATAL', err?.stack ?? err);
  process.exit(1);
});
