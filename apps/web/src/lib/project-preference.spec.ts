import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadProjectPreference,
  MAX_RECENT_PROJECTS,
  PROJECT_PREFERENCE_STORAGE_KEY,
  recordBranchSelection,
  recordProjectSelection,
  resolveWorkspacePreference,
} from './project-preference';

describe('project-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(loadProjectPreference()).toEqual({
      recentProjects: [],
    });
    expect(resolveWorkspacePreference()).toEqual({});
  });

  it('records a project and surfaces it as the last workspace', () => {
    recordProjectSelection('/code/nuncio', 'nuncio');
    expect(loadProjectPreference()).toEqual({
      recentProjects: [{ path: '/code/nuncio', name: 'nuncio' }],
      lastProjectPath: '/code/nuncio',
    });
    expect(resolveWorkspacePreference()).toEqual({
      projectPath: '/code/nuncio',
      baseBranch: undefined,
    });
  });

  it('moves an existing recent to the front without duplicates', () => {
    recordProjectSelection('/code/a', 'a');
    recordProjectSelection('/code/b', 'b');
    recordProjectSelection('/code/a', 'a');
    expect(loadProjectPreference().recentProjects.map((r) => r.path)).toEqual([
      '/code/a',
      '/code/b',
    ]);
  });

  it(`caps recents at ${MAX_RECENT_PROJECTS}`, () => {
    for (let i = 0; i < MAX_RECENT_PROJECTS + 2; i++) {
      recordProjectSelection(`/code/p${i}`, `p${i}`);
    }
    const recents = loadProjectPreference().recentProjects;
    expect(recents).toHaveLength(MAX_RECENT_PROJECTS);
    expect(recents[0]?.path).toBe(`/code/p${MAX_RECENT_PROJECTS + 1}`);
  });

  it('remembers the last branch per project', () => {
    recordProjectSelection('/code/nuncio', 'nuncio');
    recordBranchSelection('/code/nuncio', 'develop');
    recordProjectSelection('/code/other', 'other');
    recordBranchSelection('/code/other', 'main');

    expect(resolveWorkspacePreference()).toEqual({
      projectPath: '/code/other',
      baseBranch: 'main',
    });

    recordProjectSelection('/code/nuncio', 'nuncio');
    expect(resolveWorkspacePreference()).toEqual({
      projectPath: '/code/nuncio',
      baseBranch: 'develop',
    });
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(PROJECT_PREFERENCE_STORAGE_KEY, '{not json');
    expect(loadProjectPreference()).toEqual({ recentProjects: [] });
  });
});
