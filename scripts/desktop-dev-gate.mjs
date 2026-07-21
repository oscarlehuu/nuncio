#!/usr/bin/env node
/**
 * Gate for the dev desktop-release channel. Two modes:
 *
 *   MODE=gate (default) — decide whether the current `push` / `workflow_run` /
 *     manual dispatch should publish; writes `publish` + `sha` to $GITHUB_OUTPUT.
 *   MODE=idempotency — the post-slot re-check the build runs AFTER acquiring the
 *     publish concurrency slot; writes `shipped` (true if a dev release already
 *     exists for SHA) so a build that lost the two-gates race skips.
 *
 * Publishes only when every required workflow concluded success on the exact commit,
 * the commit has no dev release yet (draft or published), and the commit is not behind
 * the last shipped dev commit (never auto-update backward). The pure decision lives in
 * desktop-dev-gate-utils.mjs and is unit tested; this file is the I/O shell around `gh`.
 *
 * On `push` events the gate polls until CI + Desktop Smoke conclude (or the wait
 * budget expires). That path works from the workflow file on `dev` itself —
 * `workflow_run` alone would require this file on the repository default branch.
 *
 * A GitHub API lookup that keeps failing THROWS (non-zero exit) so the job fails and can
 * be re-run — it never writes publish=false, which would silently drop a green commit.
 *
 * Env: EVENT_NAME, REPO, TRIGGER_SHA (workflow_run), DISPATCH_SHA (dispatch),
 *      PUSH_SHA (push), SHA (idempotency mode), GH_TOKEN, GITHUB_OUTPUT, MODE,
 *      optional WAIT_INTERVAL_MS / WAIT_TIMEOUT_MS for tests.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decideDevPublish,
  devReleaseShas,
  latestShippedSha,
  withRetry,
} from './desktop-dev-gate-utils.mjs';

const REQUIRED_WORKFLOWS = ['ci.yml', 'desktop-smoke.yml'];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeOutput(pairs) {
  const out = process.env.GITHUB_OUTPUT;
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (out) appendFileSync(out, text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function conclusionAt(repo, workflowFile, sha) {
  const query = `repos/${repo}/actions/workflows/${workflowFile}/runs` +
    `?head_sha=${sha}&branch=dev&event=push&per_page=1`;
  const raw = (await withRetry(() =>
    gh(['api', query, '--jq', '.workflow_runs[0].conclusion // "pending"']))).trim();
  // A still-running or missing run reads as "pending"; treat only real conclusions.
  return raw === 'pending' || raw === '' ? null : raw;
}

async function collectRequiredRuns(repo, sha) {
  const requiredRuns = [];
  for (const file of REQUIRED_WORKFLOWS) {
    requiredRuns.push({
      workflow: `.github/workflows/${file}`,
      conclusion: await conclusionAt(repo, file, sha),
    });
  }
  return requiredRuns;
}

/** True when every required run has a terminal conclusion (success or failure). */
function allRequiredSettled(requiredRuns) {
  return requiredRuns.every((run) => run.conclusion != null);
}

/**
 * Poll until CI + Desktop Smoke settle, or the wait budget expires.
 * Exported for unit tests via optional sleep/interval overrides in env.
 */
export async function waitForRequiredRuns(repo, sha, opts = {}) {
  const intervalMs = opts.intervalMs ?? Number(process.env.WAIT_INTERVAL_MS || 30_000);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.WAIT_TIMEOUT_MS || 20 * 60 * 1000);
  const sleepFn = opts.sleep ?? sleep;
  const collect = opts.collect ?? collectRequiredRuns;
  const deadline = Date.now() + timeoutMs;

  let requiredRuns = await collect(repo, sha);
  while (!allRequiredSettled(requiredRuns) && Date.now() < deadline) {
    for (const run of requiredRuns) {
      console.log(`[dev-gate]   ${run.workflow}: ${run.conclusion ?? 'pending'}`);
    }
    console.log(`[dev-gate] waiting ${intervalMs}ms for required checks…`);
    await sleepFn(intervalMs);
    requiredRuns = await collect(repo, sha);
  }
  if (!allRequiredSettled(requiredRuns)) {
    // Fail the job (retryable) instead of silently writing publish=false and dropping the commit.
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for required checks on ${sha}`,
    );
  }
  return requiredRuns;
}

async function fetchReleases(repo) {
  const raw = await withRetry(() =>
    gh(['api', '--paginate', `repos/${repo}/releases?per_page=100`,
      '--jq', '.[] | {tag_name, draft, body, created_at}']));
  // --paginate streams one object per line; wrap into an array.
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Compare status of `sha` relative to `base` ("ahead" | "behind" | "identical" | "diverged"). */
async function compareStatus(repo, base, sha) {
  const raw = (await withRetry(() =>
    gh(['api', `repos/${repo}/compare/${base}...${sha}`, '--jq', '.status']))).trim();
  return raw;
}

function resolveSha(eventName) {
  if (eventName === 'workflow_dispatch') return process.env.DISPATCH_SHA ?? '';
  if (eventName === 'push') return process.env.PUSH_SHA || process.env.DISPATCH_SHA || '';
  return process.env.TRIGGER_SHA ?? '';
}

async function runGate() {
  const repo = process.env.REPO;
  const eventName = process.env.EVENT_NAME;

  if (eventName === 'workflow_dispatch') {
    writeOutput({ publish: 'true', sha: process.env.DISPATCH_SHA ?? '' });
    console.log('[dev-gate] manual dispatch — force publish');
    return;
  }

  const sha = resolveSha(eventName);
  if (!repo || !sha) {
    // Not a transient failure — a genuinely absent commit context is a safe hold.
    writeOutput({ publish: 'false', sha: sha ?? '' });
    console.log('[dev-gate] missing REPO/SHA context — holding');
    return;
  }

  // Push: poll until CI + smoke settle. workflow_run: one-shot (already completed).
  const requiredRuns = eventName === 'push'
    ? await waitForRequiredRuns(repo, sha)
    : await collectRequiredRuns(repo, sha);

  const releases = await fetchReleases(repo);
  const releasedShas = devReleaseShas(releases);
  const lastShippedSha = latestShippedSha(releases);

  let aheadOfLastShipped = true;
  if (lastShippedSha && lastShippedSha.toLowerCase() !== sha.toLowerCase()) {
    const status = await compareStatus(repo, lastShippedSha, sha);
    aheadOfLastShipped = status === 'ahead' || status === 'identical';
    console.log(`[dev-gate]   ancestry ${lastShippedSha}...${sha}: ${status}`);
  }

  for (const run of requiredRuns) {
    console.log(`[dev-gate]   ${run.workflow}: ${run.conclusion ?? 'pending'}`);
  }
  const { publish, reason } = decideDevPublish({
    requiredRuns, releasedShas, lastShippedSha, aheadOfLastShipped, sha,
  });
  writeOutput({ publish: publish ? 'true' : 'false', sha });
  console.log(`[dev-gate] ${reason} -> publish=${publish}`);
}

async function runIdempotency() {
  const repo = process.env.REPO;
  const sha = process.env.SHA;
  if (!repo || !sha) throw new Error('idempotency re-check requires REPO and SHA');
  const shipped = devReleaseShas(await fetchReleases(repo)).map((s) => s.toLowerCase())
    .includes(sha.toLowerCase());
  writeOutput({ shipped: shipped ? 'true' : 'false' });
  console.log(`[dev-gate] post-slot re-check: ${sha} ${shipped ? 'already has a dev release — skip' : 'not yet built — proceed'}`);
}

async function main() {
  if (process.env.MODE === 'idempotency') {
    await runIdempotency();
  } else {
    await runGate();
  }
}

/** True when this file is the process entrypoint (Node + Bun; not `import.meta.main`). */
function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    console.error(`[dev-gate] lookup failed after retries: ${err.message}`);
    process.exit(1);
  });
}
