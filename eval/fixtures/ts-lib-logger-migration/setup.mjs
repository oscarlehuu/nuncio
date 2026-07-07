// Fixture: a logger package whose log() signature changed from log(level, msg)
// to log({ level, msg, scope }). Five src/ call sites still use the old
// positional form. The migrated log() VALIDATES its argument at runtime and
// throws on the old shape, so `bun test` (which drives every call site) is RED
// until the sites adopt the object signature — the runtime contract stands in
// for the type error, keeping the fixture zero-dependency and fully offline
// (no tsc install, no network, deterministic HEAD). The engine migrates the call
// sites (scope = the calling module's file name without extension) without
// touching packages/logger.
import { buildFixture } from '../lib/deterministic-git.mjs';

function callSite(scopeModule) {
  return `import { log } from '../packages/logger/src/index.ts';

export function run(): void {
  // OLD positional signature — rejected by the new log() at runtime.
  log('info', 'work in ${scopeModule}');
}
`;
}

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-logger-migration', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  '.nuncio-eval/README': 'The runtime contract is the spec: log() now takes { level, msg, scope }.\n',
  // The already-migrated logger package (do not touch). log() enforces the new
  // shape at runtime so the migration is observable without a type-checker.
  'packages/logger/src/index.ts': `export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogInput {
  level: Level;
  msg: string;
  scope: string;
}

export function log(input: LogInput): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof (input as { level?: unknown }).level !== 'string' ||
    typeof (input as { msg?: unknown }).msg !== 'string' ||
    typeof (input as { scope?: unknown }).scope !== 'string'
  ) {
    throw new TypeError('log() requires { level, msg, scope } — the old positional signature is gone');
  }
  const { level, msg, scope } = input;
  console.log(\`[\${level}] (\${scope}) \${msg}\`);
}
`,
  // Five call sites still on the OLD positional signature → they throw at runtime.
  'src/alpha.ts': callSite('alpha'),
  'src/beta.ts': callSite('beta'),
  'src/gamma.ts': callSite('gamma'),
  'src/delta.ts': callSite('delta'),
  'src/epsilon.ts': callSite('epsilon'),
  // The suite drives every call site, so all five must be migrated for green.
  'test/migration.spec.ts': `import { expect, test } from 'bun:test';
import { run as alpha } from '../src/alpha';
import { run as beta } from '../src/beta';
import { run as gamma } from '../src/gamma';
import { run as delta } from '../src/delta';
import { run as epsilon } from '../src/epsilon';

for (const [name, run] of Object.entries({ alpha, beta, gamma, delta, epsilon })) {
  test(\`\${name} calls the logger with the new signature\`, () => {
    expect(() => run()).not.toThrow();
  });
}
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
