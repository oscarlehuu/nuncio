#!/usr/bin/env node
/**
 * CI/local gate: user-facing source changes must ship a Changesets fragment.
 *
 * Usage:
 *   bun run check-changeset                          # diff vs origin/main
 *   bun run check-changeset -- --base=origin/main    # explicit base
 *
 * Skip (pure refactor / test-only touching src layout):
 *   Add `<!-- no-changeset -->` to the PR description, or set SKIP_CHANGESET_CHECK=1 locally.
 *
 * Release PRs titled `chore: release version` are skipped automatically.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { shouldRequireChangeset } from './changeset-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  let base = process.env.BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  for (const arg of argv) {
    if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
  }
  return { base };
}

function listChangedFiles(base, head) {
  const range = `${base}...${head}`;
  const out = git(`diff --name-only ${range}`);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

function shouldSkipCheck() {
  if (process.env.SKIP_CHANGESET_CHECK === '1') return true;
  const title = process.env.PR_TITLE || '';
  if (title.includes('chore: release version')) return true;
  const body = process.env.PR_BODY || '';
  if (body.includes('<!-- no-changeset -->')) return true;
  return false;
}

const { base } = parseArgs(process.argv.slice(2));
const head = process.env.GITHUB_SHA || process.env.HEAD_SHA || 'HEAD';

if (shouldSkipCheck()) {
  console.log('changeset check skipped (release PR or explicit skip marker).');
  process.exit(0);
}

let changedFiles;
try {
  changedFiles = listChangedFiles(base, head);
} catch (err) {
  console.error(`failed to diff ${base}...${head}: ${err.message}`);
  console.error('Ensure the base ref is fetched (CI: fetch-depth: 0).');
  process.exit(1);
}

const required = shouldRequireChangeset(changedFiles);

if (!required) {
  console.log('changeset check passed.');
  process.exit(0);
}

console.error('User-facing source files changed but no .changeset/*.md fragment found.');
console.error('');
console.error('Changed user-facing paths require a release note before merge.');
console.error('Agents: pick bump type per AGENTS.md → Versioning rubric, then run:');
console.error('  bun run add-changeset patch "Fixed …"');
console.error('  bun run add-changeset minor "Added …"');
console.error('');
console.error('Pure refactor/test-only (no user-visible behavior change)? Add <!-- no-changeset --> to the PR body.');
console.error('');
console.error('Diff base:', `${base}...${head}`);
for (const file of changedFiles.filter((f) => f.startsWith('apps/') || f === 'mockup.html')) {
  console.error(`  - ${file}`);
}
process.exit(1);
