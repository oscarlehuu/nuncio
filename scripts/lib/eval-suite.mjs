// Pure, side-effect-light helpers for the engine-eval runner: locating and
// loading task definitions, fixtures, and hidden checks from the repo-root
// eval/ tree, plus report rendering. Kept separate from engine-eval.mjs so the
// orchestration script stays under the file-size budget and these bits are
// unit-testable without booting a daemon.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './hermetic-stack.mjs';

export const evalRoot = join(repoRoot, 'eval');
export const tasksDir = join(evalRoot, 'tasks');
export const fixturesDir = join(evalRoot, 'fixtures');
export const checksDir = join(evalRoot, 'checks');
export const reportsDir = join(evalRoot, 'reports');

export const SUITE_VERSION = 1;

/** Load every task JSON under eval/tasks, sorted by id for stable ordering. */
export async function loadTasks() {
  const entries = await readdir(tasksDir);
  const tasks = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const raw = await readFile(join(tasksDir, name), 'utf8');
    let task;
    try {
      task = JSON.parse(raw);
    } catch (err) {
      throw new Error(`eval/tasks/${name} is not valid JSON: ${err.message}`);
    }
    validateTask(task, name);
    tasks.push(task);
  }
  return tasks;
}

/** Fail fast on a malformed task so a typo never silently skews a run. */
export function validateTask(task, name) {
  // verifyCommand is OPTIONAL: some tasks (e.g. honest-failure-report) have no
  // visible verify — the runner scores those on the hidden layer alone.
  const missing = ['id', 'title', 'fixture', 'prompt', 'timeoutMs'].filter(
    (k) => task[k] === undefined || task[k] === null || task[k] === '',
  );
  if (missing.length) {
    throw new Error(`eval/tasks/${name} missing required field(s): ${missing.join(', ')}`);
  }
  if (task.verifyCommand !== undefined && typeof task.verifyCommand !== 'string') {
    throw new Error(`eval/tasks/${name} verifyCommand must be a string when present`);
  }
  if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0) {
    throw new Error(`eval/tasks/${name} timeoutMs must be a positive integer`);
  }
  task.setup = task.setup ?? {};
  task.tags = task.tags ?? [];
  task.expect = task.expect ?? { verifyPassed: true };
  // Informational tasks (control variants) are reported but excluded from the
  // pass rate — a measurement baseline, not a graded task.
  task.informational = task.informational === true;
}

/** Dynamic-import a fixture builder; returns its `setup(dir)` function. */
export async function loadFixtureSetup(fixtureId) {
  const mod = await import(pathToFileURL(join(fixturesDir, fixtureId, 'setup.mjs')).href);
  if (typeof mod.setup !== 'function') {
    throw new Error(`eval/fixtures/${fixtureId}/setup.mjs must export setup(dir)`);
  }
  return mod.setup;
}

/**
 * Load the hidden check for a task if one exists. A missing check FILE is legal
 * (pass-through), but a present-yet-broken one is a hard error — including a
 * typo'd import inside it, which must NEVER silently score the task as passing.
 * We discriminate by disk presence of the check file itself, not by the error
 * code: a bad `import` in a present check also throws ERR_MODULE_NOT_FOUND, so
 * catching that code blindly would turn a broken check into a false pass.
 */
export async function loadHiddenCheck(taskId) {
  const path = join(checksDir, `${taskId}.mjs`);
  if (!existsSync(path)) {
    return () => ({ pass: true, notes: ['no hidden check defined'] });
  }
  // The file exists: any load error (bad import, syntax error, missing export)
  // is a real defect. Surface it — the caller scores the task FAILED with the
  // error in notes rather than letting a broken check pass.
  const mod = await import(pathToFileURL(path).href);
  const fn = mod.default ?? mod.check;
  if (typeof fn !== 'function') {
    throw new Error(`eval/checks/${taskId}.mjs must default-export a check function`);
  }
  return fn;
}

/** Render results as a markdown table for stdout. */
export function renderMarkdownTable(results) {
  const header = '| task | pass | verify | hidden | ms | rounds | notes |';
  const sep = '|---|---|---|---|---|---|---|';
  const rows = results.map((r) => {
    const notes = (r.notes ?? []).join('; ').replace(/\|/g, '\\|');
    // Informational (control) rows are tagged and their pass shown as '—' so a
    // reader never mistakes an excluded baseline for a graded pass/fail.
    const taskId = r.informational ? `${r.taskId} (info)` : r.taskId;
    const passCell = r.informational ? '—' : mark(r.pass);
    return `| ${taskId} | ${passCell} | ${mark(r.verifyPassed)} | ${mark(r.hiddenPassed)} | ${r.durationMs ?? ''} | ${r.rounds ?? ''} | ${notes} |`;
  });
  return [header, sep, ...rows].join('\n');
}

// null/undefined (e.g. a verify-less task's verifyPassed) renders as an em dash.
function mark(v) {
  if (v === true) return 'PASS';
  if (v === false) return 'FAIL';
  return '—';
}

/** Timestamp slug for report filenames: 2026-07-07T12-34-56-789Z-ish. */
export function reportStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Assemble a report for one (engine, model) run. `profileVersion`/`notes` are
 * caller-supplied (the runner owns those). passRate counts only GRADED rows —
 * informational (control) rows are reported but excluded from the denominator,
 * so they never move the score. Kept here (pure) so it is unit-testable.
 */
export function buildReport({ engine, model, results, profileVersion = 0, notes = [] }) {
  const graded = results.filter((r) => r.informational !== true);
  const passed = graded.filter((r) => r.pass).length;
  return {
    suiteVersion: SUITE_VERSION,
    engine,
    model: model ?? 'default',
    profileVersion,
    results,
    passRate: graded.length ? passed / graded.length : 0,
    tokens: null,
    notes,
  };
}
