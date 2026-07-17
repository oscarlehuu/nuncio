#!/usr/bin/env node
/**
 * Gate for the dev desktop-release channel. Decides whether the current
 * `workflow_run` (or manual dispatch) should publish a signed dev prerelease, and
 * writes `publish` + `sha` to $GITHUB_OUTPUT for the publish job to consume.
 *
 * Publishes only when every required workflow concluded success on the exact commit
 * and that commit has not already shipped a dev release (idempotent re-runs). The
 * pure decision lives in desktop-dev-gate-utils.mjs and is unit tested; this file is
 * the I/O shell around `gh`.
 *
 * Env:
 *   EVENT_NAME    github.event_name (workflow_run | workflow_dispatch)
 *   REPO          owner/repo
 *   TRIGGER_SHA   github.event.workflow_run.head_sha (workflow_run)
 *   DISPATCH_SHA  github.sha (workflow_dispatch force-publish)
 *   GH_TOKEN      token for `gh`
 *   GITHUB_OUTPUT step output file
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { decideDevPublish, publishedDevShas } from './desktop-dev-gate-utils.mjs';

const REQUIRED_WORKFLOWS = ['ci.yml', 'desktop-smoke.yml'];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function emit(publish, sha, reason) {
  const out = process.env.GITHUB_OUTPUT;
  const line = `publish=${publish ? 'true' : 'false'}\nsha=${sha ?? ''}\n`;
  if (out) appendFileSync(out, line);
  console.log(`[dev-gate] ${reason} -> publish=${publish} sha=${sha ?? '(none)'}`);
}

function conclusionAt(repo, workflowFile, sha) {
  const query = `repos/${repo}/actions/workflows/${workflowFile}/runs` +
    `?head_sha=${sha}&branch=dev&event=push&per_page=1`;
  const raw = gh(['api', query, '--jq', '.workflow_runs[0].conclusion // "pending"']).trim();
  // A still-running or missing run reads as "pending"; treat only real conclusions.
  return raw === 'pending' || raw === '' ? null : raw;
}

function fetchReleases(repo) {
  const raw = gh(['api', `repos/${repo}/releases?per_page=100`,
    '--jq', '[.[] | {tag_name, draft, body}]']);
  return JSON.parse(raw);
}

function main() {
  const repo = process.env.REPO;
  const eventName = process.env.EVENT_NAME;

  if (eventName === 'workflow_dispatch') {
    emit(true, process.env.DISPATCH_SHA, 'manual dispatch — force publish');
    return;
  }

  const sha = process.env.TRIGGER_SHA;
  if (!repo || !sha) {
    // Missing context is fail-safe: never publish.
    emit(false, sha, 'missing REPO/TRIGGER_SHA context');
    return;
  }

  let requiredRuns;
  let published;
  try {
    requiredRuns = REQUIRED_WORKFLOWS.map((file) => ({
      workflow: `.github/workflows/${file}`,
      conclusion: conclusionAt(repo, file, sha),
    }));
    published = publishedDevShas(fetchReleases(repo));
  } catch (err) {
    // A GitHub API hiccup must never green-light a publish.
    emit(false, sha, `gate lookup failed: ${err.message}`);
    process.exitCode = 0;
    return;
  }

  for (const run of requiredRuns) {
    console.log(`[dev-gate]   ${run.workflow}: ${run.conclusion ?? 'pending'}`);
  }
  const { publish, reason } = decideDevPublish({ requiredRuns, publishedShas: published, sha });
  emit(publish, sha, reason);
}

main();
