#!/usr/bin/env node
/**
 * Sync @nuncio/server, @nuncio/web, and @nuncio/landing package.json versions
 * to the root version.
 *
 * Only the root `nuncio` package is versioned by Changesets (see .changeset/config.json
 * `ignore`). The workspace packages are private and never published, but keeping
 * their versions in lockstep with the root makes "the Nuncio version" unambiguous
 * wherever a package.json is read.
 *
 * IMPORTANT: do NOT run this as part of `bun run version`. changesets/action treats
 * any package.json version bump as a release and reads `<pkg>/CHANGELOG.md` for the
 * PR body — only the root has a changelog. Run manually after a local version bump,
 * or wire into release automation after the version PR merges.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const targetVersion = rootPkg.version;

const targets = [
  resolve(root, 'apps/server/package.json'),
  resolve(root, 'apps/web/package.json'),
  resolve(root, 'apps/landing/package.json'),
];

let changed = false;
for (const path of targets) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.version === targetVersion) continue;
  pkg.version = targetVersion;
  // Preserve a trailing newline like the rest of the repo's JSON files.
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  changed = true;
  console.log(`synced ${path.split('/').slice(-3).join('/')} → ${targetVersion}`);
}

if (!changed) console.log(`all workspace packages already at ${targetVersion}`);
