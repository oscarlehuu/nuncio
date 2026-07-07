// Fixture: a logger workspace package whose log() signature already changed from
// log(level, msg) to log({ level, msg, scope }). Five src/ call sites still use
// the old positional form, so `tsc --noEmit` fails at HEAD. The engine migrates
// the call sites (scope = calling module's file name without extension) without
// touching packages/logger.
//
// This is the ONE fixture with a dependency: a real type-checker is required, so
// it ships `typescript` as its sole committed devDep and the builder runs
// `bun install` (resolves offline from bun's cache). The doc's convention allows
// a committed lockb where deps exist. All other batch fixtures are zero-dep.
import { spawnSync } from 'node:child_process';
import { commitAll, initRepo, writeFiles } from '../lib/deterministic-git.mjs';

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'es2022',
    types: [],
    skipLibCheck: true,
    baseUrl: '.',
    paths: { '@app/logger': ['packages/logger/src/index.ts'] },
  },
  include: ['src', 'packages'],
};

function callSite(scopeModule) {
  return `import { log } from '@app/logger';

export function run(): void {
  log('info', 'work in ${scopeModule}');
}
`;
}

const FILES = {
  'package.json': `${JSON.stringify(
    {
      name: 'ts-lib-logger-migration',
      version: '0.0.0',
      private: true,
      scripts: { typecheck: 'tsc --noEmit', test: 'bun test' },
      devDependencies: { typescript: '5.9.3' },
    },
    null,
    2,
  )}\n`,
  '.gitignore': 'node_modules/\n',
  'tsconfig.json': `${JSON.stringify(TSCONFIG, null, 2)}\n`,
  '.nuncio-eval/README': 'The compiler errors are the spec. Migrate the call sites.\n',
  // The already-migrated logger package (do not touch).
  'packages/logger/package.json': `${JSON.stringify(
    { name: '@app/logger', version: '1.0.0', private: true, main: 'src/index.ts' },
    null,
    2,
  )}\n`,
  'packages/logger/src/index.ts': `export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogInput {
  level: Level;
  msg: string;
  scope: string;
}

export function log(input: LogInput): void {
  const { level, msg, scope } = input;
  console.log(\`[\${level}] (\${scope}) \${msg}\`);
}
`,
  // Five call sites still on the OLD positional signature → tsc fails.
  'src/alpha.ts': callSite('alpha'),
  'src/beta.ts': callSite('beta'),
  'src/gamma.ts': callSite('gamma'),
  'src/delta.ts': callSite('delta'),
  'src/epsilon.ts': callSite('epsilon'),
  'test/smoke.spec.ts': `import { expect, test } from 'bun:test';
import { log } from '@app/logger';

test('logger accepts the new shape', () => {
  expect(() => log({ level: 'info', msg: 'hi', scope: 'test' })).not.toThrow();
});
`,
};

export async function setup(dir) {
  const git = initRepo(dir);
  await writeFiles(dir, FILES);
  // Install the type-checker (resolves offline from bun's cache) BEFORE the seed
  // commit, so the generated bun.lock is committed and node_modules — ignored —
  // leaves the working tree clean. Committing the lock keeps HEAD deterministic
  // and installs hermetic.
  const res = spawnSync('bun', ['install'], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`bun install failed in ts-lib-logger-migration fixture: ${res.stderr || res.stdout}`);
  }
  commitAll(git);
  return dir;
}
