import { isAbsolute, relative, resolve } from 'node:path';
import { isToolStartEvent } from '../sessions/domain/events.types';
import type { SessionDto, SessionEvent } from '../sessions/domain/sessions.types';
import type { HandoffBrief } from './handoff-brief.types';
import type { WorkspaceSnapshot } from './workspace-snapshot';

const GOAL_MAX_CHARS = 200;
const FILE_CAP = 10;

export interface AssembleSubagentBriefInput {
  parent: SessionDto;
  /** The delegated prompt for this specific child — becomes the brief goal. */
  subagentPrompt: string;
  /** Parent's recent events (e.g. events.listTail(parent.id, 200)). */
  parentTailEvents: SessionEvent[];
  /** Workspace snapshot of the parent at spawn time (may be null). */
  workspace: WorkspaceSnapshot | null;
  /** Resolved verify command, or null when the project defines none. */
  verifyCommand: string | null;
}

/**
 * Build a deterministic handoff brief for a spawned subagent with zero LLM
 * cost. The goal is the child's own prompt; the parent's objective travels as a
 * decision line; files are harvested from the parent's recent tool activity.
 */
export function assembleSubagentBrief(input: AssembleSubagentBriefInput): HandoffBrief {
  const { parent, subagentPrompt, parentTailEvents, workspace, verifyCommand } = input;

  const files = harvestFiles(parentTailEvents, parent.projectPath);
  const lastSeq = parentTailEvents.at(-1)?.seq;

  const brief: HandoffBrief = {
    goal: subagentPrompt.slice(0, GOAL_MAX_CHARS),
    decisions: [`Parent objective: ${parent.prompt.slice(0, GOAL_MAX_CHARS)}`],
    workspace,
    sourceSessionId: parent.id,
  };
  if (files.length) brief.files = files;
  if (verifyCommand) brief.verifyCommand = verifyCommand;
  if (lastSeq !== undefined) brief.sourceSeq = lastSeq;

  return brief;
}

/**
 * Pull repo-relative paths out of the parent's tool activity. Keeps the order
 * of *last* touch (so the most-recently-relevant file leads), dedupes, drops
 * anything outside the project root, and caps the list.
 */
function harvestFiles(events: SessionEvent[], projectRoot: string | null): string[] {
  const seen = new Map<string, number>(); // path -> last seq touched
  for (const event of events) {
    if (!isToolStartEvent(event)) continue;
    const raw = pathFromInput(event.payload.input);
    if (!raw) continue;
    const rel = toRepoRelative(raw, projectRoot);
    if (rel === null) continue;
    seen.set(rel, event.seq);
  }
  // Order by last-touch seq ascending; when over the cap, keep the most
  // recently touched (the tail), preserving chronological order.
  const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path);
  return ordered.length <= FILE_CAP ? ordered : ordered.slice(ordered.length - FILE_CAP);
}

function pathFromInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'cwd'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Normalize a tool path to a repo-relative form, or null if it escapes the
 * project root. Paths are resolved against the root and checked for
 * containment, so `../secrets`, `/proj/../secrets`, and `./src/x` are all
 * handled correctly. Without an absolute root, a relative path is kept only
 * when it doesn't traverse upward; an absolute path can't be proven in-scope
 * and is dropped rather than leaking a machine path.
 */
function toRepoRelative(raw: string, projectRoot: string | null): string | null {
  const hasRoot = Boolean(projectRoot && isAbsolute(projectRoot));

  if (!hasRoot) {
    // No root to resolve against. Drop absolute paths outright; for relative
    // paths, normalize against a synthetic root and reject any that escape it.
    if (isAbsolute(raw)) return null;
    const synthetic = '/__root__';
    const normalized = relative(synthetic, resolve(synthetic, raw));
    if (normalized.startsWith('..') || isAbsolute(normalized)) return null;
    return normalized || '.';
  }

  const root = resolve(projectRoot as string);
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, abs);
  // Outside the root → `relative` yields a `..`-prefixed or absolute path.
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}
