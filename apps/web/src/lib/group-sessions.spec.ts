import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Session } from './api';
import {
  CHAT_GROUP_KEY,
  SIDEBAR_COLLAPSED_GROUPS_KEY,
  groupSessionsByProject,
  groupSessionsByRepository,
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

describe('groupSessionsByRepository', () => {
  it('folds a repo main checkout and its linked worktree into ONE group', () => {
    const sessions = [
      makeSession({
        id: 's-main',
        title: 'Main checkout work',
        projectPath: '/Users/dev/code/nuncio',
        repoIdentityId: 'repo-abc',
        repoRoot: '/Users/dev/code/nuncio',
        isWorktree: false,
        branch: 'main',
      }),
      makeSession({
        id: 's-wt',
        title: 'Worktree work',
        projectPath: '/Users/dev/.nuncio/workspaces/xy12',
        worktreePath: '/Users/dev/.nuncio/workspaces/xy12',
        repoIdentityId: 'repo-abc',
        repoRoot: '/Users/dev/code/nuncio',
        isWorktree: true,
        branch: 'nuncio/xy12-fix-login',
      }),
      // A non-git session (null identity) must stay in the fallback group.
      makeSession({ id: 's-chat', title: 'Loose chat', projectPath: null }),
    ];

    const groups = groupSessionsByRepository(sessions);

    const repo = groups.find((g) => g.repoRoot === '/Users/dev/code/nuncio');
    expect(repo).toBeDefined();
    expect(repo!.name).toBe('nuncio');
    // BOTH sessions of the one repo live under the single group.
    expect(repo!.sessions.map((s) => s.id)).toEqual(['s-main', 's-wt']);
    // The linked worktree is listed with its branch and occupying session.
    expect(repo!.worktrees).toHaveLength(1);
    expect(repo!.worktrees[0]).toMatchObject({
      path: '/Users/dev/.nuncio/workspaces/xy12',
      branch: 'nuncio/xy12-fix-login',
    });
    expect(repo!.worktrees[0].sessions.map((s) => s.id)).toEqual(['s-wt']);

    // The non-git session falls back to the Chat group, never a repo group.
    const chat = groups.find((g) => g.key === CHAT_GROUP_KEY);
    expect(chat).toBeDefined();
    expect(chat!.sessions.map((s) => s.id)).toEqual(['s-chat']);
    expect(chat!.repoRoot).toBeNull();
    expect(chat!.worktrees).toEqual([]);
  });

  it('collapses many worktrees of one repo but never lists the main checkout as a worktree', () => {
    const sessions = [
      makeSession({
        id: 'm',
        projectPath: '/repo',
        repoIdentityId: 'id',
        repoRoot: '/repo',
        isWorktree: false,
        branch: 'main',
      }),
      makeSession({
        id: 'w1',
        projectPath: '/wt/1',
        worktreePath: '/wt/1',
        repoIdentityId: 'id',
        repoRoot: '/repo',
        isWorktree: true,
        branch: 'feat/one',
      }),
      makeSession({
        id: 'w2',
        projectPath: '/wt/2',
        worktreePath: '/wt/2',
        repoIdentityId: 'id',
        repoRoot: '/repo',
        isWorktree: true,
        branch: 'feat/two',
      }),
    ];

    const groups = groupSessionsByRepository(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['m', 'w1', 'w2']);
    expect(groups[0].worktrees.map((w) => w.branch)).toEqual(['feat/one', 'feat/two']);
  });

  it('keeps null-identity project sessions in the path fallback (no worktrees)', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/loose/folder', repoIdentityId: null, repoRoot: null }),
    ];
    const groups = groupSessionsByRepository(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].projectPath).toBe('/loose/folder');
    expect(groups[0].name).toBe('folder');
    expect(groups[0].repoRoot).toBeNull();
    expect(groups[0].worktrees).toEqual([]);
  });

  it('preserves first-appearance order across repo and fallback groups', () => {
    const sessions = [
      makeSession({ id: 'chat', projectPath: null }),
      makeSession({
        id: 'repo',
        projectPath: '/repo',
        repoIdentityId: 'id',
        repoRoot: '/repo',
        isWorktree: false,
        branch: 'main',
      }),
      makeSession({ id: 'loose', projectPath: '/loose' }),
    ];
    const groups = groupSessionsByRepository(sessions);
    expect(groups.map((g) => g.key)).toEqual([CHAT_GROUP_KEY, 'repo:id', '/loose']);
  });
});

describe('groupSessionsByRepo import guard', () => {
  // The prior attempt died because the shared helper was only referenced by its
  // own spec. This asserts a NON-spec web file imports it from @nuncio/core.
  it('is imported by the group-sessions source from @nuncio/core', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/group-sessions.ts'), 'utf8');
    expect(source).toMatch(
      /import\s*{[^}]*groupSessionsByRepo[^}]*}\s*from\s*['"]@nuncio\/core['"]/,
    );
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
