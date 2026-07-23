import {
  groupSessionsByRepo,
  type RepoGroupSessionInput,
} from '@nuncio/core';
import { statusLabel, type Session } from './api';
import { projectDisplayName } from './projects';

export const CHAT_GROUP_KEY = '__chat__';

export const SIDEBAR_COLLAPSED_GROUPS_KEY = 'nuncio-sidebar-collapsed-groups';
export const SIDEBAR_GROUP_BY_KEY = 'nuncio-sidebar-group-by';

/** How the sidebar session list is organized. Repository is the default. */
export type SidebarGroupBy = 'repository' | 'status';

/** Lane order when grouping by status — most-attention-worthy first. */
const STATUS_GROUP_ORDER: Session['status'][] = [
  'RUNNING',
  'ERROR',
  'PAUSED',
  'IDLE',
  'CREATED',
];

export interface SessionGroup {
  key: string;
  name: string;
  projectPath: string | null;
  sessions: Session[];
}

export function groupSessionsByProject(sessions: Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const session of sessions) {
    const key = session.projectPath ?? CHAT_GROUP_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: session.projectPath ? (projectDisplayName(session.projectPath) ?? session.projectPath) : 'Chat',
        projectPath: session.projectPath,
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }

  return [...groups.values()];
}

/** A linked worktree under a repo: its branch and the session(s) occupying it. */
interface RepoWorktreeGroup {
  path: string;
  branch: string | null;
  sessions: Session[];
}

/**
 * A repository-mode group. Extends {@link SessionGroup} so the sidebar's existing
 * project/chat split (`projectPath !== null`) keeps working. Identity-backed repos
 * collapse every worktree of one repo into a single entry; loose folders / non-git
 * sessions fall through to the path + chat groups (`repoRoot: null`, no worktrees).
 */
export interface RepoSessionGroup extends SessionGroup {
  /** The owning repo's main checkout — display name + PR-summary path. Null for fallback/chat. */
  repoRoot: string | null;
  /** Linked worktrees under this repo. Empty for path-fallback and chat groups. */
  worktrees: RepoWorktreeGroup[];
}

function hasRepoIdentity(session: Session): boolean {
  return Boolean(session.repoIdentityId && session.repoRoot);
}

function mapSessionIds(ids: string[], byId: Map<string, Session>): Session[] {
  const out: Session[] = [];
  for (const id of ids) {
    const session = byId.get(id);
    if (session) out.push(session);
  }
  return out;
}

/**
 * Repository-mode grouping: one entry per repo (all its worktrees folded in),
 * driven by the shared `groupSessionsByRepo` helper in `@nuncio/core`. Sessions
 * without a stable repo identity (non-git / no workdir / older rows) stay in the
 * existing path + `__chat__` fallback so loose folders never regress. Groups are
 * emitted in the order each first appears in the session list.
 */
export function groupSessionsByRepository(sessions: Session[]): RepoSessionGroup[] {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // Identity-backed sessions → one group per repo, with worktrees folded in.
  const repoInputs: RepoGroupSessionInput[] = sessions.filter(hasRepoIdentity).map((s) => ({
    id: s.id,
    identityId: s.repoIdentityId as string,
    repoRoot: s.repoRoot as string,
    name: projectDisplayName(s.repoRoot) ?? (s.repoRoot as string),
    branch: s.branch,
    worktreePath: s.worktreePath,
    isWorktree: s.isWorktree ?? false,
  }));

  const byKey = new Map<string, RepoSessionGroup>();
  for (const group of groupSessionsByRepo(repoInputs)) {
    const key = `repo:${group.id}`;
    byKey.set(key, {
      key,
      name: group.name,
      projectPath: group.repoRoot,
      repoRoot: group.repoRoot,
      sessions: mapSessionIds(group.sessionIds, sessionById),
      worktrees: group.worktrees.map((w) => ({
        path: w.path,
        branch: w.branch,
        sessions: mapSessionIds(w.sessionIds, sessionById),
      })),
    });
  }

  // Loose folders / non-git sessions keep the existing path + chat grouping.
  for (const group of groupSessionsByProject(sessions.filter((s) => !hasRepoIdentity(s)))) {
    byKey.set(group.key, { ...group, repoRoot: null, worktrees: [] });
  }

  const keyFor = (s: Session) =>
    hasRepoIdentity(s) ? `repo:${s.repoIdentityId}` : (s.projectPath ?? CHAT_GROUP_KEY);
  const seen = new Set<string>();
  const ordered: RepoSessionGroup[] = [];
  for (const s of sessions) {
    const key = keyFor(s);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = byKey.get(key);
    if (group) ordered.push(group);
  }
  return ordered;
}

export function loadCollapsedGroups(storage: Storage = localStorage): Set<string> {
  try {
    const raw = storage.getItem(SIDEBAR_COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === 'string'));
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(keys: Set<string>, storage: Storage = localStorage): void {
  storage.setItem(SIDEBAR_COLLAPSED_GROUPS_KEY, JSON.stringify([...keys]));
}

/** Group sessions into status lanes (Running / Error / Paused / Idle / …), ordered
 *  by attention. Empty lanes are dropped. `projectPath` stays null — these aren't
 *  repo groups; the group name is the human status label. */
export function groupSessionsByStatus(sessions: Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const key = `status:${session.status}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: statusLabel(session.status), projectPath: null, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return STATUS_GROUP_ORDER.map((s) => groups.get(`status:${s}`)).filter(
    (g): g is SessionGroup => g !== undefined,
  );
}

export function loadSidebarGroupBy(storage: Storage = localStorage): SidebarGroupBy {
  try {
    return storage.getItem(SIDEBAR_GROUP_BY_KEY) === 'status' ? 'status' : 'repository';
  } catch {
    return 'repository';
  }
}

export function saveSidebarGroupBy(value: SidebarGroupBy, storage: Storage = localStorage): void {
  try {
    storage.setItem(SIDEBAR_GROUP_BY_KEY, value);
  } catch {
    // Best-effort; a blocked quota must not break the sidebar.
  }
}
