import { describe, expect, it } from 'vitest';
import type { Session } from '@nuncio/core/api';
import {
  buildHomeSections,
  isHomeItemRunning,
  projectLabelForSession,
  type HomeItem,
} from './home-sections';

function session(
  id: string,
  updatedAt: number,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    title: id,
    status: 'IDLE',
    provider: 'pi',
    model: 'gpt-5',
    modelOptions: null,
    mode: null,
    prompt: id,
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: updatedAt - 100,
    updatedAt,
    ...overrides,
  };
}

function sessionItem(value: Session): HomeItem {
  return { kind: 'session', key: `session:${value.id}`, updatedAt: value.updatedAt, session: value };
}

describe('home sections', () => {
  it('identifies running sessions and pending input', () => {
    expect(isHomeItemRunning(sessionItem(session('running', 4, { status: 'RUNNING' })))).toBe(true);
    expect(isHomeItemRunning(sessionItem(session('question', 3, { pendingInput: true })))).toBe(true);
    expect(isHomeItemRunning(sessionItem(session('idle', 2)))).toBe(false);
  });

  it('uses the project basename and falls back when there is no project', () => {
    expect(projectLabelForSession(session('one', 1, { projectPath: '/Users/me/nuncio/' }))).toBe('nuncio');
    expect(projectLabelForSession(session('two', 1, { workspace: '/workspaces/demo' }))).toBe('demo');
    expect(projectLabelForSession(session('three', 1))).toBe('No project');
  });

  it('puts running work first and groups the remainder by project', () => {
    const items = [
      sessionItem(session('old-api', 10, { projectPath: '/repos/api' })),
      sessionItem(session('running', 30, { status: 'RUNNING', projectPath: '/repos/api' })),
      sessionItem(session('new-web', 20, { projectPath: '/repos/web' })),
      sessionItem(session('question', 25, { pendingInput: true, projectPath: '/repos/web' })),
      sessionItem(session('new-api', 15, { projectPath: '/repos/api' })),
    ];

    expect(buildHomeSections(items)).toEqual([
      {
        key: 'running',
        title: 'Running now',
        data: [items[1], items[3]],
      },
      {
        key: 'web',
        title: 'web',
        data: [items[2]],
      },
      {
        key: 'api',
        title: 'api',
        data: [items[4], items[0]],
      },
    ]);
  });

  it('omits the running section when no item is active', () => {
    const items = [
      sessionItem(session('no-project', 5)),
      sessionItem(session('project', 8, { projectPath: '/repos/project' })),
    ];
    expect(buildHomeSections(items)).toEqual([
      { key: 'project', title: 'project', data: [items[1]] },
      { key: 'No project', title: 'No project', data: [items[0]] },
    ]);
  });
});
