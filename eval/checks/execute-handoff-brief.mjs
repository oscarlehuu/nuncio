// Hidden layer for execute-handoff-brief. Proves the A1 brief pipeline ran AND
// the delegated work landed:
//   pipeline: the child session's first user_message contains the rendered
//             '## Handoff brief' section (the harness posted contextBrief and the
//             real renderer composed it into the first prompt);
//   (a) describe.skip removed from the rate-limit suite;
//   (b) package.json dependencies unchanged;
//   (c) src/server.ts untouched;
//   (d) fixed-window heuristic — ADVISORY only, recorded in notes, never gating.
import { readWorktree, showHead, pathUnchanged } from './lib/check-helpers.mjs';

function firstUserMessageText(events) {
  const um = (Array.isArray(events) ? events : []).find((e) => e?.type === 'user_message');
  return um?.payload?.text ?? '';
}

export default function check({ fixtureDir, sessionEvents }) {
  const notes = [];

  // Pipeline proof: the brief was rendered into the first prompt.
  const briefSeen = firstUserMessageText(sessionEvents).includes('## Handoff brief');
  if (!briefSeen) notes.push("first user_message does not contain '## Handoff brief' — brief pipeline did not run");

  const spec = readWorktree(fixtureDir, 'test/rate-limit.spec.ts') ?? '';
  const skipRemoved = spec.length > 0 && !/describe\.skip\b/.test(spec);
  if (!skipRemoved) notes.push('describe.skip is still present on the rate-limit suite');

  // (b) dependency keys unchanged (compare parsed deps, not raw bytes — a
  // formatting-only edit to package.json is tolerated).
  let depsUnchanged = false;
  try {
    const headPkg = JSON.parse(showHead(fixtureDir, 'package.json') ?? '{}');
    const nowPkg = JSON.parse(readWorktree(fixtureDir, 'package.json') ?? '{}');
    depsUnchanged = JSON.stringify(headPkg.dependencies ?? null) === JSON.stringify(nowPkg.dependencies ?? null);
  } catch {
    depsUnchanged = false;
  }
  if (!depsUnchanged) notes.push('package.json dependencies changed (no new dependencies allowed)');

  const serverUntouched = pathUnchanged(fixtureDir, 'src/server.ts');
  if (!serverUntouched) notes.push('src/server.ts was modified (constraint: do not touch)');

  // (d) advisory: fixed-window heuristic — window arithmetic present, no
  // 'sliding' token. Recorded, never gating.
  const impl = readWorktree(fixtureDir, 'src/middleware/rate-limit.ts') ?? '';
  const looksFixedWindow = !/sliding/i.test(impl) && /window/i.test(impl);
  notes.push(`advisory: implementation ${looksFixedWindow ? 'looks fixed-window' : 'could not be confirmed fixed-window'} (not gating)`);

  const pass = briefSeen && skipRemoved && depsUnchanged && serverUntouched;
  if (pass) notes.push('brief pipeline ran; suite unskipped; deps + server.ts intact');
  return { pass, notes };
}
