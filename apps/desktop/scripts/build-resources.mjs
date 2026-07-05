#!/usr/bin/env node
/**
 * Produce the resources electron-builder ships inside the app bundle:
 *   1. Build the web UI  → apps/web/dist
 *   2. Compile the server into a self-contained binary (Bun runtime embedded)
 *      so it runs without a source tree or a system Bun install.
 *   3. Stage both under apps/desktop/build-resources/ for `extraResources`.
 *
 * The NestJS optional peer deps (microservices/websockets/class-*) are never used
 * at runtime but break static bundling, so they're externalized — Nest's
 * optionalRequire swallows the missing modules at load time.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '../..');
const outDir = join(desktopDir, 'build-resources');
const serverEntry = join(repoRoot, 'apps/server/src/main.ts');
const webDist = join(repoRoot, 'apps/web/dist');

const EXTERNALS = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  'class-validator',
  'class-transformer',
];

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Web UI
run('bun run --filter @nuncio/web build');

// 2. Server → standalone binary
const externals = EXTERNALS.map((e) => `--external '${e}'`).join(' ');
run(`bun build ${serverEntry} --compile ${externals} --outfile ${join(outDir, 'nuncio-server')}`);

// 3. Stage the web bundle next to the binary
if (!existsSync(webDist)) {
  throw new Error(`web dist missing at ${webDist} — the web build did not emit output`);
}
cpSync(webDist, join(outDir, 'web/dist'), { recursive: true });

console.log(`\n✓ build-resources ready at ${outDir}`);
