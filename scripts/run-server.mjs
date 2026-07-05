import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerEnvFile } from './server-env-utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const serverDir = resolve(repoRoot, 'apps/server');
const args = process.argv.slice(2);

if (args.includes('--print-env-file')) {
  console.log(resolveServerEnvFile({ repoRoot }) ?? '');
  process.exit(0);
}

let envFile = null;
try {
  envFile = resolveServerEnvFile({ repoRoot });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const bunArgs = [];
if (envFile) {
  bunArgs.push(`--env-file=${envFile}`);
  console.error(`[nuncio] server env: ${envFile}`);
} else {
  console.error('[nuncio] server env: none found; using process env only');
}
bunArgs.push(...args, 'src/main.ts');

const child = spawn(process.execPath, bunArgs, {
  cwd: serverDir,
  stdio: 'inherit',
  env: process.env,
});

let forwardedSignal = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    forwardedSignal = true;
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal === 'SIGINT' || forwardedSignal) process.exit(130);
  if (signal === 'SIGTERM') process.exit(143);
  process.exit(code ?? 0);
});
