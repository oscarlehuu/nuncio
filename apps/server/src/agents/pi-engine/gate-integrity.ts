import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Gate-integrity guard (pure logic). The verify gate lives in `.nuncio/` inside
 * the session workspace, which the agent can also write to — without a guard it
 * could rewrite its own gate to force green. `tool_call` hooks consult this
 * module to block edit/write into any `.nuncio` directory and to
 * advisory-block bash mutations that reference one. Reads stay allowed.
 */

const GATE_DIR = '.nuncio';

export interface GateVerdict {
  block: true;
  reason: string;
}

function containsGateSegment(path: string): boolean {
  return path.split(sep).includes(GATE_DIR);
}

/** Deepest existing ancestor of `path` (the path itself when it exists). */
function existingAncestor(path: string): string | null {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Whether a tool target resolves inside a `.nuncio` gate directory. Two layers:
 * a lexical check on the resolved path (catches direct and `..` forms), then a
 * symlink check via the deepest existing ancestor's realpath (catches a link
 * that points into the gate directory). Both fail soft — a filesystem error
 * never blocks a call by accident.
 */
export function isGateProtectedPath(cwd: string, target: string): boolean {
  const resolved = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  if (containsGateSegment(relative(resolve(cwd), resolved)) || containsGateSegment(resolved)) {
    return true;
  }
  const real = existingAncestor(resolved);
  return real !== null && containsGateSegment(real);
}

/**
 * Write-intent heuristic for the bash advisory block: redirection into a path,
 * a mutating command word, or a git command that rewrites the work tree.
 * Reads (`cat`, `ls`, `sh .nuncio/verify`) pass. This is best-effort string
 * matching by design — an interpreter one-liner can evade it; the edit/write
 * hook is the enforced layer and the classifier's `gate-protected` class keeps
 * the change visible on the verify payloads.
 */
const BASH_WRITE_HINTS =
  /(^|[\s;|&])(rm|mv|cp|chmod|chown|tee|touch|truncate|ln|mkdir|rmdir|sed\s+-i|dd|install|git\s+(checkout|restore|clean|stash|reset))\b|>>?/;

/** Boundary match for a `.nuncio` path token (relative or inside an absolute path). */
const BASH_GATE_TOKEN = /(^|[\s"'=(:;|&/])\.nuncio(\/|\b)/;

function blockReason(target: string): string {
  return (
    `${target} is inside .nuncio/, the harness-owned verify gate. ` +
    'Nuncio blocks the agent from changing its own gate; ask the user to change it via the repo or Settings.'
  );
}

interface ToolCallLike {
  toolName: string;
  input: unknown;
}

/**
 * Evaluate one tool call against the gate. Returns a block verdict or
 * undefined (allow). Only mutating tools are considered: edit/write by target
 * path, bash by advisory string match. Malformed inputs are allowed through —
 * the tool itself will fail loudly on them.
 */
export function evaluateGateIntegrity(
  cwd: string,
  event: ToolCallLike,
): GateVerdict | undefined {
  const input = (event.input ?? {}) as Record<string, unknown>;
  if (event.toolName === 'edit' || event.toolName === 'write') {
    const target = typeof input.path === 'string' ? input.path : null;
    if (target && isGateProtectedPath(cwd, target)) {
      return { block: true, reason: blockReason(target) };
    }
    return undefined;
  }
  if (event.toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : null;
    if (command && BASH_GATE_TOKEN.test(command) && BASH_WRITE_HINTS.test(command)) {
      return { block: true, reason: blockReason(GATE_DIR) };
    }
  }
  return undefined;
}
