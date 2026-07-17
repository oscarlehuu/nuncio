#!/usr/bin/env node
/**
 * Gate for the dev desktop-release channel. Two modes:
 *
 *   MODE=gate (default) — decide whether the current `workflow_run` / manual dispatch
 *     should publish; writes `publish` + `sha` to $GITHUB_OUTPUT for the publish job.
 *   MODE=idempotency — the post-slot re-check the build runs AFTER acquiring the publish
 *     concurrency slot; writes `shipped` (true if a dev release already exists for SHA)
 *     so a build that lost the two-gates race skips instead of duplicating.
 *
 * Publishes only when every required workflow concluded success on the exact commit,
 * the commit has no dev release yet (draft or published), and the commit is not behind
 * the last shipped dev commit (never auto-update backward). The pure decision lives in
 * desktop-dev-gate-utils.mjs and is unit tested; this file is the I/O shell around `gh`.
 *
 * A GitHub API lookup that keeps failing THROWS (non-zero exit) so the job fails and can
 * be re-run — it never writes publish=false, which would silently drop a green commit.
 *
 * Env: EVENT_NAME, REPO, TRIGGER_SHA (workflow_run), DISPATCH_SHA (dispatch),
 *      SHA (idempotency mode), GH_TOKEN, GITHUB_OUTPUT, MODE.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
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

async function conclusionAt(repo, workflowFile, sha) {
  const query = `repos/${repo}/actions/workflows/${workflowFile}/runs` +
    `?head_sha=${sha}&branch=dev&event=push&per_page=1`;
  const raw = (await withRetry(() =>
    gh(['api', query, '--jq', '.workflow_runs[0].conclusion // "pending"']))).trim();
  // A still-running or missing run reads as "pending"; treat only real conclusions.
  return raw === 'pending' || raw === '' ? null : raw;
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

async function runGate() {
  const repo = process.env.REPO;
  if (process.env.EVENT_NAME === 'workflow_dispatch') {
    writeOutput({ publish: 'true', sha: process.env.DISPATCH_SHA ?? '' });
    console.log('[dev-gate] manual dispatch — force publish');
    return;
  }

  const sha = process.env.TRIGGER_SHA;
  if (!repo || !sha) {
    // Not a transient failure — a genuinely absent commit context is a safe hold.
    writeOutput({ publish: 'false', sha: sha ?? '' });
    console.log('[dev-gate] missing REPO/TRIGGER_SHA context — holding');
    return;
  }

  // Lookups retry with backoff; a persistent failure throws (job fails, retryable)
  // rather than silently holding a green commit.
  const requiredRuns = [];
  for (const file of REQUIRED_WORKFLOWS) {
    requiredRuns.push({
      workflow: `.github/workflows/${file}`,
      conclusion: await conclusionAt(repo, file, sha),
    });
  }
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

main().catch((err) => {
  console.error(`[dev-gate] lookup failed after retries: ${err.message}`);
  process.exit(1);
});
