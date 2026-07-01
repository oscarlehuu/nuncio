import type { Session } from './api';
import { projectDisplayName } from './projects';

export const CHAT_GROUP_KEY = '__chat__';

export const SIDEBAR_COLLAPSED_GROUPS_KEY = 'nuncio-sidebar-collapsed-groups';

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
