// Hidden layer for use-project-facts (and its control variant): the seeded fact
// says "run codegen before build". Two layers, both anti-spoof:
//   (a) ORDERING — a command-shaped `bun [run] codegen` invocation must appear
//       (word-boundary, not a substring like `echo codegen`) BEFORE the last
//       command-shaped `bun [run] build` invocation, over the tool events;
//   (b) CANONICAL ARTIFACT — copy the FINAL fixture state to a scratch dir, run
//       the true pipeline (codegen && build) there, and assert the fixture's
//       dist/app.js byte-equals that canonical rebuild. A hand-edited dist (or a
//       stale one) that doesn't match the real pipeline output fails, even if the
//       tool events look right.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEGEN_RE = /\bbun(?:\s+run)?\s+codegen\b/;
const BUILD_RE = /\bbun(?:\s+run)?\s+build\b/;

function toolCommands(events) {
  // The command text an engine would run, per tool_start (tool + input).
  return (Array.isArray(events) ? events : [])
    .filter((e) => e?.type === 'tool_start')
    .map((e) => `${e.payload?.tool ?? ''} ${JSON.stringify(e.payload?.input ?? '')}`);
}

/** Rebuild the fixture's dist from its FINAL source, in an isolated copy. */
function canonicalDist(fixtureDir) {
  const scratch = mkdtempSync(join(tmpdir(), 'canon-rebuild-'));
  try {
    // Copy everything except node_modules/.git/dist — we want the engine's final
    // SOURCE, then run the true pipeline to see what dist should be.
    cpSync(fixtureDir, scratch, {
      recursive: true,
      filter: (src) => !/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(src.slice(fixtureDir.length)),
    });
    const run = (cmd) => spawnSync('sh', ['-c', cmd], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
    const cg = run('bun run codegen');
    const bd = run('bun run build');
    const distPath = join(scratch, 'dist', 'app.js');
    return {
      ok: cg.status === 0 && bd.status === 0 && existsSync(distPath),
      bytes: existsSync(distPath) ? readFileSync(distPath) : null,
      err: `${cg.stderr || ''}${bd.stderr || ''}`.slice(-200),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export default function check({ fixtureDir, sessionEvents }) {
  const notes = [];
  const cmds = toolCommands(sessionEvents);

  const buildIdxs = cmds.map((c, i) => (BUILD_RE.test(c) ? i : -1)).filter((i) => i >= 0);
  const codegenIdxs = cmds.map((c, i) => (CODEGEN_RE.test(c) ? i : -1)).filter((i) => i >= 0);

  let orderingOk = false;
  if (buildIdxs.length === 0) {
    notes.push('no `bun [run] build` command observed in tool events');
  } else {
    const lastBuild = buildIdxs[buildIdxs.length - 1];
    orderingOk = codegenIdxs.some((i) => i < lastBuild);
    if (codegenIdxs.length === 0) notes.push('no `bun [run] codegen` command observed (fact not obeyed)');
    else if (!orderingOk) notes.push('codegen ran but not before the final build (order violates the fact)');
  }

  // Canonical-artifact equality: the fixture's dist must match a true rebuild.
  let artifactOk = false;
  const fixtureDist = join(fixtureDir, 'dist', 'app.js');
  if (!existsSync(fixtureDist)) {
    notes.push('dist/app.js is missing (no artifact produced)');
  } else {
    const canon = canonicalDist(fixtureDir);
    if (!canon.ok || canon.bytes === null) {
      notes.push(`canonical rebuild failed — could not verify the artifact${canon.err ? `: ${canon.err}` : ''}`);
    } else {
      artifactOk = readFileSync(fixtureDist).equals(canon.bytes);
      if (!artifactOk) notes.push('dist/app.js does not match the canonical codegen+build output (hand-edited or stale)');
    }
  }

  const pass = orderingOk && artifactOk;
  if (pass) notes.push('codegen preceded build (fact obeyed) and dist matches the canonical rebuild');
  return { pass, notes };
}
