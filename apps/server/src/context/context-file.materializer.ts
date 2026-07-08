import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ContextFilePolicy = 'none' | 'worktree-local';

/** The exact do-not-edit pointer appended to every materialized context file. */
export const CONTEXT_FILE_POINTER = 'Managed by nuncio — do not edit; edit facts in the nuncio UI.';

export interface MaterializeOptions {
  policy: ContextFilePolicy;
  /** Engine's native context-file name (from the resolved profile); omit → nothing. */
  contextFileName?: string;
  /** Rendered project-facts block (B2 renderer); may be empty. */
  factsBlock: string;
  /** Warning sink for rejected file names; defaults to console.warn. */
  warn?: (message: string) => void;
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

  const warn = options.warn ?? ((message: string) => console.warn(`[context-file] ${message}`));
  // Bare-filename guard: the profile field must never carry separators,
  // traversal segments, or an absolute path — skip (write nothing) otherwise.
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || isAbsolute(fileName)) {
    warn(`context file name "${fileName}" is not a bare filename; skipping materialization`);
    return { written: false, skipped: false };
  }
  // Containment backstop: the resolved target must stay directly inside the
  // worktree root (mirrors the resolve+relative check in handoff-brief.assembler).
  const root = resolve(worktreePath);
  const target = resolve(root, fileName);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    warn(`context file name "${fileName}" resolves outside the worktree; skipping materialization`);
    return { written: false, skipped: false };
  }

  if (existsSync(target)) {
    return { written: false, skipped: true };
  }

  const facts = options.factsBlock.trim();
  const body = facts ? `${facts}\n\n${CONTEXT_FILE_POINTER}\n` : `${CONTEXT_FILE_POINTER}\n`;
  writeFileSync(target, body);
  ensureExcluded(worktreePath, fileName);
  return { written: true, skipped: false };
}
