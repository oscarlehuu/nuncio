#!/usr/bin/env node
/**
 * Cut a release for the current root version:
 *   1. Read `version` from the root package.json.
 *   2. Skip if git tag `v<version>` already exists (idempotent — safe to re-run).
 *   3. Extract the matching `## <version>` section from CHANGELOG.md as the release body.
 *   4. Create + push the `v<version>` git tag.
 *   5. Create a GitHub Release with the changelog section as the body (via `gh`).
 *
 * Run after `bun run version` has bumped versions and updated CHANGELOG.md.
 * In CI this runs inside changesets/action's `publish` step once the version PR is merged.
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// 1. Skip if the tag already exists.
const tagExists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
  cwd: root,
  stdio: 'ignore',
}).status === 0;
if (tagExists) {
  console.log(`tag ${tag} already exists — nothing to release.`);
  process.exit(0);
}

// 2. Extract the changelog section for this version.
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
// Match the version header (with optional trailing date) up to the next `## ` or EOF.
const sectionRe = new RegExp(`^## ${version}(?:\\s+.*)?\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
const match = changelog.match(sectionRe);
if (!match) {
  console.error(`no CHANGELOG.md section found for ${version} — run \`bun run version\` first.`);
  process.exit(1);
}
const notes = match[1].trim();
if (!notes) {
  console.error(`CHANGELOG.md section for ${version} is empty — refusing to release.`);
  process.exit(1);
}

// 3. Create + push the tag.
git(`tag ${tag}`);
try {
  git(`push origin ${tag}`);
} catch (err) {
  console.error(`failed to push ${tag}: ${err.message}`);
  process.exit(1);
}
console.log(`created + pushed ${tag}`);

// 4. Create the GitHub Release.
const gh = spawnSync('gh', ['release', 'create', tag, '--title', tag, '--notes', notes], {
  cwd: root,
  encoding: 'utf8',
});
if (gh.status !== 0) {
  console.error(`gh release create failed (exit ${gh.status}):`);
  console.error(gh.stderr || '(no stderr)');
  console.error('The tag was pushed; create the release manually if needed.');
  process.exit(1);
}
console.log(`created GitHub Release ${tag}`);
