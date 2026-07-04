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
