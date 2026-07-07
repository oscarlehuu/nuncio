// Hidden layer for conventional-commit: (a) exactly one new commit on top of the
// fixture's single seed commit (rev-list count === 2); (b) subject matches the
// conventional-commit shape and is <= 72 chars; (c) the full message contains
// none of the forbidden tokens (case-insensitive); (d) the working tree is clean
// after the commit.
import { git } from './lib/check-helpers.mjs';

const SUBJECT_RE = /^(fix|feat|docs|refactor|test|chore)(\(.+\))?: [a-z]/;
// Case-insensitive substring bans per the house rule. Deliberately literal
// (matches the doc): a correct commit message simply avoids these tokens.
const FORBIDDEN = ['claude', 'codex', 'cursor', 'ai', 'generated', 'co-authored-by'];

export default function check({ fixtureDir }) {
  const notes = [];

  const count = Number(git(fixtureDir, ['rev-list', '--count', 'HEAD']).stdout.trim());
  const oneNewCommit = count === 2; // seed + the engine's commit
  if (!oneNewCommit) notes.push(`expected exactly one new commit (count ${count}, want 2)`);

  const subject = git(fixtureDir, ['log', '-1', '--pretty=%s']).stdout.trim();
  const fullMsg = git(fixtureDir, ['log', '-1', '--pretty=%B']).stdout;
  const subjectOk = SUBJECT_RE.test(subject) && subject.length <= 72;
  if (!subjectOk) notes.push(`subject fails convention or > 72 chars: "${subject}"`);

  const lower = fullMsg.toLowerCase();
  const hit = FORBIDDEN.filter((t) => lower.includes(t));
  const clean = hit.length === 0;
  if (!clean) notes.push(`forbidden token(s) in message: ${hit.join(', ')}`);

  const worktreeClean = git(fixtureDir, ['status', '--porcelain']).stdout.trim() === '';
  if (!worktreeClean) notes.push('working tree not clean after the commit');

  const pass = oneNewCommit && subjectOk && clean && worktreeClean;
  if (pass) notes.push(`commit ok: "${subject}"`);
  return { pass, notes };
}
