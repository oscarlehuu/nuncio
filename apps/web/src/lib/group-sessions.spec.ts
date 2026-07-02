import { describe, it, expect, beforeEach } from 'vitest';
import type { Session } from './api';
import {
  CHAT_GROUP_KEY,
  SIDEBAR_COLLAPSED_GROUPS_KEY,
  groupSessionsByProject,
  loadCollapsedGroups,
  saveCollapsedGroups,
} from './group-sessions';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Build feature X',
    status: 'IDLE',
    provider: 'pi',
    model: 'pi/fable-5',
    modelOptions: null,
    prompt: 'do the thing',
    preview: 'working on it',
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 120_000,
    ...overrides,
  };
}

describe('groupSessionsByProject', () => {
  it('groups sessions by projectPath', () => {
    const sessions = [
      makeSession({ id: 's1', projectPath: '/Users/dev/code/nuncio' }),
      makeSession({ id: 's2', projectPath: '/Users/dev/code/nuncio' }),
      makeSession({ id: 's3', projectPath: '/Users/dev/code/other' }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
    expect(groups[0].projectPath).toBe('/Users/dev/code/nuncio');
    expect(groups[0].name).toBe('nuncio');
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(groups[1].projectPath).toBe('/Users/dev/code/other');
    expect(groups[1].name).toBe('other');
  });

  it('puts sessions with null projectPath into a Chat group', () => {
    const sessions = [makeSession({ id: 's1', projectPath: null })];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(CHAT_GROUP_KEY);
    expect(groups[0].name).toBe('Chat');
    expect(groups[0].projectPath).toBeNull();
  });

  it('preserves the order groups first appear in the input', () => {
    const sessions = [
      makeSession({ id: 's1', projectPath: null }),
      makeSession({ id: 's2', projectPath: '/Users/dev/code/nuncio' }),
      makeSession({ id: 's3', projectPath: '/Users/dev/code/other' }),
      makeSession({ id: 's4', projectPath: null }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups.map((g) => g.key)).toEqual([
      CHAT_GROUP_KEY,
      '/Users/dev/code/nuncio',
      '/Users/dev/code/other',
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1', 's4']);
  });

  it('returns an empty array for no sessions', () => {
    expect(groupSessionsByProject([])).toEqual([]);
  });
});

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('collapsed groups persistence', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('returns an empty set when nothing is stored', () => {
    expect(loadCollapsedGroups(storage)).toEqual(new Set());
  });

  it('round-trips saved keys', () => {
    saveCollapsedGroups(new Set(['/a/b', CHAT_GROUP_KEY]), storage);
    expect(loadCollapsedGroups(storage)).toEqual(new Set(['/a/b', CHAT_GROUP_KEY]));
  });

  it('stores under SIDEBAR_COLLAPSED_GROUPS_KEY', () => {
    saveCollapsedGroups(new Set(['/a/b']), storage);
    expect(storage.getItem(SIDEBAR_COLLAPSED_GROUPS_KEY)).toBe(JSON.stringify(['/a/b']));
  });

  it('returns an empty set when storage contains corrupt JSON', () => {
    storage.setItem(SIDEBAR_COLLAPSED_GROUPS_KEY, '{not valid json');
    expect(loadCollapsedGroups(storage)).toEqual(new Set());
  });

  it('returns an empty set when storage contains a non-array value', () => {
    storage.setItem(SIDEBAR_COLLAPSED_GROUPS_KEY, JSON.stringify({ foo: 'bar' }));
    expect(loadCollapsedGroups(storage)).toEqual(new Set());
  });

  it('ignores non-string entries in the stored array', () => {
    storage.setItem(SIDEBAR_COLLAPSED_GROUPS_KEY, JSON.stringify(['/a', 42, null]));
    expect(loadCollapsedGroups(storage)).toEqual(new Set(['/a']));
  });
});
