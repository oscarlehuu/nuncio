// Recorded-session → eval-task extraction (locked decision: the eval set is
// seeded from REAL sessions, replayed from the durable event log). Pure
// helpers; the CLI entry point is scripts/eval-extract-task.mjs. A recorded
// task pins its repo state as { repo, baseSha } and the runner clones that
// exact SHA into a throwaway workspace, so tasks age explicitly (re-extract)
// instead of drifting silently.
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 300_000;
const SLUG_MAX_CHARS = 60;

/** Kebab slug from the head of a prompt (ascii letters/digits only). */
export function taskSlug(prompt) {
  return String(prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '');
}

/** Last verify_start command in the log, normalized to a runnable string. */
function recordedVerifyCommand(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'verify_start') continue;
    const command = event.payload?.command;
    if (typeof command !== 'string' || !command.trim()) continue;
    // The session verifier displays the project script as '.nuncio/verify';
    // the eval daemon replays it via NUNCIO_VERIFY_COMMAND, so make it runnable.
    return command === '.nuncio/verify' ? 'sh .nuncio/verify' : command;
  }
  return null;
}

const PREAMBLE_SEPARATOR = '\n\n---\n\n';

/**
 * The stored session prompt is the COMPOSED preamble (handoff brief → project
 * facts → the user's prompt, joined by a markdown rule, per
 * composeSessionPreamble). Replaying it verbatim would double-compose stale
 * context into the eval, so extraction keeps only the final section — the
 * user's original prompt, which the composer guarantees comes last.
 */
export function extractOriginalPrompt(storedPrompt) {
  const sections = String(storedPrompt ?? '').split(PREAMBLE_SEPARATOR);
  return { prompt: sections[sections.length - 1].trim(), stripped: sections.length > 1 };
}

/**
 * Default replay pin: the EARLIEST workspace HEAD recorded on the session's
 * verify results — far closer to the state the session actually started from
 * than the repo's current HEAD (which may already contain the finished work).
 * Null when the log carries no head (pre-classifier sessions).
 */
export function earliestRecordedHead(events) {
  for (const event of events) {
    if (event?.type !== 'verify_result') continue;
    const head = event.payload?.head;
    if (typeof head === 'string' && head && !head.startsWith('(')) return head;
  }
  return null;
}

/** Human follow-up steers (origin-tagged auto-steers are loop mechanics, not task input). */
function humanSteers(events) {
  return events
    .filter(
      (event) =>
        event?.type === 'steer_message' &&
        typeof event.payload?.text === 'string' &&
        event.payload.text.trim() &&
        !event.payload.origin,
    )
    .map((event) => event.payload.text.trim());
}

/**
 * Fold one recorded session into an eval task definition. Fails loudly on
 * sessions that cannot be honest tasks: crew-owned members (their verification
 * belongs to the Crew run), sessions without a workspace, and sessions with no
 * verify command in the log unless the curator passes one explicitly.
 */
export function buildTaskFromSession(session, events, options = {}) {
  if (!session || typeof session !== 'object') throw new Error('session row is required');
  if (session.verifyOwner === 'crew') {
    throw new Error('crew-owned sessions cannot be extracted (verification belongs to the Crew run)');
  }
  const repo = session.projectPath ?? session.workspace ?? null;
  if (!repo) throw new Error('session has no projectPath/workspace to replay');
  const baseSha = String(options.baseSha ?? '').trim();
  if (!baseSha) throw new Error('baseSha is required (the repo state the task replays from)');
  const { prompt } = extractOriginalPrompt(session.prompt);
  if (!prompt) throw new Error('session has no prompt');

  const verifyCommand = options.verifyCommand?.trim() || recordedVerifyCommand(events);
  if (!verifyCommand) {
    throw new Error(
      'no verify command found in the session log — pass --verify-command so the task has a gradable outcome',
    );
  }

  const id = options.slug?.trim() || taskSlug(prompt);
  if (!id) throw new Error('could not derive a task id from the prompt; pass an explicit slug');

  const steers = humanSteers(events);
  return {
    id,
    title: options.title?.trim() || prompt.slice(0, 80),
    fixture: { repo, baseSha },
    prompt,
    ...(steers.length ? { followUpSteers: steers } : {}),
    setup: {},
    verifyCommand,
    timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    tags: ['recorded'],
    expect: { verifyPassed: true },
  };
}

function run(cmd, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(undefined);
      else rejectPromise(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Materialize a recorded fixture: clone `repo` into `dir` and hard-pin it to
 * `baseSha`. A SHA the repo no longer contains fails loudly — a recorded task
 * must never silently run against different code than it recorded.
 */
export async function buildRepoWorkspace(fixture, dir) {
  const repo = fixture?.repo;
  const baseSha = fixture?.baseSha;
  if (!repo || !baseSha) throw new Error('recorded fixture requires { repo, baseSha }');
  await run('git', ['clone', '--quiet', '--no-hardlinks', repo, dir], undefined);
  await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', baseSha], dir);
  return dir;
}

/** A task fixture is either a directory id (string) or a recorded { repo, baseSha }. */
export function isRecordedFixture(fixture) {
  return typeof fixture === 'object' && fixture !== null;
}

/**
 * Recorded follow-up steers fold into the prompt: replaying them mid-run would
 * be timing-dependent (not reproducible), while one combined brief keeps the
 * graded outcome equivalent and deterministic.
 */
export function promptWithSteers(task) {
  const steers = Array.isArray(task.followUpSteers)
    ? task.followUpSteers.filter((steer) => typeof steer === 'string' && steer.trim())
    : [];
  if (steers.length === 0) return task.prompt;
  return [
    task.prompt,
    '',
    'Follow-up requirements (from the original session — apply them all):',
    ...steers.map((steer) => `- ${steer.trim()}`),
  ].join('\n');
}
