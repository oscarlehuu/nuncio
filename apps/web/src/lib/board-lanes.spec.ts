import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import { deriveBoardLane, groupSessionsIntoLanes } from './board-lanes';

function makeSession(over: Partial<Session>): Session {
  return {
    id: 'x',
    title: 'T',
    status: 'IDLE',
    provider: 'pi',
    model: null,
    modelOptions: null,
    prompt: '',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('deriveBoardLane', () => {
  it('routes an actively working run to Running', () => {
    expect(deriveBoardLane(makeSession({ status: 'RUNNING' }), false)).toBe('running');
    expect(deriveBoardLane(makeSession({ status: 'RUNNING', pendingInput: false }), true)).toBe(
      'running',
    );
  });

  it('routes a run blocked on your input to the wants-you split, not Running', () => {
    expect(deriveBoardLane(makeSession({ status: 'RUNNING', pendingInput: true }), true)).toBe(
      'needs-you',
    );
    expect(deriveBoardLane(makeSession({ status: 'RUNNING', pendingInput: true }), false)).toBe(
      'seen',
    );
  });

  it('splits a finished (IDLE) turn on unread', () => {
    expect(deriveBoardLane(makeSession({ status: 'IDLE' }), true)).toBe('needs-you');
    expect(deriveBoardLane(makeSession({ status: 'IDLE' }), false)).toBe('seen');
  });

  it('treats ERROR as a wants-you state', () => {
    expect(deriveBoardLane(makeSession({ status: 'ERROR' }), true)).toBe('needs-you');
    expect(deriveBoardLane(makeSession({ status: 'ERROR' }), false)).toBe('seen');
  });

  it('routes PAUSED and CREATED to their own lanes regardless of unread', () => {
    expect(deriveBoardLane(makeSession({ status: 'PAUSED' }), true)).toBe('paused');
    expect(deriveBoardLane(makeSession({ status: 'PAUSED' }), false)).toBe('paused');
    expect(deriveBoardLane(makeSession({ status: 'CREATED' }), true)).toBe('queued');
    expect(deriveBoardLane(makeSession({ status: 'CREATED' }), false)).toBe('queued');
  });
});

describe('groupSessionsIntoLanes', () => {
  it('emits lanes in fixed order and drops empty ones', () => {
    const sessions = [
      makeSession({ id: 'run', status: 'RUNNING' }),
      makeSession({ id: 'done-unseen', status: 'IDLE' }),
      makeSession({ id: 'queued', status: 'CREATED' }),
    ];
    const unread = new Set(['done-unseen']);
    const groups = groupSessionsIntoLanes(sessions, (s) => unread.has(s.id));

    expect(groups.map((g) => g.lane)).toEqual(['needs-you', 'running', 'queued']);
    expect(groups.map((g) => g.label)).toEqual(['Needs you', 'Running', 'Queued']);
  });

  it('preserves input order within a lane', () => {
    const sessions = [
      makeSession({ id: 'a', status: 'RUNNING' }),
      makeSession({ id: 'b', status: 'RUNNING' }),
    ];
    const [running] = groupSessionsIntoLanes(sessions, () => false);
    expect(running.items.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('separates the same underlying state into Needs you vs Seen by unread', () => {
    const sessions = [
      makeSession({ id: 'unseen', status: 'IDLE' }),
      makeSession({ id: 'seen', status: 'IDLE' }),
    ];
    const groups = groupSessionsIntoLanes(sessions, (s) => s.id === 'unseen');
    const byLane = Object.fromEntries(groups.map((g) => [g.lane, g.items.map((s) => s.id)]));
    expect(byLane['needs-you']).toEqual(['unseen']);
    expect(byLane.seen).toEqual(['seen']);
  });
});
