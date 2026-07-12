import { join } from 'node:path';

/**
 * Global pi extensions allowed into nuncio sessions.
 *
 * Discovery is deny-by-default: the rest of `~/.pi/agent/extensions` is
 * written for the interactive pi CLI (statusline, worktree-dash,
 * session-namer, continual-learning, pocketpi) or rebinds the core
 * read/bash/edit/write tools to a fixed cwd (claude-studio), which breaks
 * worktree sessions. Only extensions that contribute tools a daemon session
 * can actually use are listed here.
 */
export const PI_EXTENSION_ALLOWLIST: readonly string[] = [
  'foreman',
  'subagent',
  // AskUserQuestion is NOT listed: the in-repo pi-engine tool of the same
  // name replaces the global extension (numbered options, nuncio-aware copy).
  'codex/generate',
  'codex/edit',
  'grok/websearch',
  'grok/xsearch',
  'grok/imagegen',
  'grok/imageedit',
  'grok/videogen',
  'grok/videoreference',
  'antigravity/imagegen',
  'antigravity/imageedit',
];

/**
 * Resolve the allowlist to absolute extension paths under the pi agent dir.
 * Paths that do not exist on a machine surface as loader diagnostics, not
 * errors — the session still starts.
 */
export function piEngineExtensionPaths(agentDir: string): string[] {
  return PI_EXTENSION_ALLOWLIST.map((name) => join(agentDir, 'extensions', name));
}
