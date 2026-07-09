#!/usr/bin/env node
/**
 * Produce the resources electron-builder ships inside the app bundle:
 *   1. Build the web UI  → apps/web/dist
 *   2. Bundle the server as a Bun SCRIPT (build-resources/server/server.js) and
 *      ship the Bun runtime alongside it. A `--compile` standalone binary cannot
 *      run @cursor/sdk — the SDK lazy-loads numbered chunk files at runtime
 *      (`import("./" + id + ".js")`), which can't be statically bundled, and a
 *      compiled Bun binary can never resolve bare specifiers from on-disk
 *      node_modules. So the SDK stays external and is staged as a real
 *      node_modules tree next to server.js.
 *   3. Stage both under apps/desktop/build-resources/ for `extraResources`.
 *
 * The NestJS optional peer deps (microservices/websockets/class-*) are never used
 * at runtime but break static bundling, so they're externalized — Nest's
 * optionalRequire swallows the missing modules at load time.
 */
import { execSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '../..');
const outDir = join(desktopDir, 'build-resources');
const serverOutDir = join(outDir, 'server');
const serverEntry = join(repoRoot, 'apps/server/src/main.ts');
const webDist = join(repoRoot, 'apps/web/dist');

const EXTERNALS = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  'class-validator',
  'class-transformer',
  // Loads platform binaries + numbered chunks at runtime; must resolve from a
  // real on-disk node_modules staged next to the bundle.
  '@cursor/sdk',
];

function run(cmd, cwd = repoRoot) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(serverOutDir, { recursive: true });

// 1. Web UI
run('bun run --filter @nuncio/web build');

// 2. Server → bun script bundle
const externals = EXTERNALS.map((e) => `--external '${e}'`).join(' ');
run(
  `bun build ${serverEntry} --target=bun ${externals} --outfile ${join(serverOutDir, 'server.js')}`,
);

// 2a. Stage @cursor/sdk as a real (hoisted, symlink-free) node_modules via
// `npm ci` against the committed lockfile in cursor-sdk-staging/, so the shipped
// dependency tree is byte-reproducible instead of floating on semver ranges.
// bun install would symlink into its store, which electron-builder's resource
// copy does not follow.
const stagingDir = join(desktopDir, 'cursor-sdk-staging');
const sdkPkgPath = join(repoRoot, 'apps/server/node_modules/@cursor/sdk/package.json');
if (!existsSync(sdkPkgPath)) {
  throw new Error(`@cursor/sdk not installed at ${sdkPkgPath} — run bun install first`);
}
const sdkVersion = JSON.parse(readFileSync(sdkPkgPath, 'utf8')).version;
const stagedManifest = JSON.parse(readFileSync(join(stagingDir, 'package.json'), 'utf8'));
const stagedVersion = stagedManifest.dependencies['@cursor/sdk'];
if (stagedVersion !== sdkVersion) {
  throw new Error(
    `cursor-sdk-staging pins @cursor/sdk ${stagedVersion} but apps/server has ${sdkVersion} — ` +
      'update apps/desktop/cursor-sdk-staging/package.json + package-lock.json together with the workspace dep',
  );
}
copyFileSync(join(stagingDir, 'package.json'), join(serverOutDir, 'package.json'));
copyFileSync(join(stagingDir, 'package-lock.json'), join(serverOutDir, 'package-lock.json'));
run('npm ci --omit=dev --no-audit --no-fund', serverOutDir);

// Validate the pieces the SDK actually needs at runtime, not just its manifest:
// the lazy-loaded chunk files and this platform's native package.
const sdkDistEsm = join(serverOutDir, 'node_modules/@cursor/sdk/dist/esm');
const chunkCount = existsSync(sdkDistEsm)
  ? readdirSync(sdkDistEsm).filter((f) => /^\d+\.js$/.test(f)).length
  : 0;
if (chunkCount === 0) {
  throw new Error(`staged @cursor/sdk has no runtime chunks under ${sdkDistEsm} — packaged cursor would break`);
}
const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`;
if (!existsSync(join(serverOutDir, 'node_modules', platformPkg))) {
  throw new Error(`staged SDK is missing its native package ${platformPkg} — optional-dependency install failed`);
}

// 2b. Ship the Bun runtime that will execute server.js.
if (!basename(process.execPath).includes('bun')) {
  throw new Error(
    `build-resources must run under bun (execPath is ${process.execPath}) — the runtime is copied into the bundle`,
  );
}
const bunOut = join(outDir, 'bun');
copyFileSync(process.execPath, bunOut);
chmodSync(bunOut, 0o755);

// 2c. Functional smoke: prove the staged SDK loads its runtime chunks under the
// shipped runtime. models.list with a bogus key must surface an auth/network
// class of error — a ResolveMessage means the chunk layout is broken and the
// packaged app would silently fall back to the static cursor model list.
const smoke = [
  `const sdk = await import('@cursor/sdk');`,
  `try {`,
  `  await sdk.Cursor.models.list({ apiKey: 'crsr_build_smoke' });`,
  `} catch (err) {`,
  `  if (String(err).includes('Cannot find module')) { console.error('SMOKE FAIL:', err); process.exit(1); }`,
  `}`,
  `console.log('cursor sdk smoke ok');`,
].join('\n');
writeFileSync(join(serverOutDir, '.sdk-smoke.mjs'), smoke);
run(`${bunOut} .sdk-smoke.mjs`, serverOutDir);
rmSync(join(serverOutDir, '.sdk-smoke.mjs'));

// 3. Stage the web bundle next to the server
if (!existsSync(webDist)) {
  throw new Error(`web dist missing at ${webDist} — the web build did not emit output`);
}
cpSync(webDist, join(outDir, 'web/dist'), { recursive: true });

console.log(`\n✓ build-resources ready at ${outDir}`);
