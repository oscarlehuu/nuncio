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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreePort, startServer } from './lib/hermetic-stack.mjs';
import {
  SUITE_VERSION,
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

function parseArgs(argv) {
  const out = { tasks: null, engines: null, models: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    if (arg === '--tasks') out.tasks = split(take());
    else if (arg === '--engines') out.engines = split(take());
    else if (arg === '--models') out.models = split(take());
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
  const body = {
    prompt: task.prompt,
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
  const fixtureDir = await mkdtemp(join(tmpdir(), `nuncio-eval-${task.fixture}-`));
  try {
    const setup = await loadFixtureSetup(task.fixture);
    await setup(fixtureDir);

    if (Array.isArray(task.setup?.facts) && task.setup.facts.length) {
      await seedFacts(baseUrl, fixtureDir, task.setup.facts);
    }

    const created = await enqueueTask(baseUrl, { task, provider, model, projectPath: fixtureDir });
    const { dto, timedOut } = await pollTerminal(baseUrl, created.id, task.timeoutMs);

    if (timedOut) {
      return row(task, { pass: false, verifyPassed: false, hiddenPassed: false, durationMs: Date.now() - started, rounds: 0, notes: [`timeout after ${task.timeoutMs}ms`] });
    }

    const events = dto.sessionId ? await fetchEvents(baseUrl, dto.sessionId) : [];
    const verifyPassed = lastVerifyOk(events);
    const rounds = countRounds(events);

    const check = await loadHiddenCheck(task.id);
    let hidden;
    try {
      hidden = await check({ fixtureDir, taskDto: dto, sessionEvents: events });
    } catch (err) {
      hidden = { pass: false, notes: [`hidden check threw: ${err.message}`] };
    }
    const hiddenPassed = hidden?.pass === true;

    return row(task, {
      pass: verifyPassed && hiddenPassed,
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
  }
}

const row = (task, r) => ({ taskId: task.id, ...r });

async function writeReport(report) {
  await mkdir(reportsDir, { recursive: true });
  const file = join(
    reportsDir,
    `${reportStamp()}-${report.engine}-${slug(report.model)}-p${report.profileVersion}.json`,
  );
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

const slug = (s) => String(s ?? 'default').replace(/[^a-z0-9]+/gi, '-');

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
  const requestedEngines = args.engines ?? ['mock'];
  let overallExit = 0;

  for (const engine of requestedEngines) {
    for (const task of tasks) {
      const port = await findFreePort();
      const server = await startServer({
        port,
        env: { NUNCIO_VERIFY_COMMAND: task.verifyCommand },
      });
      try {
        const available = await fetchAvailableEngines(server.baseUrl);
        if (!available.has(engine)) {
          const report = buildReport(engine, args.models?.[0] ?? null, [
            row(task, { pass: false, verifyPassed: false, hiddenPassed: false, durationMs: 0, rounds: 0, notes: ['skipped: not installed'] }),
          ]);
          await emit(report);
          continue;
        }
        const models = args.models ?? [available.get(engine)?.[0] ?? null];
        for (const model of models) {
          const result = await runOneTask(server.baseUrl, { task, provider: engine, model });
          const report = buildReport(engine, model, [result]);
          const file = await emit(report);
          if (!result.pass) overallExit = 1;
          void file;
        }
      } finally {
        await server.stop();
      }
    }
  }
  process.exit(overallExit);
}

function buildReport(engine, model, results) {
  const passed = results.filter((r) => r.pass).length;
  return {
    suiteVersion: SUITE_VERSION,
    engine,
    model: model ?? 'default',
    profileVersion: PROFILE_VERSION,
    results,
    passRate: results.length ? passed / results.length : 0,
    tokens: null,
    notes: [PROFILE_NOTE],
  };
}

async function emit(report) {
  const file = await writeReport(report);
  console.log(`\n## ${report.engine} / ${report.model} (suite v${report.suiteVersion}, profile p${report.profileVersion})`);
  console.log(renderMarkdownTable(report.results));
  console.log(`passRate: ${(report.passRate * 100).toFixed(0)}%  →  ${file}`);
  return file;
}

main().catch((err) => {
  console.error('[eval] FATAL', err?.stack ?? err);
  process.exit(1);
});
