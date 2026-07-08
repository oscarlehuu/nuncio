// Fixture: the verify script checks TWO independent conditions — gate()'s
// behavior AND an exported constant's value — but the prompt names only the
// behavior. A first natural attempt fixes the behavior yet leaves the constant
// wrong; the verify failure output names the second condition precisely, so an
// engine that reads the output corrects course. Verify is `bun run verify-gate`,
// runnable by the engine during its turn. Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    {
      name: 'ts-lib-two-condition-gate',
      version: '0.0.0',
      private: true,
      scripts: { 'verify-gate': 'bun run scripts/verify-gate.mjs' },
    },
    null,
    2,
  )}\n`,
  // Both conditions start wrong: gate() always returns false, and THRESHOLD is 0.
  'src/gate.ts': `// gate(n) must return true exactly when n >= THRESHOLD.
export const THRESHOLD = 0;

export function gate(_n: number): boolean {
  return false;
}
`,
  // The two-condition verify. Its output names EACH failing condition precisely.
  'scripts/verify-gate.mjs': `import { gate, THRESHOLD } from '../src/gate.ts';

const failures = [];

// Condition 1 — behavior (the only one the prompt mentions).
if (!(gate(10) === true && gate(9) === false)) {
  failures.push('behavior: gate(n) must return true iff n >= THRESHOLD (expected gate(10)=true, gate(9)=false)');
}
// Condition 2 — the exported constant's exact value (only named in this output).
if (THRESHOLD !== 10) {
  failures.push(\`constant: THRESHOLD must equal 10 (found \${THRESHOLD})\`);
}

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
console.log('verify-gate: both conditions pass');
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
