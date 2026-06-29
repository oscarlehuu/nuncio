#!/usr/bin/env node
/**
 * Create a Changesets fragment non-interactively (for agents / CI-friendly workflows).
 *
 * Usage:
 *   bun run add-changeset patch "Fixed steer composer clearing your draft on reconnect."
 *   bun run add-changeset minor "Added session export from the sidebar."
 *
 * Writes `.changeset/<slug>.md` with the root `nuncio` package bump. See AGENTS.md
 * → Versioning rubric for when to pick patch vs minor vs major.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  formatChangeset,
  isValidBump,
  slugFromSummary,
} from './changeset-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [, , bump, ...summaryParts] = process.argv;
const summary = summaryParts.join(' ').trim();

if (!isValidBump(bump)) {
  console.error('Usage: bun run add-changeset <patch|minor|major> "Release note summary"');
  console.error('See AGENTS.md → Versioning rubric for bump guidance.');
  process.exit(1);
}

if (!summary) {
  console.error('Summary is required — write it from the user\'s perspective (release note, not commit message).');
  process.exit(1);
}

const slug = slugFromSummary(summary);
const suffix = randomBytes(3).toString('hex');
let filename = `${slug}.md`;
let path = resolve(root, '.changeset', filename);
if (existsSync(path)) {
  filename = `${slug}-${suffix}.md`;
  path = resolve(root, '.changeset', filename);
}

const content = formatChangeset(bump, summary);
writeFileSync(path, content);
console.log(`created .changeset/${filename} (${bump})`);
console.log(content);
