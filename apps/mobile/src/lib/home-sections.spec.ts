import { describe, expect, it } from 'vitest';
import type { Session } from '@nuncio/core/api';
import type { CrewRunRowModel } from './crew-run-list';
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

function crew(
  taskId: string,
  updatedAt: number,
  status: CrewRunRowModel['status'] = 'TERMINAL',
): CrewRunRowModel {
  return {
    key: `crew:${taskId}`,
    taskId,
    objective: taskId,
    phase: 'DONE',
    status,
    updatedAt,
  };
}

function sessionItem(value: Session): HomeItem {
  return { kind: 'session', key: `session:${value.id}`, updatedAt: value.updatedAt, session: value };
}

function crewItem(value: CrewRunRowModel): HomeItem {
  return { kind: 'crew', key: value.key, updatedAt: value.updatedAt, row: value };
}

describe('home sections', () => {
  it('identifies running sessions, pending input, and active Crew statuses', () => {
    expect(isHomeItemRunning(sessionItem(session('running', 4, { status: 'RUNNING' })))).toBe(true);
    expect(isHomeItemRunning(sessionItem(session('question', 3, { pendingInput: true })))).toBe(true);
    expect(isHomeItemRunning(sessionItem(session('idle', 2)))).toBe(false);
    expect(isHomeItemRunning(crewItem(crew('blocked', 5, 'BLOCKED_USER')))).toBe(true);
    expect(isHomeItemRunning(crewItem(crew('done', 1)))).toBe(false);
  });

  it('uses the project basename and falls back when there is no project', () => {
    expect(projectLabelForSession(session('one', 1, { projectPath: '/Users/me/nuncio/' }))).toBe('nuncio');
    expect(projectLabelForSession(session('two', 1, { workspace: '/workspaces/demo' }))).toBe('demo');
    expect(projectLabelForSession(session('three', 1))).toBe('No project');
  });

  it('puts running work first and groups the remainder by project and Crew', () => {
    const items = [
      sessionItem(session('old-api', 10, { projectPath: '/repos/api' })),
      crewItem(crew('crew-old', 11)),
      sessionItem(session('running', 30, { status: 'RUNNING', projectPath: '/repos/api' })),
      sessionItem(session('new-web', 20, { projectPath: '/repos/web' })),
      sessionItem(session('question', 25, { pendingInput: true, projectPath: '/repos/web' })),
      sessionItem(session('new-api', 15, { projectPath: '/repos/api' })),
      crewItem(crew('crew-new', 22)),
    ];

    expect(buildHomeSections(items)).toEqual([
      {
        key: 'running',
        title: 'Running now',
        data: [items[2], items[4]],
      },
      {
        key: 'Crew runs',
        title: 'Crew runs',
        data: [items[6], items[1]],
      },
      {
        key: 'web',
        title: 'web',
        data: [items[3]],
      },
      {
        key: 'api',
        title: 'api',
        data: [items[5], items[0]],
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
