// Fixture determinism, parameterized over EVERY fixture under eval/fixtures/.
// Building a fixture twice — in two independent tmp dirs — must yield an
// identical `git rev-parse HEAD`, and that must hold even under a hostile global
// git config (forced GPG signing, hooks, foreign identity, CRLF). This is the
// invariant that makes eval runs comparable across machines and time; the shared
// deterministic-git helper is what enforces it. Runs from the repo root via
// `bun run test:scripts`.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'fixtures');

// Every fixture dir that ships a setup.mjs (skip the shared lib/ dir).
const fixtureIds = readdirSync(fixturesDir).filter((name) => {
  if (name === 'lib') return false;
  try {
    statSync(join(fixturesDir, name, 'setup.mjs'));
    return true;
  } catch {
    return false;
  }
});

function headSha(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git rev-parse failed: ${res.stderr}`);
  return res.stdout.trim();
}
async function build(fixtureId, prefix) {
  const { setup } = await import(join(fixturesDir, fixtureId, 'setup.mjs'));
  const dir = await mkdtemp(join(tmpdir(), `det-${prefix}-`));
  await setup(dir);
  return dir;
}

describe('fixture determinism (all fixtures)', () => {
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  });

  test('at least one fixture is discovered', () => {
    expect(fixtureIds.length).toBeGreaterThan(0);
  });

  for (const fixtureId of fixtureIds) {
    test(`${fixtureId}: identical HEAD across two builds AND under a hostile global git config`, async () => {
      // Clean-config baseline built twice.
      delete process.env.GIT_CONFIG_GLOBAL;
      const a = await build(fixtureId, `${fixtureId}-a`);
      const b = await build(fixtureId, `${fixtureId}-b`);

      // Hostile global config that would perturb a naive commit.
      const cfgDir = await mkdtemp(join(tmpdir(), 'det-hostile-cfg-'));
      const cfgFile = join(cfgDir, 'gitconfig');
      writeFileSync(
        cfgFile,
        [
          '[user]',
          '\tname = Someone Else',
          '\temail = someone@evil.example',
          '[commit]',
          '\tgpgsign = true',
          '[tag]',
          '\tgpgsign = true',
          '[core]',
          `\thooksPath = ${join(cfgDir, 'hooks')}`,
          '\tautocrlf = true',
          '',
        ].join('\n'),
        'utf8',
      );

      try {
        const baseline = headSha(a);
        expect(headSha(b), `${fixtureId}: two clean builds diverged`).toBe(baseline);

        process.env.GIT_CONFIG_GLOBAL = cfgFile;
        const hostile = await build(fixtureId, `${fixtureId}-hostile`);
        try {
          expect(headSha(hostile), `${fixtureId}: hostile git config changed HEAD`).toBe(baseline);
        } finally {
          await rm(hostile, { recursive: true, force: true });
        }
      } finally {
        await rm(a, { recursive: true, force: true });
        await rm(b, { recursive: true, force: true });
        await rm(cfgDir, { recursive: true, force: true });
      }
    });
  }
});
