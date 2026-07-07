import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type ContextFilePolicy = 'none' | 'worktree-local';

/** The exact do-not-edit pointer appended to every materialized context file. */
export const CONTEXT_FILE_POINTER = 'Managed by nuncio — do not edit; edit facts in the nuncio UI.';

export interface MaterializeOptions {
  policy: ContextFilePolicy;
  /** Engine's native context-file name (from the resolved profile); omit → nothing. */
  contextFileName?: string;
  /** Rendered project-facts block (B2 renderer); may be empty. */
  factsBlock: string;
}

export interface MaterializeResult {
  written: boolean;
  /** True when a pre-existing file was found and left untouched. */
  skipped: boolean;
}

/**
 * Resolve the worktree's git directory. In a linked worktree `.git` is a FILE
 * containing `gitdir: <path>` (pointing at `<repo>/.git/worktrees/<name>`); in a
 * plain repo it is the `.git` directory itself.
 */
function resolveGitDir(worktreePath: string): string {
  const dotGit = join(worktreePath, '.git');
  if (!existsSync(dotGit)) return dotGit; // caller mkdir's it (plain-dir test case)
  if (statSync(dotGit).isDirectory()) return dotGit;
  // `.git` is a file: read its gitdir pointer.
  const pointer = readFileSync(dotGit, 'utf8').trim();
  const match = pointer.match(/^gitdir:\s*(.+)$/);
  if (!match) return dotGit;
  const target = match[1]!.trim();
  return isAbsolute(target) ? target : resolve(worktreePath, target);
}

function ensureExcluded(worktreePath: string, fileName: string): void {
  const excludePath = join(resolveGitDir(worktreePath), 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });
  let current = '';
  if (existsSync(excludePath)) current = readFileSync(excludePath, 'utf8');
  const already = current.split('\n').some((line) => line.trim() === fileName);
  if (already) return;
  const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(excludePath, `${prefix}${fileName}\n`);
}

/**
 * B4: under the `worktree-local` policy, write the engine's native context file
 * into the session worktree — the rendered facts plus a do-not-edit pointer —
 * and add it to `.git/info/exclude` (NEVER the repo `.gitignore`). Hard rules:
 * `none` policy or no `contextFileName` → write nothing; a pre-existing file →
 * write nothing and report `skipped` (never merge/overwrite a checked-in
 * override). Session-preamble injection (B2) is unaffected — the file is
 * engine-idiomatic reinforcement, not the guarantee.
 */
export function materializeContextFile(
  worktreePath: string,
  options: MaterializeOptions,
): MaterializeResult {
  const fileName = options.contextFileName?.trim();
  if (options.policy !== 'worktree-local' || !fileName) {
    return { written: false, skipped: false };
  }

  const target = join(worktreePath, fileName);
  if (existsSync(target)) {
    return { written: false, skipped: true };
  }

  const facts = options.factsBlock.trim();
  const body = facts ? `${facts}\n\n${CONTEXT_FILE_POINTER}\n` : `${CONTEXT_FILE_POINTER}\n`;
  writeFileSync(target, body);
  ensureExcluded(worktreePath, fileName);
  return { written: true, skipped: false };
}
