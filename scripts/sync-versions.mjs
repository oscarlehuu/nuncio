#!/usr/bin/env node
/**
 * Sync @nuncio/server and @nuncio/web package.json versions to the root version.
 *
 * Only the root `nuncio` package is versioned by Changesets (see .changeset/config.json
 * `ignore`). The two workspace packages are private and never published, but keeping
 * their versions in lockstep with the root makes "the Nuncio version" unambiguous
 * wherever a package.json is read.
 *
 * Runs automatically as part of `bun run version`. Exits 0 if already in sync.
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
